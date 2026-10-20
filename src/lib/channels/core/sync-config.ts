// ============================================================
// PHASE SHOPEE-PERF-1: every background-sync tuning value in one place.
//
// Read from env with conservative defaults (start small, raise only after
// the job metrics look safe — docs/shopee-sync-operations.md). Pure: takes
// the env object, so it is unit-testable and never throws — an invalid value
// falls back to the default and is reported in `warnings`.
// ============================================================

type Env = Record<string, string | undefined>;

export interface SyncConfig {
  /** Jobs running at the same time across ALL shops (not API calls). */
  globalWorkers: number;
  /** get_order_detail batches in flight inside one job. */
  orderDetailConcurrency: number;
  /** get_model_list calls in flight inside one job. */
  productDetailConcurrency: number;
  /** Incremental order window starts this long before the last success. */
  orderOverlapMinutes: number;
  /** Incremental product window overlap. */
  productOverlapMinutes: number;
  /** An active order seen again is re-fetched when its local copy is older than this. */
  activeOrderTtlMinutes: number;
  /** Provider calls one job slice may make before checkpointing and yielding. */
  maxSliceApiCalls: number;
  /** Wall-clock budget of one job slice. */
  sliceTimeBudgetMs: number;
  /** Wall-clock budget of one worker invocation (several slices). */
  workerTimeBudgetMs: number;
  /** A RUNNING job whose lease is older than this is recovered. */
  staleJobMinutes: number;
  /** Scheduler cadence per sync type. */
  orderIntervalMinutes: number;
  productIntervalMinutes: number;
  /**
   * Self-chaining worker hops after a burst when work remains (0 = off).
   * SHOPEE-PERF-2: off by default — the per-minute cron drains the queue;
   * chaining stays available for setups without a frequent cron.
   */
  maxChainHops: number;
  /** SHOPEE-5 escrow: orders fetched per slice (each = 1 get_escrow_detail call). */
  escrowBatchSize: number;
  /** SHOPEE-PERF-2: get_escrow_detail calls in flight inside one escrow job. */
  escrowConcurrency: number;
  /**
   * SHOPEE-PERF-2: worker bursts one scheduler run starts (≤ globalWorkers;
   * the claim's global cap still decides how many jobs actually run).
   */
  schedulerWorkerTriggers: number;
  /** Expected cron cadence of the scheduler (pg_cron: every minute). */
  schedulerIntervalMinutes: number;
  /** The UI warns when the scheduler has not run for this long. */
  schedulerWarnAfterMinutes: number;
  /** Finished (success / cancelled) jobs older than this are pruned by the scheduler. */
  jobRetentionDays: number;
  /** Scheduler cadence for escrow jobs. */
  escrowIntervalMinutes: number;
  /** After completion, escrow is re-fetched this many days (it can still change). */
  escrowRefreshWindowDays: number;
  /** …at most once per this many hours. */
  escrowRefreshIntervalHours: number;
  /** A not-ready / failed escrow fetch is retried after this many hours. */
  escrowErrorBackoffHours: number;
  /** Open orders: Shopee estimated revenue (escrow, estimate-only) is re-fetched at most this often. */
  escrowEstimateRefreshHours: number;
  /** SHOPEE-6: scheduler cadence for return jobs. */
  returnIntervalMinutes: number;
  /** SHOPEE-6: get_return_detail calls in flight inside one return job. */
  returnDetailConcurrency: number;
  /** SHOPEE-6: an OPEN (non-terminal) return is re-fetched when its copy is older than this. */
  returnOpenTtlHours: number;
  /** SHOPEE-6B: scheduler cadence of Hoàn Trả logistics (reverse tracking) jobs. */
  returnLogisticsIntervalMinutes: number;
  /** SHOPEE-6B: scheduler cadence of Hoàn Hủy (failed-delivery RTS tracking) jobs. */
  failedDeliveryIntervalMinutes: number;
  /** SHOPEE-6B: a not-yet-delivered return operation is re-polled when older than this. */
  returnLogisticsOpenTtlMinutes: number;
  /** SHOPEE-6B: a recently delivered operation is re-polled (provider corrections) when older than this. */
  returnLogisticsDeliveredTtlHours: number;
  /** SHOPEE-7: scheduler cadence of income (release) jobs. */
  incomeIntervalMinutes: number;
  /** SHOPEE-7: incremental release window starts this long before the last success. */
  incomeOverlapMinutes: number;
  /** SHOPEE-7: first income job looks back this many days (still clamped to the orders-sync cutoff). */
  incomeLookbackDays: number;
  /** SHOPEE-7: scheduler cadence of payout jobs. */
  payoutIntervalMinutes: number;
  /** SHOPEE-7: incremental payout / wallet window overlap. */
  payoutOverlapMinutes: number;
  /** SHOPEE-7: first payout job looks back this many days. */
  payoutLookbackDays: number;
  /** SHOPEE-9A: RUNNING jobs of one shop at once (1 = a shop never hits Shopee with several syncs together). */
  maxRunningPerShop: number;
  /** SHOPEE-9A circuit breaker: consecutive failed job slices of a shop before it cools down. */
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMinutes: number;
  /** SHOPEE-9A: after a Shopee rate-limit answer, run one worker burst only for this long. */
  rateLimitCooldownMinutes: number;
  /** SHOPEE-9A retention (history rows only; the latest snapshot of every entity is always kept). */
  snapshotRetentionDays: number;
  financialSnapshotRetentionDays: number;
  logSuccessRetentionDays: number;
  logFailureRetentionDays: number;
  /** SHOPEE-9A alert thresholds. */
  workerWarnAfterMinutes: number;
  oldestPendingWarnMinutes: number;
  /**
   * Staged rollout (pilot shop first): when set, the scheduler and worker
   * only touch these shop ids (SHOPEE_SYNC_SHOP_IDS, comma-separated).
   * null = every active shop.
   */
  shopAllowlist: string[] | null;
  /** SHOPEE-9A feature flag (SHOPEE_AUTO_SYNC_ENABLED=false): the scheduler stops ENQUEUEING; queued / manual jobs still run. */
  autoSyncEnabled: boolean;
  /** SHOPEE-9A (SHOPEE_SYNC_DISABLED_TYPES=payout,return…): types the scheduler never enqueues automatically. */
  disabledSyncTypes: string[];
  /** SHOPEE-9A freshness SLO per sync type (minutes since the last finished job), SHOPEE_SLO_<TYPE>_MINUTES. */
  sloMinutes: Record<string, number>;
}

type NumericKey = Exclude<keyof SyncConfig, "shopAllowlist" | "autoSyncEnabled" | "disabledSyncTypes" | "sloMinutes">;

/**
 * SHOPEE-9A initial SLOs (operational targets, not Shopee guarantees). A
 * type's SLO must exceed its scheduler interval — payout / product run
 * hourly, so their target is 90 min (the spec's 60 would flap every hour).
 */
export const SLO_DEFAULT_MINUTES: Record<string, number> = {
  order: 10,
  escrow: 30,
  return: 15,
  return_logistics: 20,
  failed_delivery: 25,
  income: 30,
  payout: 90,
  product: 90,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SYNC_CONFIG_DEFAULTS: SyncConfig = {
  globalWorkers: 1,
  orderDetailConcurrency: 3,
  productDetailConcurrency: 3,
  orderOverlapMinutes: 10,
  productOverlapMinutes: 5,
  activeOrderTtlMinutes: 30,
  maxSliceApiCalls: 30,
  sliceTimeBudgetMs: 20_000,
  workerTimeBudgetMs: 45_000,
  staleJobMinutes: 3,
  orderIntervalMinutes: 5,
  productIntervalMinutes: 60,
  maxChainHops: 0,
  escrowBatchSize: 20,
  escrowConcurrency: 2,
  schedulerWorkerTriggers: 1,
  schedulerIntervalMinutes: 1,
  schedulerWarnAfterMinutes: 5,
  jobRetentionDays: 30,
  escrowIntervalMinutes: 15,
  escrowRefreshWindowDays: 14,
  escrowRefreshIntervalHours: 24,
  escrowErrorBackoffHours: 6,
  escrowEstimateRefreshHours: 12,
  returnIntervalMinutes: 15,
  returnDetailConcurrency: 2,
  returnOpenTtlHours: 6,
  returnLogisticsIntervalMinutes: 10,
  failedDeliveryIntervalMinutes: 15,
  returnLogisticsOpenTtlMinutes: 20,
  returnLogisticsDeliveredTtlHours: 6,
  incomeIntervalMinutes: 20,
  incomeOverlapMinutes: 24 * 60,
  incomeLookbackDays: 14,
  payoutIntervalMinutes: 60,
  payoutOverlapMinutes: 60,
  payoutLookbackDays: 30,
  maxRunningPerShop: 1,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMinutes: 30,
  rateLimitCooldownMinutes: 10,
  snapshotRetentionDays: 30,
  financialSnapshotRetentionDays: 180,
  logSuccessRetentionDays: 14,
  logFailureRetentionDays: 60,
  workerWarnAfterMinutes: 10,
  oldestPendingWarnMinutes: 20,
  shopAllowlist: null,
  autoSyncEnabled: true,
  disabledSyncTypes: [],
  sloMinutes: { ...SLO_DEFAULT_MINUTES },
};

const ENV_KEYS: Record<NumericKey, { key: string; min: number; max: number }> = {
  globalWorkers: { key: "SHOPEE_SYNC_GLOBAL_WORKERS", min: 1, max: 5 },
  orderDetailConcurrency: { key: "SHOPEE_SYNC_ORDER_CONCURRENCY", min: 1, max: 5 },
  productDetailConcurrency: { key: "SHOPEE_SYNC_PRODUCT_CONCURRENCY", min: 1, max: 5 },
  orderOverlapMinutes: { key: "SHOPEE_SYNC_ORDER_OVERLAP_MINUTES", min: 0, max: 24 * 60 },
  productOverlapMinutes: { key: "SHOPEE_SYNC_PRODUCT_OVERLAP_MINUTES", min: 0, max: 24 * 60 },
  activeOrderTtlMinutes: { key: "SHOPEE_SYNC_ACTIVE_ORDER_TTL_MINUTES", min: 5, max: 24 * 60 },
  maxSliceApiCalls: { key: "SHOPEE_SYNC_MAX_BATCH_API_CALLS", min: 3, max: 200 },
  sliceTimeBudgetMs: { key: "SHOPEE_SYNC_SLICE_BUDGET_MS", min: 2_000, max: 240_000 },
  workerTimeBudgetMs: { key: "SHOPEE_SYNC_WORKER_BUDGET_MS", min: 2_000, max: 280_000 },
  staleJobMinutes: { key: "SHOPEE_SYNC_STALE_JOB_MINUTES", min: 2, max: 120 },
  orderIntervalMinutes: { key: "SHOPEE_SYNC_ORDER_INTERVAL_MINUTES", min: 1, max: 24 * 60 },
  productIntervalMinutes: { key: "SHOPEE_SYNC_PRODUCT_INTERVAL_MINUTES", min: 5, max: 7 * 24 * 60 },
  maxChainHops: { key: "SHOPEE_SYNC_MAX_CHAIN_HOPS", min: 0, max: 50 },
  escrowBatchSize: { key: "SHOPEE_SYNC_ESCROW_BATCH_SIZE", min: 1, max: 100 },
  escrowConcurrency: { key: "SHOPEE_SYNC_ESCROW_CONCURRENCY", min: 1, max: 5 },
  schedulerWorkerTriggers: { key: "SHOPEE_SYNC_SCHEDULER_WORKER_TRIGGERS", min: 1, max: 5 },
  schedulerIntervalMinutes: { key: "SHOPEE_SYNC_SCHEDULER_INTERVAL_MINUTES", min: 1, max: 60 },
  schedulerWarnAfterMinutes: { key: "SHOPEE_SYNC_SCHEDULER_WARN_AFTER_MINUTES", min: 2, max: 24 * 60 },
  jobRetentionDays: { key: "SHOPEE_SYNC_JOB_RETENTION_DAYS", min: 1, max: 365 },
  escrowIntervalMinutes: { key: "SHOPEE_SYNC_ESCROW_INTERVAL_MINUTES", min: 5, max: 7 * 24 * 60 },
  escrowRefreshWindowDays: { key: "SHOPEE_SYNC_ESCROW_REFRESH_WINDOW_DAYS", min: 0, max: 90 },
  escrowRefreshIntervalHours: { key: "SHOPEE_SYNC_ESCROW_REFRESH_INTERVAL_HOURS", min: 1, max: 24 * 30 },
  escrowErrorBackoffHours: { key: "SHOPEE_SYNC_ESCROW_ERROR_BACKOFF_HOURS", min: 1, max: 24 * 7 },
  escrowEstimateRefreshHours: { key: "SHOPEE_SYNC_ESCROW_ESTIMATE_REFRESH_HOURS", min: 1, max: 24 * 7 },
  returnIntervalMinutes: { key: "SHOPEE_SYNC_RETURN_INTERVAL_MINUTES", min: 5, max: 24 * 60 },
  returnDetailConcurrency: { key: "SHOPEE_SYNC_RETURN_CONCURRENCY", min: 1, max: 5 },
  returnOpenTtlHours: { key: "SHOPEE_SYNC_RETURN_OPEN_TTL_HOURS", min: 1, max: 24 * 7 },
  returnLogisticsIntervalMinutes: { key: "SHOPEE_SYNC_RETURN_LOGISTICS_INTERVAL_MINUTES", min: 5, max: 24 * 60 },
  failedDeliveryIntervalMinutes: { key: "SHOPEE_SYNC_FAILED_DELIVERY_INTERVAL_MINUTES", min: 5, max: 24 * 60 },
  returnLogisticsOpenTtlMinutes: { key: "SHOPEE_SYNC_RETURN_LOGISTICS_OPEN_TTL_MINUTES", min: 5, max: 24 * 60 },
  returnLogisticsDeliveredTtlHours: { key: "SHOPEE_SYNC_RETURN_LOGISTICS_DELIVERED_TTL_HOURS", min: 1, max: 72 },
  incomeIntervalMinutes: { key: "SHOPEE_SYNC_INCOME_INTERVAL_MINUTES", min: 5, max: 24 * 60 },
  incomeOverlapMinutes: { key: "SHOPEE_SYNC_INCOME_OVERLAP_MINUTES", min: 0, max: 7 * 24 * 60 },
  incomeLookbackDays: { key: "SHOPEE_SYNC_INCOME_LOOKBACK_DAYS", min: 1, max: 90 },
  payoutIntervalMinutes: { key: "SHOPEE_SYNC_PAYOUT_INTERVAL_MINUTES", min: 10, max: 24 * 60 },
  payoutOverlapMinutes: { key: "SHOPEE_SYNC_PAYOUT_OVERLAP_MINUTES", min: 0, max: 7 * 24 * 60 },
  payoutLookbackDays: { key: "SHOPEE_SYNC_PAYOUT_LOOKBACK_DAYS", min: 1, max: 180 },
  maxRunningPerShop: { key: "SHOPEE_SYNC_MAX_RUNNING_PER_SHOP", min: 1, max: 5 },
  circuitBreakerThreshold: { key: "SHOPEE_SYNC_CIRCUIT_BREAKER_FAILURES", min: 2, max: 100 },
  circuitBreakerCooldownMinutes: { key: "SHOPEE_SYNC_CIRCUIT_BREAKER_COOLDOWN_MINUTES", min: 1, max: 24 * 60 },
  rateLimitCooldownMinutes: { key: "SHOPEE_SYNC_RATE_LIMIT_COOLDOWN_MINUTES", min: 1, max: 24 * 60 },
  snapshotRetentionDays: { key: "SHOPEE_SNAPSHOT_RETENTION_DAYS", min: 3, max: 3650 },
  financialSnapshotRetentionDays: { key: "SHOPEE_FINANCIAL_SNAPSHOT_RETENTION_DAYS", min: 30, max: 3650 },
  logSuccessRetentionDays: { key: "SHOPEE_SYNC_LOG_SUCCESS_RETENTION_DAYS", min: 1, max: 3650 },
  logFailureRetentionDays: { key: "SHOPEE_SYNC_LOG_FAILURE_RETENTION_DAYS", min: 7, max: 3650 },
  workerWarnAfterMinutes: { key: "SHOPEE_SYNC_WORKER_WARN_AFTER_MINUTES", min: 2, max: 24 * 60 },
  oldestPendingWarnMinutes: { key: "SHOPEE_SYNC_OLDEST_PENDING_WARN_MINUTES", min: 2, max: 24 * 60 },
};

const SLO_TYPES = Object.keys(SLO_DEFAULT_MINUTES);

export function getSyncConfig(env: Env = process.env): SyncConfig & { warnings: string[] } {
  const warnings: string[] = [];
  const config: SyncConfig = { ...SYNC_CONFIG_DEFAULTS, sloMinutes: { ...SLO_DEFAULT_MINUTES } };
  const auto = env.SHOPEE_AUTO_SYNC_ENABLED?.trim().toLowerCase();
  if (auto) {
    if (["false", "0", "off", "no"].includes(auto)) config.autoSyncEnabled = false;
    else if (!["true", "1", "on", "yes"].includes(auto)) warnings.push(`SHOPEE_AUTO_SYNC_ENABLED="${auto}" không hợp lệ (true/false) — giữ bật.`);
  }
  const disabled = env.SHOPEE_SYNC_DISABLED_TYPES?.trim();
  if (disabled) {
    const types = disabled.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = types.filter((t) => !SLO_TYPES.includes(t));
    if (bad.length > 0) warnings.push(`SHOPEE_SYNC_DISABLED_TYPES có loại không hợp lệ (${bad.join(", ")}) — đã bỏ qua.`);
    config.disabledSyncTypes = types.filter((t) => SLO_TYPES.includes(t));
  }
  for (const type of SLO_TYPES) {
    const key = `SHOPEE_SLO_${type.toUpperCase()}_MINUTES`;
    const raw = env[key]?.trim();
    if (!raw) continue;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 1 || v > 7 * 24 * 60) warnings.push(`${key}="${raw}" không hợp lệ — dùng mặc định ${SLO_DEFAULT_MINUTES[type]}.`);
    else config.sloMinutes[type] = v;
  }
  const allow = env.SHOPEE_SYNC_SHOP_IDS?.trim();
  if (allow) {
    const ids = allow.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((id) => !UUID.test(id));
    if (bad.length > 0) warnings.push(`SHOPEE_SYNC_SHOP_IDS có id không hợp lệ (${bad.join(", ")}) — đã bỏ qua các id này.`);
    const good = ids.filter((id) => UUID.test(id));
    config.shopAllowlist = good.length > 0 ? good : null;
  }
  for (const name of Object.keys(ENV_KEYS) as NumericKey[]) {
    const { key, min, max } = ENV_KEYS[name];
    const raw = env[key]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      warnings.push(`${key}="${raw}" không hợp lệ (số nguyên ${min}–${max}) — dùng mặc định ${SYNC_CONFIG_DEFAULTS[name]}.`);
      continue;
    }
    config[name] = value;
  }
  if (config.sliceTimeBudgetMs > config.workerTimeBudgetMs) {
    warnings.push("SHOPEE_SYNC_SLICE_BUDGET_MS lớn hơn SHOPEE_SYNC_WORKER_BUDGET_MS — giới hạn lại bằng ngân sách worker.");
    config.sliceTimeBudgetMs = config.workerTimeBudgetMs;
  }
  if (config.schedulerWorkerTriggers > config.globalWorkers) {
    warnings.push("SHOPEE_SYNC_SCHEDULER_WORKER_TRIGGERS lớn hơn SHOPEE_SYNC_GLOBAL_WORKERS — giới hạn lại bằng số job chạy đồng thời.");
    config.schedulerWorkerTriggers = config.globalWorkers;
  }
  if (config.schedulerWarnAfterMinutes < config.schedulerIntervalMinutes * 2) {
    warnings.push("SHOPEE_SYNC_SCHEDULER_WARN_AFTER_MINUTES nhỏ hơn 2 chu kỳ scheduler — nâng lên 3 chu kỳ.");
    config.schedulerWarnAfterMinutes = config.schedulerIntervalMinutes * 3;
  }
  return { ...config, warnings };
}

/**
 * Job priorities: LOWER value is picked FIRST. Live data wins over
 * financial refresh, which wins over the catalog; a user's click (manual)
 * or a repair jumps the queue; a historical backfill never blocks anything.
 */
export const SYNC_PRIORITY = {
  manual: { order: 1, return: 2, return_logistics: 2, failed_delivery: 2, escrow: 2, income: 3, payout: 3, product: 3 },
  repair: 5,
  // SHOPEE-6: returns after orders (a return needs its order), before financials
  // SHOPEE-6B: return logistics right after returns (daily delivered counts stay fresh)
  // SHOPEE-7: release + payout after financials, before catalog maintenance
  incremental: { order: 10, return: 15, return_logistics: 16, failed_delivery: 17, escrow: 20, income: 22, payout: 25, product: 30 },
  // SHOPEE-9A: a shop's FIRST run of a type (no success yet — onboarding) is a
  // catch-up, not realtime: below every healthy shop's live sync, above
  // backfill; products first so orders find their listings.
  initial: { product: 45, order: 50, return: 55, return_logistics: 56, failed_delivery: 57, escrow: 60, income: 62, payout: 65 },
  backfill: 100,
} as const;

/** Priority of a job (unknown sync types queue after the known ones of the same mode). */
export function syncJobPriority(mode: "incremental" | "manual" | "repair" | "backfill", syncType: string, options: { initial?: boolean } = {}): number {
  if (mode === "repair") return SYNC_PRIORITY.repair;
  if (mode === "backfill") return SYNC_PRIORITY.backfill;
  if (mode === "incremental" && options.initial) return (SYNC_PRIORITY.initial as Record<string, number>)[syncType] ?? 70;
  const table = SYNC_PRIORITY[mode] as Record<string, number>;
  return table[syncType] ?? (mode === "manual" ? 4 : 40);
}

/** Backfill windows (Shopee get_order_list: ≤ 15 days per request). */
export const MAX_BACKFILL_DAYS = 180;
