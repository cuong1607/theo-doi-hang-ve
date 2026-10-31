// ============================================================
// PRODUCT-ANALYTICS-3: unified Product Intelligence read model.
//
//   product_intelligence_list    filter / search / sort / page in SQL (50 rows to the
//                                browser, not 1 153) + shop summary + hero + attention
//   product_intelligence_detail  one product: every signal with evidence + shop context
//   product_signal_summary       summary only (agent / digest)
//
// All metrics, deltas, coverage, signals, health and priority come from SQL
// (migration 00071) with PRODUCT_INTELLIGENCE_CONFIG as p_cfg. CALLERS AUTHORIZE
// FIRST (page: requirePermission; agent tools: ai_user_shop_access). DB only —
// zero Shopee calls.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays } from "../analytics/periods.ts";

import { intelligenceConfigJson } from "./config.ts";
import type { SalesCoverageState } from "./coverage.ts";
import { ProductAnalyticsReadError } from "./errors.ts";
import type { ProductPeriod } from "./periods.ts";
import { HEALTH_LABELS, PERFORMANCE_SIGNAL_TYPES, type AttentionPriority, type DataQualitySignalType, type HealthLabel, type PerformanceSignalType, type ProductHealth, type ProductIntel, type ProductSignal } from "./signals.ts";
import type { PaDelta } from "./types.ts";

export interface ShopIntelContext {
  shop_id: string;
  sales_enabled: boolean;
  sales_state: SalesCoverageState;
  covered_from: string | null;
  current_complete: boolean;
  previous_complete: boolean;
  sales_backfill_done_at: string | null;
  sales_last_success_at: string | null;
  sales_age_minutes: number | null;
  sales_stale: boolean;
  ads_today_at: string | null;
  ads_age_minutes: number | null;
  ads_stale: boolean;
}

/** One product's metrics (SQL). Sales values are NULL when the shop has no sales data (never 0). */
export interface IntelRowBase {
  id: string;
  shop_id: string;
  item_id: string;
  name: string | null;
  sku: string | null;
  image_url: string | null;
  status: string | null;
  campaigns: number;
  shared_campaigns: number;
  gmv: number | null;
  orders: number | null;
  units: number | null;
  prev_gmv: number | null;
  prev_orders: number | null;
  prev_units: number | null;
  /** only when both periods are covered (and same-time comparable) */
  gmv_pct: number | null;
  orders_pct: number | null;
  spend: number;
  prev_spend: number;
  spend_pct: number | null;
  impressions: number;
  clicks: number;
  broad_order: number;
  direct_order: number;
  broad_gmv: number;
  direct_gmv: number;
  broad_roas: number | null;
  prev_broad_roas: number | null;
  roas_pct: number | null;
  sales_state: SalesCoverageState;
  covered_from: string | null;
  /** false → current sales are a LOWER BOUND (not backfilled / before covered_from) */
  sales_exact: boolean;
  sales_comparable: boolean;
  ads_comparable: boolean;
}

export interface IntelListRow extends IntelRowBase {
  health: ProductHealth;
  priority: AttentionPriority;
  needs_attention: boolean;
  top_signals: ProductSignal[];
  signal_types: string[];
  data_quality: DataQualitySignalType[];
}

export interface IntelDetailRow extends IntelRowBase {
  intel: ProductIntel;
}

export interface HeroBlock {
  sales_availability: "no_data" | "complete" | "lower_bound";
  sales_comparable: boolean;
  ads_comparable: boolean;
  gmv: PaDelta;
  orders: PaDelta;
  units: PaDelta;
  ads_spend: PaDelta;
  ads_broad_gmv: PaDelta;
  ads_broad_roas: PaDelta;
  ads_clicks: PaDelta;
  /** shops without any sales data: left out of the sales totals (never counted as 0) */
  sales_excluded_shops: number;
  sales_last_success_at: string | null;
  sales_oldest_success_at: string | null;
  ads_today_at: string | null;
}

export interface ShopSignalContext {
  shop_id: string;
  products: number;
  sales_comparable_products: number;
  sales_down: number;
  sales_up: number;
  median_gmv_pct: number | null;
  median_broad_roas: number | null;
}

export interface IntelSummary {
  health_counts: Partial<Record<HealthLabel, number>>;
  products: number;
  needs_attention: number;
  sales_declining: number;
  sales_growing: number;
  ads_efficiency_declining: number;
  top_attention: IntelListRow[];
  shop_context: ShopSignalContext[];
  hero: HeroBlock;
}

export interface IntelListResult {
  total: number;
  filtered: number;
  page: number;
  page_size: number;
  rows: IntelListRow[];
  statuses: string[];
  shops: ShopIntelContext[];
  summary: IntelSummary | null;
}

export interface IntelDetail {
  row: IntelDetailRow;
  shop_context: {
    products: number;
    sales_comparable_products: number;
    sales_down: number;
    median_gmv_pct: number | null;
    median_broad_roas: number | null;
    /** product Δ% minus the shop median Δ% (percentage points) */
    product_gmv_pct_minus_median: number | null;
    /** product Broad ROAS vs the shop median, % */
    product_roas_vs_median_pct: number | null;
  };
  shop: ShopIntelContext;
}

export const INTEL_SORTS = ["priority", "gmv", "gmv_pct", "orders", "units", "spend", "broad_roas", "roas_pct", "name"] as const;
export type IntelSort = (typeof INTEL_SORTS)[number];
export const INTEL_PAGE_SIZES = [25, 50, 100] as const;

export interface IntelListQuery {
  q?: string;
  ads?: "all" | "with" | "without";
  status?: string;
  /** a health label, or ATTENTION (= needs_attention) */
  health?: HealthLabel | "ATTENTION" | "all";
  signal?: PerformanceSignalType | "all";
  sort?: IntelSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export const isHealthFilter = (v: unknown): v is HealthLabel | "ATTENTION" => v === "ATTENTION" || (HEALTH_LABELS as readonly string[]).includes(v as string);
export const isSignalFilter = (v: unknown): v is PerformanceSignalType => (PERFORMANCE_SIGNAL_TYPES as readonly string[]).includes(v as string);

function periodArgs(p: ProductPeriod) {
  return { p_from: p.from, p_to: p.to, p_prev_from: p.prevFrom, p_prev_to: p.prevTo, p_hour_cutoff: p.hourCutoff, p_partial_today: p.partialToday, p_cfg: intelligenceConfigJson() };
}

export async function loadIntelligenceList(db: SupabaseClient, shopIds: string[], period: ProductPeriod, query: IntelListQuery = {}, opts: { withSummary?: boolean; top?: number } = {}): Promise<IntelListResult> {
  if (!shopIds.length) return { total: 0, filtered: 0, page: 1, page_size: query.pageSize ?? 50, rows: [], statuses: [], shops: [], summary: null };
  const { data, error } = await db.rpc("product_intelligence_list", {
    p_shop_ids: shopIds,
    ...periodArgs(period),
    p_q: query.q ?? null,
    p_ads: query.ads ?? "all",
    p_status: query.status ?? "all",
    p_health: query.health ?? "all",
    p_signal: query.signal ?? "all",
    p_sort: query.sort ?? "priority",
    p_dir: query.dir ?? "desc",
    p_page: query.page ?? 1,
    p_page_size: query.pageSize ?? 50,
    p_with_summary: opts.withSummary ?? true,
    p_top: opts.top ?? 6,
  });
  if (error) throw new ProductAnalyticsReadError("danh sách sản phẩm", error.message);
  return data as IntelListResult;
}

export async function loadIntelligenceDetail(db: SupabaseClient, ref: { shopId: string; itemId: string }, period: ProductPeriod): Promise<IntelDetail | null> {
  const { data, error } = await db.rpc("product_intelligence_detail", { p_shop_id: ref.shopId, p_item_id: ref.itemId, ...periodArgs(period) });
  if (error) throw new ProductAnalyticsReadError("tín hiệu sản phẩm", error.message);
  return (data as IntelDetail | null) ?? null;
}

export async function loadSignalSummary(db: SupabaseClient, shopIds: string[], period: ProductPeriod, top = 6): Promise<IntelSummary | null> {
  if (!shopIds.length) return null;
  const { data, error } = await db.rpc("product_signal_summary", { p_shop_ids: shopIds, ...periodArgs(period), p_top: top });
  if (error) throw new ProductAnalyticsReadError("tổng hợp tín hiệu", error.message);
  return data as IntelSummary;
}

// ------------------------------------------------------------------ baseline

export interface BaselineStats {
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  stddev: number | null;
  cv: number | null;
  total: number | null;
}

export interface BaselineWindow {
  days: number;
  from: string;
  to: string;
  /** false → some days precede the sales coverage: the sales part counts them as 0, do not use it */
  sales_complete: boolean;
  days_with_sales: number;
  metrics: Partial<Record<"sales_gmv" | "orders" | "units" | "ads_spend" | "ads_broad_gmv" | "ads_clicks", BaselineStats>>;
}

/** The N completed days BEFORE the current period (history the current period is compared with). */
export function baselineWindowRange(period: Pick<ProductPeriod, "from">, days: number): { from: string; to: string } {
  return { from: addDays(period.from, -days), to: addDays(period.from, -1) };
}

export async function loadBaselineWindows(db: SupabaseClient, ref: { shopId: string; itemId: string }, period: ProductPeriod, coveredFrom: string | null, windows: readonly number[] = [7, 30]): Promise<BaselineWindow[]> {
  return Promise.all(
    windows.map(async (days) => {
      const r = baselineWindowRange(period, days);
      const { data, error } = await db.rpc("product_analytics_baseline", { p_shop_id: ref.shopId, p_item_id: ref.itemId, p_from: r.from, p_to: r.to });
      if (error) throw new ProductAnalyticsReadError("baseline", error.message);
      const b = data as { days: number; days_with_sales: number; metrics: BaselineWindow["metrics"] | null };
      return { days, ...r, sales_complete: coveredFrom !== null && r.from >= coveredFrom, days_with_sales: Number(b.days_with_sales ?? 0), metrics: b.metrics ?? {} };
    }),
  );
}
