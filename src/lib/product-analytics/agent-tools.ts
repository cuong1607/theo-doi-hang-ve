// ============================================================
// PRODUCT-ANALYTICS-2: read-only backend functions for the FUTURE Claude
// Product Analyst (spec §52–54, §70). NOT exposed to any model in this phase.
//
//   * every call carries { internal_user_id, shop_id, product_id } and is
//     AUTHORIZED HERE (active profile + allowed role + explicit
//     ai_user_shop_access grant + product belongs to that shop) before any read;
//   * typed parameters only — no SQL, no free-form query;
//   * output = compact aggregated JSON computed in SQL: no raw order rows,
//     no buyer data, no raw snapshots, no SQL text, no unbounded daily dump.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { CONVERSATION_ALLOWED_ROLES } from "../conversation/service.ts";

import { salesComparable, type SalesCoverage } from "./coverage.ts";
import { buildProductDataQuality, PRODUCT_METRIC_META } from "./data-quality.ts";
import { resolveProductPeriod, type ProductPeriod, type ProductPeriodPreset } from "./periods.ts";
import { loadProductDetail, loadShopFreshness, ProductAnalyticsReadError, type ProductDetail, type ProductRef } from "./read-model.ts";
import type { PaDelta } from "./types.ts";
import { addDays, vnToday } from "../analytics/periods.ts";

export interface ProductToolScope {
  internal_user_id: string;
  shop_id: string;
  product_id: string;
}

export type ProductToolPeriodInput = { preset: ProductPeriodPreset } | { from: string; to: string };

export const PRODUCT_TOOL_NAMES = ["get_product_overview", "compare_product_periods", "get_product_sales_summary", "get_product_ads_performance", "get_product_baseline"] as const;
export type ProductToolName = (typeof PRODUCT_TOOL_NAMES)[number];

export class ProductToolAccessError extends Error {
  readonly code: "invalid_scope" | "user_not_allowed" | "shop_not_granted" | "product_not_found";
  constructor(code: ProductToolAccessError["code"], message: string) {
    super(message);
    this.name = "ProductToolAccessError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Backend authorization — the model / transport is never trusted for this. */
export async function authorizeProductTool(db: SupabaseClient, scope: ProductToolScope): Promise<ProductRef> {
  if (!UUID.test(scope.internal_user_id) || !UUID.test(scope.shop_id) || !UUID.test(scope.product_id)) throw new ProductToolAccessError("invalid_scope", "Phạm vi công cụ không hợp lệ.");
  const { data: profile, error: pErr } = await db.from("profiles").select("role, is_active").eq("id", scope.internal_user_id).maybeSingle<{ role: string | null; is_active: boolean }>();
  if (pErr) throw new ProductAnalyticsReadError("người dùng", pErr.message);
  if (!profile?.is_active || !CONVERSATION_ALLOWED_ROLES.includes(profile.role ?? "")) throw new ProductToolAccessError("user_not_allowed", "Người dùng không có quyền dùng trợ lý.");
  const { data: grant, error: gErr } = await db.from("ai_user_shop_access").select("shop_id").eq("internal_user_id", scope.internal_user_id).eq("shop_id", scope.shop_id).maybeSingle();
  if (gErr) throw new ProductAnalyticsReadError("quyền shop", gErr.message);
  if (!grant) throw new ProductToolAccessError("shop_not_granted", "Bạn không có quyền xem shop này.");
  const { data: product, error: prErr } = await db.from("shopee_products").select("id, shop_id, provider_item_id").eq("id", scope.product_id).eq("shop_id", scope.shop_id).maybeSingle<{ id: string; shop_id: string; provider_item_id: string }>();
  if (prErr) throw new ProductAnalyticsReadError("sản phẩm", prErr.message);
  // same item id in another shop is a different product: identity = shop + item
  if (!product) throw new ProductToolAccessError("product_not_found", "Không tìm thấy sản phẩm trong shop này.");
  return { productId: product.id, shopId: product.shop_id, itemId: product.provider_item_id };
}

function period(input: ProductToolPeriodInput | undefined, now: Date): ProductPeriod {
  if (!input) return resolveProductPeriod({ preset: "7d" }, now);
  return "preset" in input ? resolveProductPeriod({ preset: input.preset }, now) : resolveProductPeriod({ preset: "custom", from: input.from, to: input.to }, now);
}

const pick = (d: PaDelta) => ({ current: d.current, previous: d.previous, abs: d.abs, pct: d.pct });

/**
 * Sales-based value: missing data is never handed over as 0. No data at all →
 * null; not covered → current is a lower bound; previous / change only when
 * both periods are covered.
 */
function salesPick(d: PaDelta, c: SalesCoverage) {
  const comparable = salesComparable(c);
  return {
    current: c.state === "no_data" ? null : d.current,
    previous: c.previous_complete ? d.previous : null,
    abs: comparable ? d.abs : null,
    pct: comparable ? d.pct : null,
    availability: c.state === "no_data" ? ("no_data" as const) : c.current_complete ? ("complete" as const) : ("lower_bound" as const),
  };
}

const salesValue = (v: number | null, c: SalesCoverage) => (c.state === "no_data" ? null : v);

function periodOut(p: ProductPeriod) {
  return { from: p.from, to: p.to, previous_from: p.prevFrom, previous_to: p.prevTo, partial_today: p.partialToday, hour_cutoff: p.hourCutoff };
}

function productOut(d: ProductDetail) {
  const i = d.summary.identity;
  return { product_id: i.product_id, item_id: i.provider_item_id, name: i.name, sku: i.sku, status: i.provider_status };
}

function qualityOut(d: ProductDetail) {
  const q = d.quality;
  return {
    sales_freshness_minutes: q.sales_freshness.age_minutes,
    ads_freshness_minutes: q.ads_freshness.age_minutes,
    extra_info_freshness_hours: q.extra_info_freshness.age_hours,
    stale: q.sales_freshness.stale || q.ads_freshness.stale,
    sales_backfill_done: q.sales_freshness.backfill_done,
    sales_coverage: q.sales_coverage,
    missing_sources: q.missing_sources,
    partial_today: q.partial_today,
    same_time_comparison: q.same_time_comparison,
    semantic_warnings: q.semantic_warnings,
  };
}

const meta = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, { source: PRODUCT_METRIC_META[k].source, semantic_confidence: PRODUCT_METRIC_META[k].semantic_confidence }]));

async function detail(db: SupabaseClient, scope: ProductToolScope, input: ProductToolPeriodInput | undefined, now: Date): Promise<{ d: ProductDetail; p: ProductPeriod }> {
  const ref = await authorizeProductTool(db, scope);
  const p = period(input, now);
  const d = await loadProductDetail(db, ref, p, now);
  if (!d) throw new ProductToolAccessError("product_not_found", "Không tìm thấy sản phẩm trong shop này.");
  return { d, p };
}

export async function get_product_overview(db: SupabaseClient, scope: ProductToolScope, input?: { period?: ProductToolPeriodInput }, now = new Date()) {
  const { d, p } = await detail(db, scope, input?.period, now);
  const s = d.summary;
  return {
    tool: "get_product_overview" as const,
    product: productOut(d),
    period: periodOut(p),
    sales: {
      gmv: salesValue(s.sales.gmv.current, d.quality.sales_coverage),
      orders: salesValue(s.sales.orders.current, d.quality.sales_coverage),
      units: salesValue(s.sales.units.current, d.quality.sales_coverage),
      availability: salesPick(s.sales.gmv, d.quality.sales_coverage).availability,
    },
    ads: { campaigns: s.ads.single_item_campaigns, spend: s.ads.spend.current, broad_gmv: s.ads.broad_gmv.current, broad_roas: s.ads.broad_roas.current, clicks: s.ads.clicks.current },
    // current provider snapshot — no period delta (semantics unverified)
    provider_snapshot: s.snapshot ? { captured_at: s.snapshot.captured_at, views: s.snapshot.views, sale: s.snapshot.sale, likes: s.snapshot.likes, rating_star: s.snapshot.rating_star, comment_count: s.snapshot.comment_count } : null,
    signals: d.signals.map((x) => ({ type: x.type, metric: x.metric, pct: x.pct })),
    data_quality: qualityOut(d),
    metric_meta: meta("sales_gmv", "orders", "units", "ads_spend", "ads_broad_gmv", "views_snapshot", "sale_snapshot"),
  };
}

export async function compare_product_periods(db: SupabaseClient, scope: ProductToolScope, input?: { period?: ProductToolPeriodInput }, now = new Date()) {
  const { d, p } = await detail(db, scope, input?.period, now);
  const s = d.summary;
  return {
    tool: "compare_product_periods" as const,
    product: productOut(d),
    period: periodOut(p),
    comparisons: {
      sales_gmv: salesPick(s.sales.gmv, d.quality.sales_coverage),
      orders: salesPick(s.sales.orders, d.quality.sales_coverage),
      units: salesPick(s.sales.units, d.quality.sales_coverage),
      ads_spend: pick(s.ads.spend),
      ads_clicks: pick(s.ads.clicks),
      ads_impressions: pick(s.ads.impressions),
      ads_broad_gmv: pick(s.ads.broad_gmv),
      ads_broad_roas: pick(s.ads.broad_roas),
    },
    signals: d.signals.map((x) => ({ type: x.type, metric: x.metric, current: x.current, previous: x.previous, pct: x.pct })),
    data_quality: qualityOut(d),
    metric_meta: meta("sales_gmv", "orders", "units", "ads_spend", "ads_broad_gmv"),
  };
}

export async function get_product_sales_summary(db: SupabaseClient, scope: ProductToolScope, input?: { period?: ProductToolPeriodInput }, now = new Date()) {
  const { d, p } = await detail(db, scope, input?.period, now);
  const s = d.summary.sales;
  return {
    tool: "get_product_sales_summary" as const,
    product: productOut(d),
    period: periodOut(p),
    sales: {
      gmv: salesPick(s.gmv, d.quality.sales_coverage),
      orders: salesPick(s.orders, d.quality.sales_coverage),
      units: salesPick(s.units, d.quality.sales_coverage),
      cancelled_orders: salesPick(s.cancelled_orders, d.quality.sales_coverage),
    },
    semantics: {
      gmv: "item subtotal at discounted unit price × (quantity − cancelled), before vouchers / shipping, returns not netted",
      counted_statuses: ["READY_TO_SHIP", "PROCESSED", "RETRY_SHIP", "SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED", "TO_RETURN"],
      report_date: "order create time, Asia/Ho_Chi_Minh",
    },
    data_quality: qualityOut(d),
    metric_meta: meta("sales_gmv", "orders", "units"),
  };
}

export async function get_product_ads_performance(db: SupabaseClient, scope: ProductToolScope, input?: { period?: ProductToolPeriodInput }, now = new Date()) {
  const { d, p } = await detail(db, scope, input?.period, now);
  const a = d.summary.ads;
  return {
    tool: "get_product_ads_performance" as const,
    product: productOut(d),
    period: periodOut(p),
    ads: {
      single_item_campaigns: a.single_item_campaigns,
      shared_campaigns_excluded: a.shared_campaigns_excluded,
      spend: pick(a.spend),
      impressions: pick(a.impressions),
      clicks: pick(a.clicks),
      direct_order: pick(a.direct_order),
      broad_order: pick(a.broad_order),
      direct_gmv: pick(a.direct_gmv),
      broad_gmv: pick(a.broad_gmv),
      cpc: pick(a.cpc),
      ctr: pick(a.ctr),
      direct_roas: pick(a.direct_roas),
      broad_roas: pick(a.broad_roas),
      direct_cvr: pick(a.direct_cvr),
      broad_cvr: pick(a.broad_cvr),
      // its denominator is sales: same coverage rule
      ads_attribution_to_total_sales_indicator: salesPick(a.broad_gmv_to_sales_indicator, d.quality.sales_coverage.current_complete ? d.quality.sales_coverage : { ...d.quality.sales_coverage, state: "no_data" }),
    },
    attribution_warning: "Broad / direct GMV are Shopee Ads attribution metrics. They are NOT the part of sales caused by Ads; total − Ads is NOT organic sales.",
    data_quality: qualityOut(d),
    metric_meta: meta("ads_spend", "ads_broad_gmv", "ads_direct_gmv", "broad_gmv_to_sales_indicator"),
  };
}

export async function get_product_baseline(db: SupabaseClient, scope: ProductToolScope, input?: { days?: number }, now = new Date()) {
  const ref = await authorizeProductTool(db, scope);
  const days = Math.min(90, Math.max(7, Math.round(input?.days ?? 28)));
  const to = addDays(vnToday(now), -1);
  const from = addDays(to, -(days - 1));
  const [{ data, error }, freshness] = await Promise.all([
    db.rpc("product_analytics_baseline", { p_shop_id: ref.shopId, p_item_id: ref.itemId, p_from: from, p_to: to }),
    loadShopFreshness(db, [ref.shopId]),
  ]);
  if (error) throw new ProductAnalyticsReadError("baseline", error.message);
  const q = buildProductDataQuality({ now, freshness: freshness.get(ref.shopId) ?? null, summary: null, partialToday: false, hourCutoff: null, period: { from, prevFrom: from } });
  return {
    tool: "get_product_baseline" as const,
    product_id: ref.productId,
    item_id: ref.itemId,
    completed_days_only: true,
    baseline: data as Record<string, unknown>,
    // a baseline over days the sales backfill has not covered yet would read as zero sales
    data_quality: {
      sales_freshness_minutes: q.sales_freshness.age_minutes,
      ads_freshness_minutes: q.ads_freshness.age_minutes,
      sales_backfill_done: q.sales_freshness.backfill_done,
      // false → the sales part of the baseline counts uncovered days as 0: do not use it
      sales_baseline_complete: q.sales_coverage.current_complete,
      sales_coverage: q.sales_coverage,
      missing_sources: q.missing_sources.filter((s) => s !== "extra_info"),
      semantic_warnings: q.semantic_warnings,
    },
    metric_meta: meta("sales_gmv", "orders", "units", "ads_spend", "ads_broad_gmv"),
  };
}
