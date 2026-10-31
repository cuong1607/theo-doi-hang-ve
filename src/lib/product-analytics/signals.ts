// ============================================================
// PRODUCT-ANALYTICS-2: deterministic, FACTUAL signals (spec §36–38).
//
// A signal states what moved ("SALES_DOWN −32 %"), never why. There is
// deliberately no rule combining signals into a cause (no "sales down and
// ads down → cause = ads"): interpretation is the future analyst's job.
// Thresholds live in config.ts only. Pure.
// ============================================================
import { PRODUCT_SIGNAL_THRESHOLDS, type ProductSignalThresholds } from "./config.ts";
import type { ProductDataQuality } from "./data-quality.ts";
import type { PaDelta, ProductSummary } from "./types.ts";

export type ProductSignalType =
  | "SALES_DOWN"
  | "SALES_UP"
  | "ORDERS_DOWN"
  | "ORDERS_UP"
  | "UNITS_DOWN"
  | "UNITS_UP"
  | "ADS_SPEND_UP"
  | "ADS_SPEND_DOWN"
  | "ADS_ROAS_DOWN"
  | "ADS_ROAS_UP"
  | "ADS_CLICKS_DOWN"
  | "ADS_IMPRESSIONS_DOWN"
  | "DATA_STALE";

export interface ProductSignal {
  type: ProductSignalType;
  metric: string;
  current: number | null;
  previous: number | null;
  pct: number | null;
}

function movement(d: PaDelta, pct: number, minPrevious: number): "up" | "down" | null {
  if (d.pct === null || d.previous === null || d.previous < minPrevious) return null;
  if (d.pct <= -pct) return "down";
  if (d.pct >= pct) return "up";
  return null;
}

export function buildProductSignals(summary: ProductSummary, quality: ProductDataQuality, thresholds: ProductSignalThresholds = PRODUCT_SIGNAL_THRESHOLDS): ProductSignal[] {
  const out: ProductSignal[] = [];
  const push = (type: ProductSignalType, metric: string, d: PaDelta) => out.push({ type, metric, current: d.current, previous: d.previous, pct: d.pct });
  const t = thresholds;
  // an incomplete (not backfilled) period would produce SALES_UP +500 % from missing data
  const salesComparable = quality.same_time_comparison.sales_available && quality.sales_coverage.current_complete && quality.sales_coverage.previous_complete;
  const adsComparable = quality.same_time_comparison.ads_available;

  if (salesComparable) {
    const g = movement(summary.sales.gmv, t.salesGmvPct, t.salesMinPreviousGmv);
    if (g) push(g === "down" ? "SALES_DOWN" : "SALES_UP", "sales_gmv", summary.sales.gmv);
    const o = movement(summary.sales.orders, t.ordersPct, t.ordersMinPrevious);
    if (o) push(o === "down" ? "ORDERS_DOWN" : "ORDERS_UP", "orders", summary.sales.orders);
    const u = movement(summary.sales.units, t.unitsPct, t.unitsMinPrevious);
    if (u) push(u === "down" ? "UNITS_DOWN" : "UNITS_UP", "units", summary.sales.units);
  }
  if (adsComparable && summary.ads.single_item_campaigns > 0) {
    const sp = movement(summary.ads.spend, t.adsSpendPct, t.adsSpendMinPrevious);
    if (sp) push(sp === "down" ? "ADS_SPEND_DOWN" : "ADS_SPEND_UP", "ads_spend", summary.ads.spend);
    // ROAS only when both periods spent enough for the ratio to mean something
    if ((summary.ads.spend.current ?? 0) >= t.adsRoasMinSpend && (summary.ads.spend.previous ?? 0) >= t.adsRoasMinSpend) {
      const r = movement(summary.ads.broad_roas, t.adsRoasPct, 0);
      if (r) push(r === "down" ? "ADS_ROAS_DOWN" : "ADS_ROAS_UP", "ads_broad_roas", summary.ads.broad_roas);
    }
    if (movement(summary.ads.clicks, t.adsClicksPct, t.adsClicksMinPrevious) === "down") push("ADS_CLICKS_DOWN", "ads_clicks", summary.ads.clicks);
    if (movement(summary.ads.impressions, t.adsImpressionsPct, t.adsImpressionsMinPrevious) === "down") push("ADS_IMPRESSIONS_DOWN", "ads_impressions", summary.ads.impressions);
  }
  if (quality.sales_freshness.stale || quality.ads_freshness.stale) {
    out.push({ type: "DATA_STALE", metric: quality.sales_freshness.stale ? "sales" : "ads", current: null, previous: null, pct: null });
  }
  return out;
}
