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
import { ApiCallMeter, meterOrderProvider, meterPaymentProvider, meterProductProvider } from "./sync-instrumentation.ts";
import { EscrowSyncJobRunner, MAX_REPAIR_ESCROW_ORDERS, ShopeeEscrowSyncService } from "./escrow-sync.ts";
import type { ShopeePaymentProvider } from "./payment-provider.ts";
import { JobRefusedError } from "./sync-errors.ts";

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
  now?: Date;
}

export async function requestShopeeSync(db: SupabaseClient, req: ShopeeSyncRequest): Promise<EnqueueResult> {
  const now = req.now ?? new Date();
  let windowFrom: Date | null = null;
  let windowTo: Date | null = null;
  let scope: Record<string, unknown> | null = null;

  if (req.mode === "backfill" && req.syncType === "order") {
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
    priority: syncJobPriority(req.mode, req.syncType),
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
    throw new JobRefusedError("unsupported_sync_type", `Chưa hỗ trợ đồng bộ loại "${job.sync_type}".`);
  };
}

export interface SchedulerResult {
  recovered: number;
  enqueued: Array<{ shopId: string; syncType: RunnableSyncType; jobId: string }>;
  alreadyQueued: Array<{ shopId: string; syncType: RunnableSyncType; jobId: string }>;
  notDue: number;
  skippedShops: Array<{ shopId: string; reason: string }>;
}

const SCHEDULED_TYPES: readonly RunnableSyncType[] = ["order", "product", "escrow"];
/** Connection states the provider cannot work with → don't queue jobs that would only fail. */
const UNUSABLE_CONNECTIONS = new Set(["disconnected", "expired", "revoked"]);

/**
 * Every run may execute twice (cron is at-least-once): enqueue is
 * idempotent, so a duplicate run finds the jobs already queued.
 * A type is due when neither a success nor a finished attempt happened
 * within its interval (a failing shop is not hammered every minute).
 */
export async function runShopeeSyncScheduler(db: SupabaseClient, options: { config: SyncConfig; providerMode: ProviderMode; now?: Date }): Promise<SchedulerResult> {
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

  const { data: states, error: stateError } = await db
    .from("channel_sync_states")
    .select("shop_id, sync_type, last_success_at, metadata")
    .in("shop_id", eligible)
    .in("sync_type", [...SCHEDULED_TYPES]);
  if (stateError) throw new Error(`Không đọc được sync state: ${stateError.message}`);
  const stateByKey = new Map(
    ((states ?? []) as Array<{ shop_id: string; sync_type: string; last_success_at: string | null; metadata: Record<string, unknown> | null }>).map((s) => [`${s.shop_id}|${s.sync_type}`, s]),
  );

  for (const shopId of eligible) {
    for (const syncType of SCHEDULED_TYPES) {
      const intervalMs =
        (syncType === "order" ? options.config.orderIntervalMinutes : syncType === "escrow" ? options.config.escrowIntervalMinutes : options.config.productIntervalMinutes) * 60_000;
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
        const queued = await requestShopeeSync(db, { shopId, syncType, mode: "incremental", now });
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
export async function runShopeeSchedulerTick(db: SupabaseClient, options: { config: SyncConfig; providerMode: ProviderMode; now?: Date }): Promise<SchedulerTickResult> {
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
    const workDue = await hasDueSyncJobs(db);
    const tick: SchedulerTickResult = { ...result, pruned, pruneError, workDue, durationMs: Date.now() - started };
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

/** True when at least one job is claimable now (used to decide whether to chain another worker run). */
export async function hasDueSyncJobs(db: SupabaseClient, now: Date = new Date()): Promise<boolean> {
  const { count, error } = await db
    .from("channel_sync_jobs")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "retry"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`);
  if (error) throw new Error(`Không đọc được hàng đợi: ${error.message}`);
  return (count ?? 0) > 0;
}
