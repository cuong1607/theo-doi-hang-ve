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
  /** Self-chaining worker hops after a burst when work remains (0 = off). */
  maxChainHops: number;
  /** SHOPEE-5 escrow: orders fetched per slice (each = 1 get_escrow_detail call). */
  escrowBatchSize: number;
  /** Scheduler cadence for escrow jobs. */
  escrowIntervalMinutes: number;
  /** After completion, escrow is re-fetched this many days (it can still change). */
  escrowRefreshWindowDays: number;
  /** …at most once per this many hours. */
  escrowRefreshIntervalHours: number;
  /** A not-ready / failed escrow fetch is retried after this many hours. */
  escrowErrorBackoffHours: number;
  /**
   * Staged rollout (pilot shop first): when set, the scheduler and worker
   * only touch these shop ids (SHOPEE_SYNC_SHOP_IDS, comma-separated).
   * null = every active shop.
   */
  shopAllowlist: string[] | null;
}

type NumericKey = Exclude<keyof SyncConfig, "shopAllowlist">;
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
  orderIntervalMinutes: 10,
  productIntervalMinutes: 60,
  maxChainHops: 10,
  escrowBatchSize: 20,
  escrowIntervalMinutes: 60,
  escrowRefreshWindowDays: 14,
  escrowRefreshIntervalHours: 24,
  escrowErrorBackoffHours: 6,
  shopAllowlist: null,
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
  escrowIntervalMinutes: { key: "SHOPEE_SYNC_ESCROW_INTERVAL_MINUTES", min: 5, max: 7 * 24 * 60 },
  escrowRefreshWindowDays: { key: "SHOPEE_SYNC_ESCROW_REFRESH_WINDOW_DAYS", min: 0, max: 90 },
  escrowRefreshIntervalHours: { key: "SHOPEE_SYNC_ESCROW_REFRESH_INTERVAL_HOURS", min: 1, max: 24 * 30 },
  escrowErrorBackoffHours: { key: "SHOPEE_SYNC_ESCROW_ERROR_BACKOFF_HOURS", min: 1, max: 24 * 7 },
};

export function getSyncConfig(env: Env = process.env): SyncConfig & { warnings: string[] } {
  const warnings: string[] = [];
  const config: SyncConfig = { ...SYNC_CONFIG_DEFAULTS };
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
  return { ...config, warnings };
}

/** Job priorities: LOWER value is picked FIRST. */
export const SYNC_PRIORITY = {
  manual: 5,
  incremental: 10,
  repair: 50,
  backfill: 100,
} as const;

/** Backfill windows (Shopee get_order_list: ≤ 15 days per request). */
export const MAX_BACKFILL_DAYS = 180;
