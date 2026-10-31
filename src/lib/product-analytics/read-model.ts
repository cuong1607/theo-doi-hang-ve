// ============================================================
// PRODUCT-ANALYTICS-2: DB-only read model (UI + future agent tools).
//
// Calls the 00070 RPCs with the service-role client. CALLERS AUTHORIZE FIRST
// (page: requirePermission; agent tools: internal user + ai_user_shop_access) —
// a shop id coming from a browser / message is never trusted on its own.
// Zero Shopee calls: opening a page reads the database only.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { buildProductDataQuality, type ProductDataQuality } from "./data-quality.ts";
import { ProductAnalyticsReadError } from "./errors.ts";
import { loadIntelligenceDetail, type IntelDetail } from "./intelligence.ts";
import type { ProductPeriod } from "./periods.ts";
import type { ProductDailyRow, ProductListRow, ProductSummary, ShopFreshnessRow } from "./types.ts";

export { ProductAnalyticsReadError };

export interface ProductRef {
  productId: string;
  shopId: string;
  itemId: string;
}

export async function resolveProductById(db: SupabaseClient, productId: string): Promise<ProductRef | null> {
  if (!/^[0-9a-f-]{36}$/i.test(productId)) return null;
  const { data, error } = await db.from("shopee_products").select("id, shop_id, provider_item_id").eq("id", productId).maybeSingle<{ id: string; shop_id: string; provider_item_id: string }>();
  if (error) throw new ProductAnalyticsReadError("sản phẩm", error.message);
  return data ? { productId: data.id, shopId: data.shop_id, itemId: data.provider_item_id } : null;
}

export async function loadShopFreshness(db: SupabaseClient, shopIds: string[]): Promise<Map<string, ShopFreshnessRow>> {
  if (!shopIds.length) return new Map();
  const [{ data, error }, { data: ads, error: adsError }] = await Promise.all([
    db.rpc("product_analytics_freshness", { p_shop_ids: shopIds }),
    db.rpc("ads_sync_freshness", { p_shop_ids: shopIds }),
  ]);
  if (error) throw new ProductAnalyticsReadError("độ mới dữ liệu", error.message);
  if (adsError) throw new ProductAnalyticsReadError("độ mới dữ liệu Ads", adsError.message);
  const adsOf = new Map(((ads ?? []) as Array<{ shop_id: string; campaign_today_at: string | null }>).map((a) => [a.shop_id, a.campaign_today_at]));
  return new Map(((data ?? []) as Omit<ShopFreshnessRow, "ads_campaign_today_at">[]).map((r) => [r.shop_id, { ...r, fact_lines: Number(r.fact_lines), ads_campaign_today_at: adsOf.get(r.shop_id) ?? null }]));
}

export async function loadProductSummary(db: SupabaseClient, ref: Pick<ProductRef, "shopId" | "itemId">, period: ProductPeriod): Promise<ProductSummary | null> {
  const { data, error } = await db.rpc("product_analytics_summary", {
    p_shop_id: ref.shopId,
    p_item_id: ref.itemId,
    p_from: period.from,
    p_to: period.to,
    p_prev_from: period.prevFrom,
    p_prev_to: period.prevTo,
    p_hour_cutoff: period.hourCutoff,
  });
  if (error) throw new ProductAnalyticsReadError("tổng hợp sản phẩm", error.message);
  return (data as ProductSummary | null) ?? null;
}

export async function loadProductDaily(db: SupabaseClient, ref: Pick<ProductRef, "shopId" | "itemId">, from: string, to: string): Promise<ProductDailyRow[]> {
  const { data, error } = await db.rpc("product_analytics_daily", { p_shop_id: ref.shopId, p_item_id: ref.itemId, p_from: from, p_to: to });
  if (error) throw new ProductAnalyticsReadError("xu hướng theo ngày", error.message);
  return ((data ?? []) as ProductDailyRow[]).map((r) => ({
    ...r,
    orders: Number(r.orders),
    units: Number(r.units),
    gmv: Number(r.gmv),
    spend: Number(r.spend),
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
    direct_order: Number(r.direct_order),
    broad_order: Number(r.broad_order),
    direct_gmv: Number(r.direct_gmv),
    broad_gmv: Number(r.broad_gmv),
  }));
}

/** PA-2 flat list (all rows, no signals) — kept for pilot scripts; the page uses product_intelligence_list. */
export async function loadProductList(db: SupabaseClient, shopIds: string[], period: ProductPeriod): Promise<ProductListRow[]> {
  if (!shopIds.length) return [];
  const { data, error } = await db.rpc("product_analytics_list", { p_shop_ids: shopIds, p_from: period.from, p_to: period.to, p_prev_from: period.prevFrom, p_prev_to: period.prevTo });
  if (error) throw new ProductAnalyticsReadError("danh sách sản phẩm", error.message);
  return (data ?? []) as ProductListRow[];
}

/** Runs a read and measures it (query latency shown on the page; keeps clocks out of render). */
export async function timedRead<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - started) };
}

// ------------------------------------------------------------------ detail

export interface ProductDetail {
  summary: ProductSummary;
  daily: ProductDailyRow[];
  quality: ProductDataQuality;
  /** SQL signal engine: every signal with evidence, health, priority, shop context */
  intel: IntelDetail;
}

/** Everything one product page / agent tool needs, read in parallel (4 RPC round trips, one wait). */
export async function loadProductDetail(db: SupabaseClient, ref: ProductRef, period: ProductPeriod, now: Date = new Date()): Promise<ProductDetail | null> {
  const [summary, daily, freshness, intel] = await Promise.all([
    loadProductSummary(db, ref, period),
    loadProductDaily(db, ref, period.from, period.to),
    loadShopFreshness(db, [ref.shopId]),
    loadIntelligenceDetail(db, ref, period),
  ]);
  if (!summary || !intel) return null;
  const quality = buildProductDataQuality({ now, freshness: freshness.get(ref.shopId) ?? null, summary, partialToday: period.partialToday, hourCutoff: period.hourCutoff, period });
  return { summary, daily, quality, intel };
}
