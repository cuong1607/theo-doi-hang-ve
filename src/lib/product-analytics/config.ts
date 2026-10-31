// ============================================================
// PRODUCT-ANALYTICS-2: centralized configuration — sync cadence, job
// priorities, retention and SIGNAL THRESHOLDS. No other file may bury
// these constants (spec §38). Pure (env passed in).
// ============================================================

type Env = Record<string, string | undefined>;

function bool(raw: string | undefined, fallback: boolean): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return fallback;
  if (["true", "1", "on", "yes"].includes(v)) return true;
  if (["false", "0", "off", "no"].includes(v)) return false;
  return fallback;
}

export interface ProductAnalyticsSyncConfig {
  /** PRODUCT_SALES_SYNC_ENABLED (default false): scheduler + worker for product_sales_facts_read. */
  salesSyncEnabled: boolean;
  /** PRODUCT_EXTRA_INFO_SYNC_ENABLED (default false): product_extra_info_read (auxiliary snapshots). */
  extraInfoSyncEnabled: boolean;
  timeZone: string;
  /** HOT: orders UPDATED in the last hotLookbackHours, every hotIntervalMinutes. */
  hotIntervalMinutes: number;
  hotLookbackHours: number;
  /** COLD safety net: orders updated in the last coldLookbackDays, at these VN times. */
  coldTimes: readonly string[];
  coldLookbackDays: number;
  /** First sync: orders CREATED in the last backfillDays completed days + today. */
  backfillDays: number;
  backfillRetryMinutes: number;
  extraInfoTimes: readonly string[];
  /** Provider calls per job slice (bounded work: Ads HOT jobs get the worker between slices). */
  callsPerSlice: number;
  extraInfoRetentionDays: number;
}

/** Below every Ads daily / hourly HOT read (Ads HOT = 2–5). */
export const PRODUCT_ANALYTICS_PRIORITY = {
  manual: 6,
  hot: 6,
  cold: 8,
  extraInfo: 9,
  backfill: 10,
} as const;

export const PRODUCT_ANALYTICS_LANES = {
  hot: "pa_hot",
  cold: "pa_cold",
  backfill: "pa_backfill",
  extraInfo: "pa_extra",
} as const;

/** Days of orders the first sync reads; also defines what "covered" means (coverage.ts). */
export const PRODUCT_ANALYTICS_BACKFILL_DAYS = 30;

export function getProductAnalyticsSyncConfig(env: Env = process.env): ProductAnalyticsSyncConfig {
  return {
    salesSyncEnabled: bool(env.PRODUCT_SALES_SYNC_ENABLED, false),
    extraInfoSyncEnabled: bool(env.PRODUCT_EXTRA_INFO_SYNC_ENABLED, false),
    timeZone: "Asia/Ho_Chi_Minh",
    hotIntervalMinutes: 30,
    hotLookbackHours: 48,
    coldTimes: ["04:00", "16:00"],
    coldLookbackDays: 8,
    backfillDays: PRODUCT_ANALYTICS_BACKFILL_DAYS,
    backfillRetryMinutes: 60,
    extraInfoTimes: ["06:00", "18:00"],
    callsPerSlice: 20,
    extraInfoRetentionDays: 90,
  };
}

/**
 * Factual signal thresholds (no cause is inferred — spec §37). A signal fires
 * when |Δ%| ≥ pct AND the absolute movement / base is large enough to matter.
 */
export const PRODUCT_SIGNAL_THRESHOLDS = {
  salesGmvPct: 20,
  salesMinPreviousGmv: 500_000,
  ordersPct: 25,
  ordersMinPrevious: 4,
  unitsPct: 25,
  unitsMinPrevious: 4,
  adsSpendPct: 25,
  adsSpendMinPrevious: 50_000,
  adsRoasPct: 20,
  adsRoasMinSpend: 100_000,
  adsClicksPct: 25,
  adsClicksMinPrevious: 50,
  adsImpressionsPct: 25,
  adsImpressionsMinPrevious: 1_000,
  /** Sales data older than this (last successful read) → DATA_STALE. */
  salesStaleMinutes: 120,
  adsStaleMinutes: 90,
  extraInfoStaleHours: 36,
} as const;

export type ProductSignalThresholds = typeof PRODUCT_SIGNAL_THRESHOLDS;
