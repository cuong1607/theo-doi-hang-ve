// ============================================================
// PHASE SHOPEE-PERF-1: Shopee side of the background sync.
//
//   requestShopeeSync         what the UI / admin actions call: builds the
//                             job (priority, backfill window, repair scope)
//                             and enqueues it — never syncs inline
//   createShopeeRunnerFactory per job slice: metered providers (+ job token
//                             cache, wired by server.ts) → sync services →
//                             the runner for the job's sync type
//   runShopeeSyncScheduler    recover stale jobs + enqueue due incremental
//                             jobs per active shop (idempotent: running it
//                             twice creates nothing new)
//
// No "server-only" marker: tests inject the DB and fixture providers.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ExecutionBudget } from "../core/retry-policy.ts";
import { MAX_BACKFILL_DAYS, syncJobPriority, type SyncConfig } from "../core/sync-config.ts";
import { markHeartbeatError, markHeartbeatRun, markHeartbeatSuccess, SCHEDULER_HEARTBEAT } from "../core/sync-heartbeat.ts";
import { enqueueSyncJob, recoverStaleSyncJobs, SyncJobError, type EnqueueResult, type RunnableSyncType, type SyncJobRow, type SyncMode } from "../core/sync-jobs.ts";
import type { RunnerFactory, RunnerHandle } from "../core/sync-worker.ts";
import { OrderSyncJobRunner, MAX_REPAIR_ORDER_SNS } from "./order-sync-job.ts";
import type { ShopeeOrderProvider } from "./order-provider.ts";
import { ShopeeOrderSyncService } from "./order-sync.ts";
import { ProductSyncJobRunner, MAX_REPAIR_ITEM_IDS } from "./product-sync-job.ts";
import type { ProviderMode, ShopeeProductProvider } from "./product-provider.ts";
import { ShopeeProductSyncService } from "./product-sync.ts";
import { ApiCallMeter, meterIncomeProvider, meterOrderProvider, meterPaymentProvider, meterProductProvider, meterReturnLogisticsProvider, meterReturnProvider } from "./sync-instrumentation.ts";
import type { ShopeeReturnLogisticsProvider } from "./return-logistics-provider.ts";
import { ReturnLogisticsJobRunner, ShopeeReturnLogisticsSyncService } from "./return-logistics-sync.ts";
import type { ShopeeIncomeProvider } from "./income-provider.ts";
import { IncomeSyncJobRunner, ShopeeIncomeSyncService } from "./income-sync.ts";
import { PayoutSyncJobRunner, ShopeePayoutSyncService } from "./payout-sync.ts";
import type { ShopeeReturnProvider } from "./return-provider.ts";
import { MAX_REPAIR_RETURN_SNS, ReturnSyncJobRunner, ShopeeReturnSyncService } from "./return-sync.ts";
import { EscrowSyncJobRunner, MAX_REPAIR_ESCROW_ORDERS, ShopeeEscrowSyncService } from "./escrow-sync.ts";
import type { ShopeePaymentProvider } from "./payment-provider.ts";
import { JobRefusedError } from "./sync-errors.ts";
import { LEGACY_DISABLED_CODE } from "../core/sync-domains.ts";

export interface ShopeeSyncRequest {
  shopId: string;
  syncType: RunnableSyncType;
  mode: SyncMode;
  createdBy?: string | null;
  /** Order backfill only: how many days back from now (≤ MAX_BACKFILL_DAYS). */
  backfillDays?: number;
  /** Repair only: bounded scope. */
  orderSns?: string[];
  itemIds?: string[];
  /** SHOPEE-6 return repair scope. */
  returnSns?: string[];
  /** SHOPEE-6B manual return-logistics refresh: also re-poll this business date's operations. */
  focusDate?: string;
  /** SHOPEE-9A: first run of this type for the shop (onboarding): catch-up priority, not realtime. */
  initial?: boolean;
  now?: Date;
}

/** SHOPEE-7: controlled release / payout backfill (bounded windows, checkpointed). */
export const MAX_INCOME_BACKFILL_DAYS = 90;

export async function requestShopeeSync(db: SupabaseClient, req: ShopeeSyncRequest): Promise<EnqueueResult> {
  const now = req.now ?? new Date();
  let windowFrom: Date | null = null;
  let windowTo: Date | null = null;
  let scope: Record<string, unknown> | null = null;

  if (req.syncType === "income" || req.syncType === "payout") {
    if (req.mode === "repair") throw new SyncJobError("bad_mode", "Giải ngân / payout không sửa lỗi theo mã — dùng Đồng bộ ngay hoặc backfill theo số ngày.");
    if (req.mode === "backfill") {
      const days = req.backfillDays ?? 30;
      if (!Number.isInteger(days) || days < 1 || days > MAX_INCOME_BACKFILL_DAYS) throw new SyncJobError("bad_range", `Số ngày backfill giải ngân / payout phải từ 1 đến ${MAX_INCOME_BACKFILL_DAYS}.`);
      windowTo = now;
      windowFrom = new Date(now.getTime() - days * 86_400_000);
    }
    return enqueueSyncJob(db, {
      shopId: req.shopId,
      syncType: req.syncType,
      mode: req.mode,
      priority: syncJobPriority(req.mode, req.syncType, { initial: req.initial }),
      windowFrom,
      windowTo,
      metadata: { trigger: req.createdBy ? "user" : "scheduler" },
      createdBy: req.createdBy ?? null,
    });
  }

  if (req.syncType === "return_logistics" || req.syncType === "failed_delivery") {
    if (req.mode === "repair" || req.mode === "backfill") throw new SyncJobError("bad_mode", "Vận chuyển hoàn không có backfill / sửa lỗi theo mã — dùng Làm mới dữ liệu hoàn.");
    const focus = req.focusDate && /^\d{4}-\d{2}-\d{2}$/.test(req.focusDate) ? req.focusDate : null;
    return enqueueSyncJob(db, {
      shopId: req.shopId,
      syncType: req.syncType,
      mode: req.mode,
      priority: syncJobPriority(req.mode, req.syncType, { initial: req.initial }),
      metadata: { trigger: req.createdBy ? "user" : "scheduler", ...(focus ? { scope: { focusDate: focus } } : {}) },
      createdBy: req.createdBy ?? null,
    });
  }

  if (req.mode === "repair" && req.syncType === "return") {
    const clean = [...new Set((req.returnSns ?? []).map((s) => s.trim()).filter(Boolean))];
    if (clean.length === 0) throw new SyncJobError("scope_required", "Job sửa lỗi trả hàng cần danh sách mã trả hàng.");
    if (clean.length > MAX_REPAIR_RETURN_SNS) throw new SyncJobError("scope_too_large", `Tối đa ${MAX_REPAIR_RETURN_SNS} mã cho một job sửa lỗi — hãy chia nhỏ.`);
    return enqueueSyncJob(db, {
      shopId: req.shopId,
      syncType: "return",
      mode: "repair",
      priority: syncJobPriority("repair", "return"),
      metadata: { trigger: req.createdBy ? "user" : "scheduler", scope: { returnSns: clean } },
      createdBy: req.createdBy ?? null,
    });
  }
  if (req.mode === "backfill" && (req.syncType === "order" || req.syncType === "return")) {
    const days = req.backfillDays ?? 30;
    if (!Number.isInteger(days) || days < 1 || days > MAX_BACKFILL_DAYS) throw new SyncJobError("bad_range", `Số ngày backfill phải từ 1 đến ${MAX_BACKFILL_DAYS}.`);
    windowTo = now;
    windowFrom = new Date(now.getTime() - days * 86_400_000);
  }
  if (req.mode === "backfill" && req.syncType === "escrow") {
    throw new SyncJobError("bad_mode", "Tài chính không có backfill — job tự chọn các đơn cần đồng bộ; dùng chế độ sửa lỗi cho đơn cụ thể.");
  }
  if (req.mode === "repair") {
    const bySns = req.syncType === "order" || req.syncType === "escrow";
    const ids = bySns ? req.orderSns : req.itemIds;
    const cap = req.syncType === "order" ? MAX_REPAIR_ORDER_SNS : req.syncType === "escrow" ? MAX_REPAIR_ESCROW_ORDERS : MAX_REPAIR_ITEM_IDS;
    if (ids && ids.length > 0) {
      const clean = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
      if (clean.length > cap) throw new SyncJobError("scope_too_large", `Tối đa ${cap} mã cho một job sửa lỗi — hãy chia nhỏ.`);
      scope = bySns ? { orderSns: clean } : { itemIds: clean };
    } else if (bySns) {
      throw new SyncJobError("scope_required", "Job sửa lỗi đơn hàng / tài chính cần danh sách mã đơn.");
    }
  }

  return enqueueSyncJob(db, {
    shopId: req.shopId,
    syncType: req.syncType,
    mode: req.mode,
    priority: syncJobPriority(req.mode, req.syncType, { initial: req.initial }),
    windowFrom,
    windowTo,
    metadata: { trigger: req.createdBy ? "user" : "scheduler", ...(scope ? { scope } : {}) },
    createdBy: req.createdBy ?? null,
  });
}

/** Raw providers for one slice; the factory meters them. */
export type ShopeeProviderSource = (job: SyncJobRow) => {
  mode: ProviderMode;
  order: ShopeeOrderProvider;
  product: ShopeeProductProvider;
  payment: ShopeePaymentProvider;
  /** SHOPEE-6 (optional so older harnesses keep compiling; a return job without it is refused). */
  return?: ShopeeReturnProvider;
  /** SHOPEE-7 income / payout APIs (optional for the same reason). */
  income?: ShopeeIncomeProvider;
  /** SHOPEE-6B reverse tracking + logistics tracking (optional for the same reason). */
  returnLogistics?: ShopeeReturnLogisticsProvider;
};

export function createShopeeRunnerFactory(deps: { db: SupabaseClient; config: SyncConfig; providers: ShopeeProviderSource }): RunnerFactory {
  return (job: SyncJobRow, budget: ExecutionBudget): RunnerHandle => {
    const meter = new ApiCallMeter(budget);
    const raw = deps.providers(job);
    const productSync = new ShopeeProductSyncService({
      db: deps.db,
      provider: meterProductProvider(raw.product, meter),
      detailConcurrency: deps.config.productDetailConcurrency,
    });
    if (job.sync_type === "product") {
      return { meter, runner: new ProductSyncJobRunner({ db: deps.db, sync: productSync, providerMode: raw.mode }) };
    }
    if (job.sync_type === "order") {
      const orderSync = new ShopeeOrderSyncService({
        db: deps.db,
        provider: meterOrderProvider(raw.order, meter),
        products: productSync,
        detailConcurrency: deps.config.orderDetailConcurrency,
      });
      return { meter, runner: new OrderSyncJobRunner({ db: deps.db, sync: orderSync, providerMode: raw.mode }) };
    }
    if (job.sync_type === "escrow") {
      const escrow = new ShopeeEscrowSyncService({ db: deps.db, provider: meterPaymentProvider(raw.payment, meter) });
      return { meter, runner: new EscrowSyncJobRunner({ db: deps.db, sync: escrow }) };
    }
    if (job.sync_type === "return") {
      if (!raw.return) throw new JobRefusedError("unsupported_sync_type", "Chưa cấu hình provider trả hàng.");
      // a return whose order is missing fetches the order first — through the same metered order sync
      const orderSync = new ShopeeOrderSyncService({
        db: deps.db,
        provider: meterOrderProvider(raw.order, meter),
        products: productSync,
        detailConcurrency: deps.config.orderDetailConcurrency,
      });
      const returns = new ShopeeReturnSyncService({ db: deps.db, provider: meterReturnProvider(raw.return, meter), orders: orderSync });
      return { meter, runner: new ReturnSyncJobRunner({ db: deps.db, sync: returns, providerMode: raw.mode }) };
    }
    if (job.sync_type === "return_logistics" || job.sync_type === "failed_delivery") {
      if (!raw.returnLogistics) throw new JobRefusedError("unsupported_sync_type", "Chưa cấu hình provider vận chuyển hoàn.");
      const sync = new ShopeeReturnLogisticsSyncService({ db: deps.db, provider: meterReturnLogisticsProvider(raw.returnLogistics, meter) });
      const kind = job.sync_type === "return_logistics" ? "customer_return" : "failed_delivery_return";
      return { meter, runner: new ReturnLogisticsJobRunner({ db: deps.db, sync, providerMode: raw.mode, kind }) };
    }
    if (job.sync_type === "income") {
      if (!raw.income) throw new JobRefusedError("unsupported_sync_type", "Chưa cấu hình provider giải ngân.");
      const income = new ShopeeIncomeSyncService({ db: deps.db, provider: meterIncomeProvider(raw.income, meter) });
      return { meter, runner: new IncomeSyncJobRunner({ db: deps.db, sync: income, providerMode: raw.mode }) };
    }
    if (job.sync_type === "payout") {
      if (!raw.income) throw new JobRefusedError("unsupported_sync_type", "Chưa cấu hình provider payout.");
      // a payout order missing locally is fetched through the same metered order sync
      const orderSync = new ShopeeOrderSyncService({
        db: deps.db,
        provider: meterOrderProvider(raw.order, meter),
        products: productSync,
        detailConcurrency: deps.config.orderDetailConcurrency,
      });
      const payouts = new ShopeePayoutSyncService({ db: deps.db, provider: meterIncomeProvider(raw.income, meter), orders: orderSync });
      return { meter, runner: new PayoutSyncJobRunner({ db: deps.db, sync: payouts, providerMode: raw.mode }) };
    }
    throw new JobRefusedError("unsupported_sync_type", `Chưa hỗ trợ đồng bộ loại "${job.sync_type}".`);
  };
}

export interface SchedulerResult {
  recovered: number;
  enqueued: Array<{ shopId: string; syncType: RunnableSyncType; jobId: string }>;
  alreadyQueued: Array<{ shopId: string; syncType: RunnableSyncType; jobId: string }>;
  notDue: number;
  skippedShops: Array<{ shopId: string; reason: string }>;
  /** SHOPEE-9A: SHOPEE_AUTO_SYNC_ENABLED=false — nothing enqueued automatically. */
  autoSyncDisabled?: boolean;
}

const SCHEDULED_TYPES: readonly RunnableSyncType[] = ["order", "product", "escrow", "return", "return_logistics", "failed_delivery", "income", "payout"];

const INTERVAL_KEY: Record<RunnableSyncType, keyof SyncConfig> = {
  order: "orderIntervalMinutes",
  escrow: "escrowIntervalMinutes",
  return: "returnIntervalMinutes",
  return_logistics: "returnLogisticsIntervalMinutes",
  failed_delivery: "failedDeliveryIntervalMinutes",
  income: "incomeIntervalMinutes",
  payout: "payoutIntervalMinutes",
  product: "productIntervalMinutes",
};
const intervalMinutes = (config: SyncConfig, syncType: RunnableSyncType) => config[INTERVAL_KEY[syncType]] as number;
/** Connection states the provider cannot work with → don't queue jobs that would only fail. */
const UNUSABLE_CONNECTIONS = new Set(["disconnected", "expired", "revoked"]);

/**
 * Every run may execute twice (cron is at-least-once): enqueue is
 * idempotent, so a duplicate run finds the jobs already queued.
 * A type is due when neither a success nor a finished attempt happened
 * within its interval (a failing shop is not hammered every minute).
 */
export interface SchedulerOptions {
  config: SyncConfig;
  providerMode: ProviderMode;
  now?: Date;
  /** SHOPEE-ADS-0: job types allowed to be enqueued (default: every scheduled type). */
  syncTypes?: readonly RunnableSyncType[];
  /** SHOPEE-ADS-0: retired job types: their pending / retry jobs are cancelled every tick (history kept). */
  retiredSyncTypes?: readonly string[];
}

export async function runShopeeSyncScheduler(db: SupabaseClient, options: SchedulerOptions): Promise<SchedulerResult> {
  const scheduled = (options.syncTypes ?? SCHEDULED_TYPES).filter((t) => SCHEDULED_TYPES.includes(t));
  const now = options.now ?? new Date();
  const result: SchedulerResult = { recovered: 0, enqueued: [], alreadyQueued: [], notDue: 0, skippedShops: [] };
  result.recovered = (await recoverStaleSyncJobs(db, options.config.staleJobMinutes)).length;

  const { data: shops, error } = await db
    .from("shops")
    .select("id, data_source, shop_connections(connection_status)")
    .eq("channel", "shopee")
    .eq("is_active", true);
  if (error) throw new Error(`Không đọc được danh sách shop: ${error.message}`);

  const eligible: string[] = [];
  for (const shop of (shops ?? []) as Array<{ id: string; data_source: string; shop_connections: Array<{ connection_status: string }> | { connection_status: string } | null }>) {
    if (options.config.shopAllowlist && !options.config.shopAllowlist.includes(shop.id)) {
      result.skippedShops.push({ shopId: shop.id, reason: "not_in_rollout_allowlist" });
      continue;
    }
    if (shop.data_source !== options.providerMode) {
      result.skippedShops.push({ shopId: shop.id, reason: "data_source_mismatch" });
      continue;
    }
    if (shop.data_source === "live") {
      const conns = Array.isArray(shop.shop_connections) ? shop.shop_connections : shop.shop_connections ? [shop.shop_connections] : [];
      const status = conns[0]?.connection_status ?? "disconnected";
      if (UNUSABLE_CONNECTIONS.has(status)) {
        result.skippedShops.push({ shopId: shop.id, reason: `connection_${status}` });
        continue;
      }
    }
    eligible.push(shop.id);
  }
  if (eligible.length === 0) return result;

  // SHOPEE-9A feature flag: stop ENQUEUEING automatically (queued + manual jobs still run).
  if (!options.config.autoSyncEnabled) {
    result.autoSyncDisabled = true;
    return result;
  }

  // SHOPEE-9A per-shop switch + circuit breaker: a disabled / cooling-down shop gets no automatic jobs.
  const { data: controls, error: controlError } = await db.from("channel_shop_sync_controls").select("shop_id, sync_enabled, paused_until").in("shop_id", eligible);
  if (controlError) throw new Error(`Không đọc được trạng thái bật/tắt đồng bộ shop: ${controlError.message}`);
  for (const c of (controls ?? []) as Array<{ shop_id: string; sync_enabled: boolean; paused_until: string | null }>) {
    const reason = !c.sync_enabled ? "sync_disabled" : c.paused_until && new Date(c.paused_until) > now ? "circuit_breaker_cooldown" : null;
    if (!reason) continue;
    result.skippedShops.push({ shopId: c.shop_id, reason });
    eligible.splice(eligible.indexOf(c.shop_id), 1);
  }
  if (eligible.length === 0) return result;

  const { data: states, error: stateError } = await db
    .from("channel_sync_states")
    .select("shop_id, sync_type, last_success_at, metadata")
    .in("shop_id", eligible)
    .in("sync_type", [...scheduled]);
  if (stateError) throw new Error(`Không đọc được sync state: ${stateError.message}`);
  const stateByKey = new Map(
    ((states ?? []) as Array<{ shop_id: string; sync_type: string; last_success_at: string | null; metadata: Record<string, unknown> | null }>).map((s) => [`${s.shop_id}|${s.sync_type}`, s]),
  );

  for (const shopId of eligible) {
    for (const syncType of scheduled) {
      if (options.config.disabledSyncTypes.includes(syncType)) continue;
      const intervalMs = intervalMinutes(options.config, syncType) * 60_000;
      const state = stateByKey.get(`${shopId}|${syncType}`);
      const last = Math.max(
        state?.last_success_at ? new Date(state.last_success_at).getTime() : 0,
        typeof state?.metadata?.lastJobFinishedAt === "string" ? new Date(state.metadata.lastJobFinishedAt).getTime() : 0,
      );
      if (last > 0 && now.getTime() - last < intervalMs) {
        result.notDue++;
        continue;
      }
      try {
        // never succeeded yet (new shop / new type) → onboarding catch-up priority
        const initial = !state?.last_success_at && state?.metadata?.lastJobStatus !== "partial";
        const queued = await requestShopeeSync(db, { shopId, syncType, mode: "incremental", now, initial });
        (queued.created ? result.enqueued : result.alreadyQueued).push({ shopId, syncType, jobId: queued.jobId });
      } catch (err) {
        // One shop's problem never stops the others.
        result.skippedShops.push({ shopId, reason: err instanceof Error ? err.message.slice(0, 200) : "enqueue_failed" });
      }
    }
  }
  return result;
}

export interface SchedulerTickResult extends SchedulerResult {
  /** Finished jobs older than config.jobRetentionDays deleted this run. */
  pruned: number;
  pruneError: string | null;
  /** SHOPEE-ADS-0: pending / retry jobs of retired types cancelled this run. */
  retiredCancelled: number;
  /** SHOPEE-9A: rows removed by the retention policy this run. */
  retention: { snapshots: number; logs: number; error: string | null };
  /** At least one job is claimable now → the caller starts worker burst(s). */
  workDue: boolean;
  durationMs: number;
}

/** Old finished jobs removed per scheduler run (bounded; the backlog clears over a few runs). */
const PRUNE_BATCH = 500;

/**
 * SHOPEE-PERF-2: one cron tick of the scheduler, with health tracking:
 *   heartbeat "run" → recover stale + enqueue due jobs → prune old finished
 *   jobs → heartbeat "success" (or "error", then rethrow).
 * Starting workers is the caller's job (route: after() bursts).
 */
export async function runShopeeSchedulerTick(db: SupabaseClient, options: SchedulerOptions): Promise<SchedulerTickResult> {
  const started = Date.now();
  const now = options.now ?? new Date();
  await markHeartbeatRun(db, SCHEDULER_HEARTBEAT, now);
  try {
    const result = await runShopeeSyncScheduler(db, options);
    // Housekeeping never fails the tick.
    let pruned = 0;
    let pruneError: string | null = null;
    const { data: prunedRows, error: pruneErr } = await db.rpc("prune_channel_sync_jobs", { p_older_than_days: options.config.jobRetentionDays, p_limit: PRUNE_BATCH });
    if (pruneErr) pruneError = pruneErr.message.slice(0, 200);
    else pruned = Number(prunedRows ?? 0);
    // SHOPEE-9A retention: raw snapshot history + operational logs only (canonical data never)
    const retention = await pruneRetention(db, options.config);
    const retiredCancelled = await cancelRetiredSyncJobs(db, options.retiredSyncTypes ?? []);
    const workDue = await hasDueSyncJobs(db, new Date(), options.syncTypes);
    const tick: SchedulerTickResult = { ...result, pruned, pruneError, retention, retiredCancelled, workDue, durationMs: Date.now() - started };
    await markHeartbeatSuccess(db, SCHEDULER_HEARTBEAT, {
      recovered: tick.recovered,
      enqueued: tick.enqueued.length,
      alreadyQueued: tick.alreadyQueued.length,
      notDue: tick.notDue,
      skippedShops: tick.skippedShops.length,
      pruned,
      pruneError,
      workDue,
      durationMs: tick.durationMs,
    });
    return tick;
  } catch (err) {
    await markHeartbeatError(db, SCHEDULER_HEARTBEAT, err instanceof Error ? err.message : String(err)).catch(() => undefined);
    throw err;
  }
}

/** Rows removed per scheduler run by the retention policy (bounded; a backlog clears over several runs). */
const RETENTION_BATCH = 1000;

/**
 * SHOPEE-9A retention. Raw snapshots: only history rows (never the latest
 * row of an entity) older than the retention of their type — financial /
 * return history kept longer. Sync logs: success shorter than failures.
 * Canonical tables (orders, financials, returns, payouts, COGS) are never
 * touched. Never throws: housekeeping must not fail the tick.
 */
export async function pruneRetention(db: SupabaseClient, config: SyncConfig): Promise<{ snapshots: number; logs: number; error: string | null }> {
  const snap = await db.rpc("prune_channel_api_snapshots", { p_default_days: config.snapshotRetentionDays, p_financial_days: config.financialSnapshotRetentionDays, p_limit: RETENTION_BATCH });
  const logs = await db.rpc("prune_channel_sync_logs", { p_success_days: config.logSuccessRetentionDays, p_failure_days: config.logFailureRetentionDays, p_limit: RETENTION_BATCH });
  const error = snap.error?.message ?? logs.error?.message ?? null;
  return { snapshots: Number(snap.data ?? 0), logs: Number(logs.data ?? 0), error: error ? error.slice(0, 200) : null };
}

/** True when at least one job is claimable now (used to decide whether to chain another worker run). */
export async function hasDueSyncJobs(db: SupabaseClient, now: Date = new Date(), syncTypes?: readonly string[]): Promise<boolean> {
  if (syncTypes && syncTypes.length === 0) return false;
  let q = db
    .from("channel_sync_jobs")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "retry"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`);
  if (syncTypes) q = q.in("sync_type", [...syncTypes]);
  const { count, error } = await q;
  if (error) throw new Error(`Không đọc được hàng đợi: ${error.message}`);
  return (count ?? 0) > 0;
}

/**
 * SHOPEE-ADS-0: pending / retry jobs of retired types → cancelled with the
 * reason (rows kept as history). Running ones are never interrupted: the
 * worker no longer claims retired types, and a continued slice comes back as
 * pending → cancelled by the next tick. Idempotent, one UPDATE.
 */
export async function cancelRetiredSyncJobs(db: SupabaseClient, retired: readonly string[]): Promise<number> {
  if (retired.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("channel_sync_jobs")
    .update({ status: "cancelled", finished_at: nowIso, cancelled_at: nowIso, next_attempt_at: null, error_code: LEGACY_DISABLED_CODE, error_message: "Module Shopee cũ đã ngừng (SHOPEE_LEGACY_MODULES_ENABLED=false)." })
    .in("sync_type", [...retired])
    .in("status", ["pending", "retry"])
    .select("id");
  if (error) throw new Error(`Không huỷ được job của module đã ngừng: ${error.message}`);
  return (data ?? []).length;
}
