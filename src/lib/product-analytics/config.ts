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

/** Freshness thresholds (data quality + DATA_STALE). Movement thresholds: PRODUCT_INTELLIGENCE_CONFIG. */
export const PRODUCT_SIGNAL_THRESHOLDS = {
  /** Sales data older than this (last successful read) → DATA_STALE. */
  salesStaleMinutes: 120,
  adsStaleMinutes: 90,
  extraInfoStaleHours: 36,
} as const;

export type ProductSignalThresholds = typeof PRODUCT_SIGNAL_THRESHOLDS;

/**
 * PRODUCT-ANALYTICS-3 signal engine (SQL: pa_intelligence_eval). The SQL holds
 * the rules, THIS object holds every number — it is passed to the RPCs as p_cfg.
 *
 *   signal      |Δ%| ≥ minor (volume metrics: volumeMinor) and the previous value ≥ its minimum base
 *   severity    favourable / neutral → INFO; unfavourable → WARNING only when |Δ%| ≥ major AND the
 *               product is large (scaleLarge*), else NOTICE — a 100 % ROAS move on tiny spend stays small
 *   confidence  HIGH, −1 level for a small sample (highConf*), stale data, a partial day
 *   priority    unfavourable-signal points × (1 + scale points / 10) × confidence (1 / 0.75 / 0.5);
 *               scale points = 10 · log10(1 + (sales + Ads spend) / priorityScaleUnit)
 */
export const PRODUCT_INTELLIGENCE_CONFIG = {
  changePctMinor: 15,
  changePctMajor: 30,
  /** spend / impressions / clicks move more from day to day than sales or ratios */
  volumePctMinor: 20,
  volumePctMajor: 50,
  minSalesGmv: 500_000,
  minOrders: 5,
  minUnits: 5,
  /** ROAS / CPC need at least this spend in BOTH periods; spend signal needs it in the previous one */
  minAdsSpend: 100_000,
  minClicks: 50,
  minImpressions: 1_000,
  /** CVR needs at least this many clicks in both periods */
  minRatioClicks: 100,
  scaleLargeGmv: 5_000_000,
  scaleLargeSpend: 500_000,
  highConfOrders: 30,
  highConfClicks: 300,
  priorityScaleUnit: 1_000_000,
  priorityWarningPoints: 20,
  priorityNoticePoints: 8,
  prioritySignalCap: 60,
  priorityHigh: 80,
  priorityMedium: 40,
  /** WATCH / WEAK products at or above this score are "Sản phẩm cần chú ý" */
  attentionMinScore: 20,
} as const;

export type ProductIntelligenceConfig = typeof PRODUCT_INTELLIGENCE_CONFIG;

/** p_cfg for the intelligence RPCs (snake_case keys; the SQL refuses a config with a missing key). */
export function intelligenceConfigJson(c: ProductIntelligenceConfig = PRODUCT_INTELLIGENCE_CONFIG, t: ProductSignalThresholds = PRODUCT_SIGNAL_THRESHOLDS): Record<string, number> {
  return {
    backfill_days: PRODUCT_ANALYTICS_BACKFILL_DAYS,
    sales_stale_minutes: t.salesStaleMinutes,
    ads_stale_minutes: t.adsStaleMinutes,
    change_pct_minor: c.changePctMinor,
    change_pct_major: c.changePctMajor,
    volume_pct_minor: c.volumePctMinor,
    volume_pct_major: c.volumePctMajor,
    min_sales_gmv: c.minSalesGmv,
    min_orders: c.minOrders,
    min_units: c.minUnits,
    min_ads_spend: c.minAdsSpend,
    min_clicks: c.minClicks,
    min_impressions: c.minImpressions,
    min_ratio_clicks: c.minRatioClicks,
    scale_large_gmv: c.scaleLargeGmv,
    scale_large_spend: c.scaleLargeSpend,
    high_conf_orders: c.highConfOrders,
    high_conf_clicks: c.highConfClicks,
    priority_scale_unit: c.priorityScaleUnit,
    priority_warning_points: c.priorityWarningPoints,
    priority_notice_points: c.priorityNoticePoints,
    priority_signal_cap: c.prioritySignalCap,
    priority_high: c.priorityHigh,
    priority_medium: c.priorityMedium,
    attention_min_score: c.attentionMinScore,
  };
}
