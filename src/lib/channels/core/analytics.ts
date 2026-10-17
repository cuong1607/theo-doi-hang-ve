// ============================================================
// PHASE SHOPEE-8: analytics read model — typed access to the SQL RPCs of
// migration 00059. Nothing is calculated here: every total, margin and
// coverage comes from the database (NUMERIC), money stays a decimal string.
//
// Scope: resolveAnalyticsScope decides the shop set on the SERVER from the
// shops the user may see (channel:view → every Shopee shop today); a shop id
// from the URL is only honoured when it is in that set. One currency per
// query — shops with another currency are excluded and reported, never
// summed without FX.
// Takes the DB client as a parameter (service-role on the server, injected
// in tests).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AnalyticsScope {
  shopIds: string[];
  currency: string;
  /** Shops left out because they use another currency (All Shops only). */
  excludedShops: Array<{ id: string; name: string; currency: string | null }>;
  selectedShopId: string | null;
  shops: Array<{ id: string; name: string; currency: string | null }>;
}

const DEFAULT_CURRENCY = "VND";

/** Effective currency of a shop: shops.currency, else its latest order's (the connect flow does not always fill it). */
async function shopCurrencies(db: SupabaseClient, shops: Array<{ id: string; currency: string | null }>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const s of shops) {
    if (s.currency) {
      out.set(s.id, s.currency);
      continue;
    }
    const { data } = await db.from("channel_orders").select("currency").eq("shop_id", s.id).order("created_at_channel", { ascending: false, nullsFirst: false }).limit(1).maybeSingle<{ currency: string }>();
    out.set(s.id, data?.currency ?? null);
  }
  return out;
}

export async function resolveAnalyticsScope(db: SupabaseClient, requestedShopId: string | null | undefined): Promise<AnalyticsScope | null> {
  const { data, error } = await db.from("shops").select("id, shop_name, currency").eq("channel", "shopee").order("shop_name");
  if (error) throw new Error(`Không đọc được shop: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; shop_name: string; currency: string | null }>;
  if (rows.length === 0) return null;
  const cur = await shopCurrencies(db, rows);
  const shops = rows.map((r) => ({ id: r.id, name: r.shop_name, currency: cur.get(r.id) ?? null }));
  const selected = requestedShopId && shops.some((s) => s.id === requestedShopId) ? requestedShopId : null;
  if (selected) {
    const s = shops.find((x) => x.id === selected)!;
    return { shopIds: [selected], currency: s.currency ?? DEFAULT_CURRENCY, excludedShops: [], selectedShopId: selected, shops };
  }
  // All Shops: the most common currency; others are reported, not summed
  const counts = new Map<string, number>();
  for (const s of shops) counts.set(s.currency ?? DEFAULT_CURRENCY, (counts.get(s.currency ?? DEFAULT_CURRENCY) ?? 0) + 1);
  const currency = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return {
    shopIds: shops.filter((s) => (s.currency ?? DEFAULT_CURRENCY) === currency).map((s) => s.id),
    currency,
    excludedShops: shops.filter((s) => (s.currency ?? DEFAULT_CURRENCY) !== currency),
    selectedShopId: null,
    shops,
  };
}

type Range = { from: string; to: string };
const args = (scope: Pick<AnalyticsScope, "shopIds" | "currency">, range: Range) => ({ p_shop_ids: scope.shopIds, p_from: range.from, p_to: range.to, p_currency: scope.currency });

async function rpc<T>(db: SupabaseClient, fn: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, params);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

// --------------------------------------------------------------- summary

export interface AnalyticsSummary {
  orders_created: number;
  order_count: number;
  cancelled_count: number;
  units: string;
  order_value: string;
  order_value_orders: number;
  estimated_revenue: string | null;
  estimated_revenue_orders: number;
  estimated_profit: string | null;
  estimated_profit_orders: number;
  estimated_margin: string | null;
  actual_income: string | null;
  actual_income_orders: number;
  actual_profit: string | null;
  actual_profit_orders: number;
  actual_margin: string | null;
  original_cogs: string | null;
  reversed_cogs: string | null;
  net_cogs: string | null;
  cogs_orders: number;
  missing_cogs_orders: number;
  unmapped_orders: number;
  missing_estimated_orders: number;
  awaiting_actual_orders: number;
  mismatch_orders: number;
  loss_actual_orders: number;
  loss_estimated_orders: number;
  orders_with_returns: number;
  returned_units: string;
}

export const getAnalyticsSummary = (db: SupabaseClient, scope: AnalyticsScope, range: Range) => rpc<AnalyticsSummary>(db, "analytics_summary", args(scope, range));

export interface TrendPoint {
  bucket: string;
  orders: number;
  order_value: string;
  estimated_revenue: string | null;
  estimated_profit: string | null;
  estimated_profit_orders: number;
  estimated_margin: string | null;
  actual_profit: string | null;
  actual_profit_orders: number;
  actual_margin: string | null;
}

export const getAnalyticsTrend = (db: SupabaseClient, scope: AnalyticsScope, range: Range, bucket: "hour" | "day" | "week" | "month") =>
  rpc<TrendPoint[]>(db, "analytics_trend", { ...args(scope, range), p_bucket: bucket });

export const getOrderStatusMix = (db: SupabaseClient, scope: AnalyticsScope, range: Range) =>
  rpc<Array<{ order_status: string; orders: number; order_value: string; is_sales: boolean }>>(db, "analytics_order_status_mix", args(scope, range));

// -------------------------------------------------------------- products

export const PRODUCT_SORTS = ["units", "order_value", "estimated_profit", "actual_profit", "estimated_margin", "actual_margin", "return_rate", "cogs"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export const isProductSort = (v: unknown): v is ProductSort => typeof v === "string" && (PRODUCT_SORTS as readonly string[]).includes(v);

export interface ProductAnalyticsRow {
  product_id: string;
  sku: string;
  name: string;
  product_type: "atomic" | "combo";
  units: string;
  orders: number;
  lines: number;
  order_value: string | null;
  estimated_revenue: string | null;
  cogs: string | null;
  estimated_profit: string | null;
  estimated_lines: number;
  estimated_margin: string | null;
  actual_profit: string | null;
  actual_lines: number;
  actual_margin: string | null;
  returned_units: string;
  return_rate: string | null;
  small_sample: boolean;
  cost_flag: "cogs_missing" | "no_cost_state" | "negative_stock" | "provisional" | null;
  total_count: number;
}

export interface ProductQuery {
  type?: "atomic" | "combo" | null;
  search?: string | null;
  attention?: boolean;
  sort?: ProductSort;
  desc?: boolean;
  limit?: number;
  offset?: number;
  productId?: string | null;
  /** "margin < X %" filter of the attention list (default: analytics_settings.low_margin_threshold_pct). */
  marginThreshold?: string | null;
}

export async function getProductAnalytics(db: SupabaseClient, scope: AnalyticsScope, range: Range, q: ProductQuery = {}): Promise<{ rows: ProductAnalyticsRow[]; total: number }> {
  const rows = await rpc<ProductAnalyticsRow[]>(db, "analytics_products", {
    ...args(scope, range),
    p_type: q.type ?? null,
    p_search: q.search?.trim() ? q.search.trim() : null,
    p_attention: q.attention ?? false,
    p_sort: q.sort ?? "estimated_profit",
    p_desc: q.desc ?? true,
    p_limit: q.limit ?? 25,
    p_offset: q.offset ?? 0,
    p_product_id: q.productId ?? null,
    p_margin_threshold: q.marginThreshold ?? null,
  });
  return { rows, total: rows[0]?.total_count ?? 0 };
}

/**
 * Default ranking: actual profit when actual data covers enough of the
 * period (≥ 80 % of orders), otherwise estimated profit — the caller labels
 * which one is used.
 */
export const ACTUAL_COVERAGE_FOR_RANKING = 0.8;
export function defaultProductSort(summary: Pick<AnalyticsSummary, "order_count" | "actual_profit_orders">): ProductSort {
  return summary.order_count > 0 && summary.actual_profit_orders / summary.order_count >= ACTUAL_COVERAGE_FOR_RANKING ? "actual_profit" : "estimated_profit";
}

export const getAtomicConsumption = (db: SupabaseClient, scope: AnalyticsScope, range: Range, limit = 20) =>
  rpc<Array<{ product_id: string; sku: string; name: string; direct_units: string; via_combo_units: string; total_units: string }>>(db, "analytics_atomic_consumption", { ...args(scope, range), p_limit: limit });

// --------------------------------------------------------- profitability

export interface LossOrderRow {
  order_id: string;
  shop_id: string;
  external_order_sn: string;
  created_at_channel: string | null;
  order_status: string;
  order_value: string | null;
  estimated_profit: string | null;
  actual_profit: string | null;
  loss_state: "actual_loss" | "estimated_loss";
  margin: string | null;
  total_count: number;
}

export async function getLossOrders(db: SupabaseClient, scope: AnalyticsScope, range: Range, limit = 10, offset = 0) {
  const rows = await rpc<LossOrderRow[]>(db, "analytics_loss_orders", { ...args(scope, range), p_limit: limit, p_offset: offset });
  return { rows, total: rows[0]?.total_count ?? 0 };
}

export interface MarginBand {
  band_index: number;
  lower_pct: string | null;
  upper_pct: string | null;
  orders: number;
  order_value: string;
  profit: string;
}

export const getMarginBands = (db: SupabaseClient, scope: AnalyticsScope, range: Range, basis: "estimated" | "actual") =>
  rpc<MarginBand[]>(db, "analytics_margin_bands", { ...args(scope, range), p_basis: basis });

// --------------------------------------------------------------- returns

export interface ReturnsAnalytics {
  return_count: number;
  returned_units: string;
  unmatched_units: string;
  refund_amount_reference: string;
  restocked_units: string;
  damaged_units: string;
  lost_units: string;
  disposed_units: string;
  pending_units: string;
  cogs_involved: string;
  cogs_involved_missing: number;
  cogs_reversed: string;
  cogs_not_recovered: string;
  cogs_pending: string;
  cohort_units: string;
  cohort_returned_units: string;
  unit_return_rate: string | null;
  cohort_orders: number;
  cohort_orders_with_returns: number;
  order_return_rate: string | null;
}

export const getReturnsAnalytics = (db: SupabaseClient, scope: AnalyticsScope, range: Range) => rpc<ReturnsAnalytics>(db, "analytics_returns", args(scope, range));

// --------------------------------------------------------------- cashflow

export interface CashflowAnalytics {
  pending_orders: number;
  pending_amount: string;
  pending_without_amount: number;
  stale_orders: number;
  released_amount: string;
  released_orders: number;
  release_mismatch_orders: number;
  payout_amount: string;
  payout_count: number;
  payouts_by_status: Partial<Record<"pending" | "incomplete" | "matched" | "mismatch", number>>;
  open_mismatch_payouts: number;
  open_mismatch_value: string;
  open_incomplete_payouts: number;
  aging: Array<{ bucket: number; lower_days: number; upper_days: number | null; orders: number; amount: string; without_amount: number }>;
}

export const getCashflowAnalytics = (db: SupabaseClient, scope: AnalyticsScope, range: Range) => rpc<CashflowAnalytics>(db, "analytics_cashflow", args(scope, range));

export const getCashflowTrend = (db: SupabaseClient, scope: AnalyticsScope, range: Range) =>
  rpc<Array<{ bucket: string; released_amount: string; released_orders: number; payout_amount: string; payouts: number }>>(db, "analytics_cashflow_trend", args(scope, range));

export async function getPendingReleaseOrders(db: SupabaseClient, scope: AnalyticsScope, bucket: { lower: number | null; upper: number | null }, limit = 25, offset = 0) {
  const rows = await rpc<Array<{ order_id: string; shop_id: string; external_order_sn: string; completed_at_channel: string | null; age_days: string; expected_amount: string | null; release_stale: boolean; total_count: number }>>(
    db,
    "analytics_pending_release_orders",
    { p_shop_ids: scope.shopIds, p_currency: scope.currency, p_min_days: bucket.lower, p_max_days: bucket.upper, p_limit: limit, p_offset: offset },
  );
  return { rows, total: rows[0]?.total_count ?? 0 };
}

// ------------------------------------------------------- quality / shops

export interface DataQuality {
  orders: number;
  unmapped_orders: number;
  missing_cogs_orders: number;
  missing_estimated_orders: number;
  awaiting_actual_orders: number;
  mismatch_orders: number;
  financial_status: Record<string, number>;
  returns_pending_disposition: number;
  payouts_incomplete: number;
  payouts_mismatch: number;
  models_active: number;
  models_mapped: number;
  models_unmapped: number;
  unmapped_models_in_orders: number;
  sold_products_no_cost: number;
  products_negative_stock: number;
  products_vat_pending: number;
  products_provisional: number;
  products_needs_rebuild: number;
}

export const getDataQuality = (db: SupabaseClient, scope: AnalyticsScope, range: Range) => rpc<DataQuality>(db, "analytics_data_quality", args(scope, range));

export interface ShopComparisonRow {
  shop_id: string;
  shop_name: string;
  orders: number;
  order_value: string;
  estimated_revenue: string | null;
  estimated_profit: string | null;
  estimated_profit_orders: number;
  actual_profit: string | null;
  actual_profit_orders: number;
  estimated_margin: string | null;
  actual_margin: string | null;
  units: string;
  returned_units: string;
  unit_return_rate: string | null;
  pending_release_amount: string;
  payout_mismatch: number;
}

export const getShopComparison = (db: SupabaseClient, scope: AnalyticsScope, range: Range) => rpc<ShopComparisonRow[]>(db, "analytics_shop_comparison", args(scope, range));

// -------------------------------------------------------- product detail

export const getProductTrend = (db: SupabaseClient, productId: string, scope: AnalyticsScope, range: Range) =>
  rpc<Array<{ bucket: string; units: string; order_value: string; estimated_profit: string | null; actual_profit: string | null; estimated_margin: string | null; actual_margin: string | null }>>(
    db,
    "analytics_product_trend",
    { p_product_id: productId, ...args(scope, range) },
  );

export const getCostHistory = (db: SupabaseClient, productId: string, limit = 200) =>
  rpc<Array<{ event_time: string; event_type: string; quantity_change: string; unit_cost: string | null; avg_cost_after: string | null; qty_after: string | null; cost_basis: string | null }>>(
    db,
    "analytics_cost_history",
    { p_product_id: productId, p_limit: limit },
  );

export interface AnalyticsSettings {
  lowMarginThresholdPct: string;
  marginBandEdges: string[];
  releaseAgingEdgesDays: number[];
  minSampleUnits: number;
}

export async function getAnalyticsSettings(db: SupabaseClient): Promise<AnalyticsSettings> {
  const { data, error } = await db.from("analytics_settings").select("low_margin_threshold_pct, margin_band_edges, release_aging_edges_days, min_sample_units").eq("id", true).single();
  if (error) throw new Error(`Không đọc được cấu hình analytics: ${error.message}`);
  const r = data as { low_margin_threshold_pct: number | string; margin_band_edges: Array<number | string>; release_aging_edges_days: number[]; min_sample_units: number };
  return {
    lowMarginThresholdPct: String(r.low_margin_threshold_pct),
    marginBandEdges: r.margin_band_edges.map(String),
    releaseAgingEdgesDays: r.release_aging_edges_days,
    minSampleUnits: r.min_sample_units,
  };
}
