// ============================================================
// SHOPEE-ADS-UI-1: UI-facing view models for the Ads dashboard.
//
// These are what the page renders — NOT Shopee payloads. The provider DTOs
// (provider.ts) stay separate; SHOPEE-ADS-1 adds a mapper
// provider DTO → canonical rows → these view models. Today the only source
// is the fixture (fixtures.ts), shaped exactly like the future query result.
//
// Money: plain numbers in VND (whole đồng) for UI geometry / formatting
// only. The real source will read exact NUMERIC from the DB and convert at
// this boundary (carry-forward #5 stays true for storage).
// ============================================================

import type { PeriodPreset } from "../../../analytics/periods.ts";

/**
 * UI status. Real data maps the raw Shopee status (ongoing → active, paused,
 * ended, closed; anything else → unknown, raw value kept). "warning" is fixture-only.
 */
export type AdsCampaignStatus = "active" | "paused" | "ended" | "closed" | "warning" | "unknown";
/**
 * UI grouping. Real data: bidding auto → "auto"; manual bidding → placement
 * (search / discovery / all → "all_placements"); unknown → "other". "shop" is fixture-only.
 */
export type AdsCampaignType = "search" | "discovery" | "shop" | "auto" | "all_placements" | "other";

/**
 * Raw additive totals for one slice (period, campaign, day …).
 * revenue / orders = BROAD attribution (Shopee broad_gmv / broad_order);
 * directRevenue / directOrders = DIRECT attribution. Never "shop revenue".
 */
export interface AdsTotals {
  spend: number;
  revenue: number;
  orders: number;
  directRevenue: number;
  directOrders: number;
  clicks: number;
  impressions: number;
}

/** Totals + ratios derived from the totals (ratio-of-sums; null when the denominator is 0 → "—"). */
export interface AdsMetricValues extends AdsTotals {
  /** Broad ROAS = revenue / spend */
  roas: number | null;
  /** Broad ACOS = spend / revenue */
  acos: number | null;
  ctr: number | null;
  /** Cost per CLICK = spend / clicks (never Shopee's campaign "cpc" field). */
  cpc: number | null;
  /** Broad CVR = orders / clicks */
  conversionRate: number | null;
  directRoas: number | null;
  directAcos: number | null;
  directConversionRate: number | null;
}

export interface AdsOverviewMetrics {
  current: AdsMetricValues;
  previous: AdsMetricValues;
  /** Daily (or hourly) series per metric for card sparklines. */
  spark: Record<keyof AdsMetricValues, number[]>;
  /** Σ daily budget × days of the period, for "x% ngân sách đã dùng" (0 = unknown → "—"). */
  budget: number;
  /**
   * Real data only: shop-level total minus Σ product campaigns for the same
   * range ("Ngoài chiến dịch sản phẩm" — source not identified by Shopee).
   */
  outsideProductCampaigns?: AdsMetricValues | null;
}

export interface AdsTrendPoint {
  /** ISO day (YYYY-MM-DD) or hour key (YYYY-MM-DDTHH). */
  key: string;
  /** Short axis label: "27/10" or "14h". */
  label: string;
  spend: number;
  revenue: number;
  orders: number;
  directRevenue: number;
  directOrders: number;
  clicks: number;
  roas: number | null;
}

export interface AdsAdvertisedProduct {
  name: string;
  /** Provider item id (real data). */
  itemId?: string;
  /**
   * ADS-3A.2 verified product metadata (real data, shopee_ads_products) —
   * absent / null = not known. Never filled from fixtures in real mode.
   */
  imageUrl?: string | null;
  /** ADS-3A.2.1 display-only small variant of imageUrl (null = load imageUrl directly). Never stored. */
  thumbnailUrl?: string | null;
  sku?: string | null;
  /** Raw Shopee item_status (NORMAL / UNLIST / SELLER_DELETE …). */
  providerStatus?: string | null;
  /** enriched = metadata read; not_returned = last read did not return the item; pending = never read yet. */
  enrichment?: "enriched" | "not_returned" | "pending";
  /** null = not available per product (Shopee reports metrics per campaign only). */
  spend: number | null;
  revenue: number | null;
  orders: number | null;
}

export interface AdsCampaignRow {
  id: string;
  name: string;
  shopId: string;
  shopName: string;
  type: AdsCampaignType;
  status: AdsCampaignStatus;
  /** Raw provider values (real data) — kept for display / audit, never mapped away. */
  provider?: { status: string; adType: string | null; biddingMethod: string | null; placement: string | null; campaignId: string };
  /** Shopee roas_target (auto bidding); null / 0 → "—" (meaning of 0 unknown). */
  roasTarget?: number | null;
  /** Daily budget (VND, "Ngân sách/ngày"); null = not set / unknown → "—". */
  dailyBudget: number | null;
  /** Budget available over the period (dailyBudget × active days). */
  periodBudget: number | null;
  metrics: AdsMetricValues;
  /** Spend / revenue per bucket, for the expanded row mini trend. */
  trend: Array<{ label: string; spend: number; revenue: number }>;
  topProducts: AdsAdvertisedProduct[];
}

export type AdsInsightTone = "success" | "warning" | "danger" | "info";

export interface AdsInsight {
  id: string;
  tone: AdsInsightTone;
  title: string;
  description: string;
  /** Optional campaign the insight is about (links to the table search). */
  campaignName?: string;
}

/** stale = real data older than its freshness target (SHOPEE-ADS-2: shop > 25 min, campaigns > 35 min, metadata > 8 h). */
export type AdsSyncState = "fresh" | "stale" | "never" | "refreshing" | "error";

export interface AdsSyncStatus {
  state: AdsSyncState;
  /** Last successful Ads data update (ISO), null = never. Real data: the OLDEST of the three reads. */
  lastSyncedAt: string | null;
  source: "fixture" | "shopee";
  /** Real data: freshness per read job (campaign metadata / campaign facts / shop totals). */
  details?: Array<{ key: string; label: string; lastSuccessAt: string | null; lastErrorAt: string | null; errorMessage: string | null; targetMinutes?: number; staleAfterMinutes?: number; stale?: boolean }>;
  /** Real data: changes whenever a background read lands (DB-only polling compares it). */
  stamp?: string | null;
  /** Real data: background sync (scheduler) state for the selected shop(s). */
  autoSync?: { enabled: boolean; enabledShops: number; shops: number };
  /** The selected range includes today (shop-local) — today's data is partial. */
  todayPartial?: boolean;
  /** Latest report date with shop-level facts (YYYY-MM-DD). */
  reportThrough?: string | null;
}

export interface AdsShopOption {
  id: string;
  name: string;
}

export interface AdsFilters {
  preset: PeriodPreset;
  from: string;
  to: string;
  shop: string; // "all" | shop id
  status: AdsCampaignStatus | "all";
  type: AdsCampaignType | "all";
}

/** ADS-3A.1 hourly Σ vs daily facts of the same shop × date (docs/shopee-ads-hourly.md). */
export type AdsHourlyReconciliationStatus = "IN_PROGRESS" | "MATCH" | "ROUNDING_DIFFERENCE" | "MISMATCH" | "INSUFFICIENT_DATA";

export interface AdsIntradayHour {
  hour: number;
  /** "14h" */
  label: string;
  /** "current" = the hour that is still running (partial, "Đang diễn ra"). */
  state: "complete" | "current";
  /** Summed primitives + ratio-of-sums. null = Shopee returned no row for this hour (a gap, never drawn as 0). */
  metrics: AdsMetricValues | null;
  /** Shops with a row for this hour (All shops: fewer than `shops.enabled` = partial hour). */
  shops: number;
  cumSpend: number;
  cumRevenue: number;
}

export interface AdsIntradayData {
  /** Shop-local report date (YYYY-MM-DD). */
  date: string;
  /** Current shop-local hour (0–23); hours after it are not shown. */
  currentHour: number;
  /** disabled = no selected shop has hourly enabled and nothing is stored; empty = enabled, no rows yet; unavailable = could not be read. */
  status: "ok" | "disabled" | "empty" | "unavailable";
  /** 00h → current hour. */
  hours: AdsIntradayHour[];
  /** Σ hours through the current hour (ratio-of-sums) — intraday breakdown, NOT the overview KPI (that stays the daily fact). */
  totals: AdsMetricValues;
  /** Today 00h → last COMPLETED hour vs yesterday over the same hours (never a partial today vs a full yesterday). */
  sameHourYesterday: { throughHour: number; today: AdsMetricValues; yesterday: AdsMetricValues } | null;
  /** Observational only (no action is ever suggested). Completed hours, enough data. */
  peaks: Array<{ key: "spend" | "revenue" | "roas"; label: string; hour: number; value: number }>;
  freshness: { lastSyncedAt: string | null; targetMinutes: number; staleAfterMinutes: number; stale: boolean };
  shops: { selected: number; enabled: number; withData: number };
  /** Yesterday (completed day): worst status across the selected shops. */
  reconciliation: { date: string; status: AdsHourlyReconciliationStatus; reasons: string[] } | null;
}

export interface AdsDashboardData {
  filters: AdsFilters;
  previousRange: { from: string; to: string };
  granularity: "hour" | "day" | "week";
  shops: AdsShopOption[];
  overview: AdsOverviewMetrics;
  trend: AdsTrendPoint[];
  /** Every campaign matching the filters (the table pages / sorts these). */
  campaigns: AdsCampaignRow[];
  /** Campaign count per status under the OTHER filters (status chips). */
  statusCounts: Record<AdsCampaignStatus | "all", number>;
  insights: AdsInsight[];
  sync: AdsSyncStatus;
  /** Real data only (ADS-3A.1): "Hôm nay theo giờ". Undefined in fixture mode. */
  intraday?: AdsIntradayData;
  generatedAt: string;
}
