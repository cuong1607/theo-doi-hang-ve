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

export type AdsCampaignStatus = "active" | "paused" | "ended" | "warning";
/** UI grouping only — real Shopee campaign/ad types are mapped in SHOPEE-ADS-1. */
export type AdsCampaignType = "search" | "discovery" | "shop" | "auto";

/** Raw additive totals for one slice (period, campaign, day …). */
export interface AdsTotals {
  spend: number;
  revenue: number;
  orders: number;
  clicks: number;
  impressions: number;
}

/** Totals + derived ratios (null when the denominator is 0 → shown "—"). */
export interface AdsMetricValues extends AdsTotals {
  roas: number | null;
  acos: number | null;
  ctr: number | null;
  cpc: number | null;
  conversionRate: number | null;
}

export interface AdsOverviewMetrics {
  current: AdsMetricValues;
  previous: AdsMetricValues;
  /** Daily (or hourly) series per metric for card sparklines. */
  spark: Record<keyof AdsMetricValues, number[]>;
  /** Σ daily budget × days of the period, for "x% ngân sách đã dùng". */
  budget: number;
}

export interface AdsTrendPoint {
  /** ISO day (YYYY-MM-DD) or hour key (YYYY-MM-DDTHH). */
  key: string;
  /** Short axis label: "27/10" or "14h". */
  label: string;
  spend: number;
  revenue: number;
  orders: number;
  clicks: number;
  roas: number | null;
}

export interface AdsAdvertisedProduct {
  name: string;
  spend: number;
  revenue: number;
  orders: number;
}

export interface AdsCampaignRow {
  id: string;
  name: string;
  shopId: string;
  shopName: string;
  type: AdsCampaignType;
  status: AdsCampaignStatus;
  /** Daily budget (VND); null = no cap. */
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

export type AdsSyncState = "fresh" | "never" | "refreshing" | "error";

export interface AdsSyncStatus {
  state: AdsSyncState;
  /** Last successful Ads data update (ISO), null = never. */
  lastSyncedAt: string | null;
  /** "fixture" until SHOPEE-ADS-1 ships a real source. */
  source: "fixture" | "shopee";
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
  generatedAt: string;
}
