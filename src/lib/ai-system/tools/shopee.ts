// ============================================================
// PHASE 05 — Shopee tools (read only, financial).
//
// Source of truth (verified in the code, not assumed):
//   * the LIVE sales data is the Product-Analytics read model (PA-1/PA-2:
//     shopee_product_sales_facts via RPC product_intelligence_list — the same
//     call as /shopee/product-analytics). The older channel_orders analytics
//     (/shopee/analytics, SHOPEE_LEGACY_MODULES_ENABLED) is RETIRED: its sync
//     no longer runs, so no tool reads it.
//   * Ads shop totals: shopee_ads_shop_daily_performance + totalsOf /
//     deriveMetrics — the same rules as /shopee/ads (never Σ campaigns).
// Access: the existing AI rule, reused unchanged — authorizeShopTool()
// (active profile, AI rollout role, app:shopee + channel:view, explicit
// ai_user_shop_access grant), called for EVERY shop on EVERY call.
// "Doanh số" keeps the system's definition (PRODUCT_METRIC_META.sales_gmv);
// missing sales data is reported as missing, never as 0.
// ============================================================
import { z } from "zod";

import { deriveMetrics } from "../../channels/shopee/ads/metrics.ts";
import { loadAdsFreshness, totalsOf } from "../../channels/shopee/ads/real-source.ts";
import { authorizeShopTool, ProductToolAccessError } from "../../product-analytics/agent-tools.ts";
import { PRODUCT_METRIC_META } from "../../product-analytics/data-quality.ts";
import { loadIntelligenceList, type IntelListResult } from "../../product-analytics/intelligence.ts";
import { resolveProductPeriod, type ProductPeriod } from "../../product-analytics/periods.ts";
import type { PaDelta } from "../../product-analytics/types.ts";
import type { SourceInfo, SystemToolDefinition, ToolContext, ToolResult } from "../types.ts";
import { dmy, done, fail, matchByName, nameArg, pct, periodArg, qty, ratio, resolvePeriodArg, ToolReadError, vnd, vnDateTime, type PeriodArg } from "./common.ts";

interface ShopRef {
  id: string;
  name: string;
}

const SALES_DEFINITION = `Doanh số (GMV) = ${PRODUCT_METRIC_META.sales_gmv!.note}`;
const ORDERS_DEFINITION = `Số đơn = ${PRODUCT_METRIC_META.orders!.note}`;
const ADS_ATTRIBUTION = "Doanh số / đơn Broad và Direct là số Shopee Ads QUY CHO quảng cáo, không phải doanh thu của shop; tổng − Ads không phải doanh số tự nhiên.";

// ------------------------------------------------------------------ scope

type ShopScope = { ok: true; shops: ShopRef[] } | { ok: false; result: ToolResult };

/** Shops for this call: the user's explicit AI grants, optionally narrowed by a shop NAME; each one re-authorized. */
async function shopScope(ctx: ToolContext, phrase: string | undefined): Promise<ShopScope> {
  const { data: grants, error } = await ctx.db.from("ai_user_shop_access").select("shop_id, shops!inner(id, shop_name, channel, is_active)").eq("internal_user_id", ctx.actor.userId);
  if (error) throw new ToolReadError("quyền shop", error.message);
  const granted = ((grants ?? []) as unknown as Array<{ shops: { id: string; shop_name: string; channel: string; is_active: boolean } }>)
    .map((g) => g.shops)
    .filter((s) => s && s.channel === "shopee" && s.is_active)
    .map((s) => ({ id: s.id, name: s.shop_name }));
  let shops = granted;
  if (phrase) {
    // detect the shop among ALL Shopee shops, so "not granted" is told apart from "doesn't exist"
    const { data: all, error: allError } = await ctx.db.from("shops").select("id, shop_name").eq("channel", "shopee").eq("is_active", true).range(0, 199);
    if (allError) throw new ToolReadError("shop", allError.message);
    const found = matchByName(phrase, ((all ?? []) as Array<{ id: string; shop_name: string }>).map((s) => ({ id: s.id, name: s.shop_name, code: null })));
    if (found.kind === "none") return { ok: false, result: fail("not_found", `Không tìm thấy shop Shopee “${phrase}”.`, { shop_lookup: 0 }) };
    if (found.kind === "many") {
      const mine = found.values.filter((v) => granted.some((g) => g.id === v.id));
      if (mine.length !== 1) return { ok: false, result: fail("ambiguous", `Có nhiều shop khớp “${phrase}”: ${mine.map((m) => m.name).join("; ") || "(không shop nào bạn được xem)"}. Bạn nêu rõ tên shop nhé.`, { shop_lookup: found.values.length }) };
      shops = mine;
    } else {
      if (!granted.some((g) => g.id === found.value.id)) return { ok: false, result: fail("denied", "Bạn không có quyền xem shop này.", { shop_denied: true }) };
      shops = [{ id: found.value.id, name: found.value.name }];
    }
  }
  if (!shops.length) return { ok: false, result: fail("denied", "Tài khoản của bạn chưa được cấp quyền xem shop Shopee nào cho trợ lý AI.", { shops: 0 }) };
  for (const s of shops) {
    try {
      await authorizeShopTool(ctx.db, { internal_user_id: ctx.actor.userId, shop_id: s.id });
    } catch (err) {
      if (err instanceof ProductToolAccessError) {
        const msg = err.code === "user_not_allowed" ? "Dữ liệu Shopee qua trợ lý AI hiện chỉ mở cho tài khoản quản trị có quyền shop." : "Bạn không có quyền xem shop này.";
        return { ok: false, result: fail("denied", msg, { shop_denied: true }) };
      }
      throw err;
    }
  }
  return { ok: true, shops };
}

// ------------------------------------------------------------------ periods

function productPeriod(p: PeriodArg | undefined, fallback: "today" | "last_7_days", now: Date): { period: ProductPeriod; label: string } | { error: string } {
  const preset = p?.preset ?? fallback;
  const direct: Record<string, string> = { today: "today", yesterday: "yesterday", last_7_days: "7d", last_30_days: "30d" };
  let period: ProductPeriod;
  if (direct[preset]) period = resolveProductPeriod({ preset: direct[preset] }, now);
  else {
    const g = resolvePeriodArg(p, fallback, now);
    if ("error" in g) return g;
    period = resolveProductPeriod({ preset: "custom", from: g.fromDate, to: g.toDate }, now);
  }
  const range = period.from === period.to ? dmy(period.from) : `${dmy(period.from)} – ${dmy(period.to)}`;
  const name = preset === "today" ? "Hôm nay" : preset === "yesterday" ? "Hôm qua" : preset === "last_7_days" ? "7 ngày đã hoàn tất" : preset === "last_30_days" ? "30 ngày đã hoàn tất" : "Kỳ";
  const label = `${name} (${range}${period.partialToday ? `, đến ${period.hourCutoff ?? 0}h — ngày chưa kết thúc` : ""})`;
  return { period, label };
}

const delta = (d: PaDelta | undefined, fmt: (v: unknown) => string, comparable: boolean) => ({
  current: d ? fmt(d.current) : "không có dữ liệu",
  previous: comparable && d && d.previous !== null ? fmt(d.previous) : null,
  change_pct: comparable && d ? pct(d.pct) : null,
});

function salesFreshness(list: IntelListResult): { updatedAt: string | null; freshness: SourceInfo["freshness"]; caveats: string[]; quality: Record<string, unknown>[] } {
  const caveats: string[] = [];
  const stale = list.shops.filter((s) => s.sales_stale);
  const noData = list.shops.filter((s) => s.sales_state === "no_data" || !s.sales_enabled);
  const partial = list.shops.filter((s) => !s.current_complete && s.sales_state !== "no_data");
  if (noData.length) caveats.push(`${noData.length} shop chưa có dữ liệu doanh số (chưa bật / chưa đồng bộ): không được tính vào tổng, KHÔNG phải bằng 0.`);
  if (partial.length) caveats.push(`${partial.length} shop chưa đồng bộ đủ kỳ này: doanh số là mức tối thiểu (có thể còn thiếu đơn).`);
  if (stale.length) caveats.push(`Dữ liệu doanh số của ${stale.length} shop đã cũ (lần đồng bộ thành công gần nhất quá lâu).`);
  const oldest = list.shops.map((s) => s.sales_last_success_at).filter((v): v is string => !!v).sort()[0] ?? null;
  return {
    updatedAt: oldest,
    freshness: noData.length === list.shops.length ? "unknown" : stale.length ? "stale" : "fresh",
    caveats,
    quality: list.shops.map((s) => ({ shop_id: s.shop_id, sales_state: s.sales_state, complete: s.current_complete, sales_synced_at: vnDateTime(s.sales_last_success_at), stale: s.sales_stale })),
  };
}

const shopArg = nameArg("Tên shop Shopee (tùy chọn; mặc định mọi shop bạn được cấp quyền)").optional();

// ------------------------------------------------------------------ get_shopee_revenue

const salesArgs = z.object({ period: periodArg.optional().describe("Mặc định: hôm nay"), shop: shopArg }).strict();

async function loadSales(args: z.infer<typeof salesArgs>, ctx: ToolContext, fallback: "today" | "last_7_days") {
  const scope = await shopScope(ctx, args.shop);
  if (!scope.ok) return { ok: false as const, result: scope.result };
  const pp = productPeriod(args.period, fallback, ctx.now);
  if ("error" in pp) return { ok: false as const, result: fail("invalid_args", pp.error) };
  const list = await loadIntelligenceList(ctx.db, scope.shops.map((s) => s.id), pp.period, { sort: "priority", pageSize: 1 }, { withSummary: true, top: 5 });
  return { ok: true as const, shops: scope.shops, pp, list };
}

export const getShopeeRevenue: SystemToolDefinition<z.infer<typeof salesArgs>> = {
  name: "get_shopee_revenue",
  title: "Doanh số Shopee",
  description:
    "Doanh số (GMV), số đơn, số sản phẩm bán của các shop Shopee trong kỳ, so với kỳ trước cùng độ dài, kèm định nghĩa chỉ số và độ đầy đủ / thời điểm đồng bộ dữ liệu. Dùng cho: hôm nay / tuần này doanh thu Shopee thế nào.",
  module: "shopee",
  sensitivity: "financial",
  requiredPermissions: ["app:shopee", "channel:view"],
  input: salesArgs,
  timeoutMs: 12_000,
  maxRows: 10,
  freshness: "Đồng bộ định kỳ từ Shopee (đơn hàng theo sản phẩm); hôm nay là số tạm tính đến giờ hiện tại.",
  examples: ["Hôm nay doanh thu Shopee thế nào?", "Doanh số shop X 7 ngày qua?"],
  async run(args, ctx) {
    const r = await loadSales(args, ctx, "today");
    if (!r.ok) return r.result;
    const h = r.list.summary?.hero;
    const fr = salesFreshness(r.list);
    const shopNames = r.shops.map((s) => s.name).join(", ");
    const coverage = `${r.pp.label} · ${r.shops.length} shop (${shopNames})`;
    const source: SourceInfo = { label: "Doanh số Shopee (Phân tích sản phẩm)", origin: "RPC product_intelligence_list (shopee_product_sales_facts)", href: "/shopee/product-analytics", readAt: ctx.now.toISOString(), dataUpdatedAt: fr.updatedAt, freshness: fr.freshness, coverage };
    const scope = { from: r.pp.period.from, to: r.pp.period.to, shop_ids: r.shops.map((s) => s.id) };
    const caveats = [SALES_DEFINITION, ...fr.caveats];
    if (r.pp.period.partialToday) caveats.push("Hôm nay chưa kết thúc: so sánh với cùng khung giờ của kỳ trước.");
    if (!h || h.sales_availability === "no_data") {
      return done({ data: { period: r.pp.label, shops: shopNames, sales_availability: "no_data", data_quality: fr.quality }, lines: [`${coverage}: chưa có dữ liệu doanh số (chưa đồng bộ). Không thể kết luận doanh số = 0.`], source, rowCount: 0, caveats, scope, empty: true });
    }
    const comparable = h.sales_comparable;
    const gmv = delta(h.gmv, vnd, comparable);
    const orders = delta(h.orders, qty, comparable);
    const units = delta(h.units, qty, comparable);
    const availability = h.sales_availability === "complete" ? "đầy đủ" : "mức tối thiểu (dữ liệu chưa đủ kỳ)";
    const lines = [
      `${coverage}: doanh số ${gmv.current}, ${orders.current} đơn, ${units.current} sản phẩm — dữ liệu ${availability}.`,
      comparable ? `So với kỳ trước: doanh số ${gmv.previous} (${gmv.change_pct}), đơn ${orders.previous} (${orders.change_pct}).` : "Không so sánh với kỳ trước vì một trong hai kỳ chưa có đủ dữ liệu.",
      `Dữ liệu doanh số đồng bộ lần gần nhất (shop cũ nhất): ${vnDateTime(fr.updatedAt)}.`,
    ];
    return done({ data: { period: r.pp.label, shops: shopNames, sales_availability: h.sales_availability, sales_gmv: gmv, orders, units, excluded_shops_without_data: h.sales_excluded_shops, data_quality: fr.quality, definitions: [SALES_DEFINITION, ORDERS_DEFINITION] }, lines, source, rowCount: 1, caveats, scope });
  },
};

// ------------------------------------------------------------------ get_shopee_overview

export const getShopeeOverview: SystemToolDefinition<z.infer<typeof salesArgs>> = {
  name: "get_shopee_overview",
  title: "Tổng quan Shopee",
  description:
    "Tổng quan các shop Shopee trong kỳ: doanh số, số đơn, chi tiêu Ads và ROAS của quảng cáo sản phẩm, số sản phẩm cần chú ý và 5 sản phẩm ưu tiên nhất, chất lượng dữ liệu. Dùng cho câu hỏi chung: tình hình Shopee hôm nay / tuần này ra sao.",
  module: "shopee",
  sensitivity: "financial",
  requiredPermissions: ["app:shopee", "channel:view"],
  input: salesArgs,
  timeoutMs: 12_000,
  maxRows: 5,
  freshness: "Doanh số đồng bộ định kỳ; Ads theo lần đọc Shopee Ads gần nhất.",
  examples: ["Tình hình Shopee hôm nay thế nào?", "Tuần này shop có gì cần chú ý?"],
  async run(args, ctx) {
    const r = await loadSales(args, ctx, "today");
    if (!r.ok) return r.result;
    const s = r.list.summary;
    const h = s?.hero;
    const fr = salesFreshness(r.list);
    const shopNames = r.shops.map((x) => x.name).join(", ");
    const coverage = `${r.pp.label} · ${r.shops.length} shop (${shopNames})`;
    const source: SourceInfo = { label: "Tổng quan Shopee (Phân tích sản phẩm)", origin: "RPC product_intelligence_list", href: "/shopee/product-analytics", readAt: ctx.now.toISOString(), dataUpdatedAt: fr.updatedAt, freshness: fr.freshness, coverage };
    const scope = { from: r.pp.period.from, to: r.pp.period.to, shop_ids: r.shops.map((x) => x.id) };
    const caveats = [SALES_DEFINITION, "Chi tiêu Ads / ROAS ở đây chỉ gồm chiến dịch quảng cáo 1 sản phẩm (cách tính của Phân tích sản phẩm); tổng Ads toàn shop xem bằng công cụ hiệu quả quảng cáo.", ...fr.caveats];
    if (!s || !h) return done({ data: { period: r.pp.label, shops: shopNames, products: 0 }, lines: [`${coverage}: chưa có dữ liệu sản phẩm / doanh số.`], source, rowCount: 0, caveats, scope, empty: true });
    const comparable = h.sales_comparable;
    const salesOk = h.sales_availability !== "no_data";
    const top = s.top_attention.slice(0, this.maxRows).map((t) => ({ product: (t.name ?? "(không tên)").slice(0, 70), sku: t.sku, health: t.health.label, sales_gmv: salesOk ? vnd(t.gmv) : "không có dữ liệu", sales_change: t.gmv_pct === null ? "—" : pct(t.gmv_pct), ads_spend: vnd(t.spend), broad_roas: ratio(t.broad_roas) }));
    const data = {
      period: r.pp.label,
      shops: shopNames,
      sales_availability: h.sales_availability,
      sales_gmv: salesOk ? delta(h.gmv, vnd, comparable) : null,
      orders: salesOk ? delta(h.orders, qty, comparable) : null,
      product_ads_spend: delta(h.ads_spend, vnd, h.ads_comparable),
      product_ads_broad_roas: { current: ratio(h.ads_broad_roas.current), previous: h.ads_comparable ? ratio(h.ads_broad_roas.previous) : null },
      products: s.products,
      needs_attention: s.needs_attention,
      sales_declining_products: s.sales_declining,
      sales_growing_products: s.sales_growing,
      top_attention: top,
      data_quality: fr.quality,
    };
    const lines = [
      salesOk ? `${coverage}: doanh số ${data.sales_gmv!.current}${comparable ? ` (${data.sales_gmv!.change_pct} so với kỳ trước)` : ""}, ${data.orders!.current} đơn.` : `${coverage}: chưa có dữ liệu doanh số.`,
      `Quảng cáo sản phẩm: chi ${data.product_ads_spend.current}, ROAS Broad ${data.product_ads_broad_roas.current}.`,
      `${s.products} sản phẩm, ${s.needs_attention} cần chú ý (${s.sales_declining} giảm doanh số, ${s.sales_growing} tăng).`,
      ...(top.length ? ["Ưu tiên chú ý:", ...top.map((t) => `• ${t.product}${t.sku ? ` (${t.sku})` : ""}: ${t.health}, doanh số ${t.sales_gmv} (${t.sales_change}), Ads ${t.ads_spend}, ROAS ${t.broad_roas}.`)] : []),
    ];
    return done({ data, lines, source, rowCount: top.length + 1, caveats, scope });
  },
};

// ------------------------------------------------------------------ get_top_selling_products

const topArgs = z
  .object({
    period: periodArg.optional().describe("Mặc định: 7 ngày đã hoàn tất"),
    shop: shopArg,
    sortBy: z.enum(["gmv", "orders", "units"]).default("gmv").describe("Xếp theo doanh số, số đơn hoặc số sản phẩm"),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export const getTopSellingProducts: SystemToolDefinition<z.infer<typeof topArgs>> = {
  name: "get_top_selling_products",
  title: "Sản phẩm bán chạy Shopee",
  description: "Các sản phẩm Shopee bán chạy nhất trong kỳ, xếp theo doanh số / số đơn / số sản phẩm (tối đa 10), kèm thay đổi so với kỳ trước.",
  module: "shopee",
  sensitivity: "financial",
  requiredPermissions: ["app:shopee", "channel:view"],
  input: topArgs,
  timeoutMs: 12_000,
  maxRows: 10,
  freshness: "Đồng bộ định kỳ từ Shopee (đơn hàng theo sản phẩm).",
  examples: ["Top 5 sản phẩm bán chạy tuần này?", "Sản phẩm nào nhiều đơn nhất hôm qua?"],
  async run(args, ctx) {
    const scope = await shopScope(ctx, args.shop);
    if (!scope.ok) return scope.result;
    const pp = productPeriod(args.period, "last_7_days", ctx.now);
    if ("error" in pp) return fail("invalid_args", pp.error);
    const limit = Math.min(args.limit, this.maxRows, ctx.maxRows);
    const list = await loadIntelligenceList(ctx.db, scope.shops.map((s) => s.id), pp.period, { sort: args.sortBy, dir: "desc", pageSize: limit }, { withSummary: false, top: 0 });
    const fr = salesFreshness(list);
    const shopName = new Map(scope.shops.map((s) => [s.id, s.name]));
    const sortText = { gmv: "doanh số", orders: "số đơn", units: "số sản phẩm" }[args.sortBy];
    const coverage = `${pp.label} · xếp theo ${sortText} · ${scope.shops.length} shop`;
    const source: SourceInfo = { label: "Sản phẩm bán chạy (Phân tích sản phẩm)", origin: "RPC product_intelligence_list", href: "/shopee/product-analytics", readAt: ctx.now.toISOString(), dataUpdatedAt: fr.updatedAt, freshness: fr.freshness, coverage };
    const auditScope = { from: pp.period.from, to: pp.period.to, shop_ids: scope.shops.map((s) => s.id), sort: args.sortBy, limit };
    const rows = list.rows.filter((r) => r.gmv !== null || r.orders !== null);
    const caveats = [SALES_DEFINITION, ...fr.caveats];
    if (rows.some((r) => !r.sales_exact)) caveats.push("Một số sản phẩm có số liệu tối thiểu (shop chưa đồng bộ đủ kỳ).");
    if (!rows.length) return done({ data: { period: pp.label, products: [] }, lines: [`${coverage}: chưa có sản phẩm nào có dữ liệu doanh số.`], source, rowCount: 0, caveats, scope: auditScope, empty: true });
    const products = rows.map((r, i) => ({ rank: i + 1, product: (r.name ?? "(không tên)").slice(0, 80), sku: r.sku, shop: shopName.get(r.shop_id) ?? null, sales_gmv: vnd(r.gmv), orders: qty(r.orders), units: qty(r.units), sales_change: r.gmv_pct === null ? "—" : pct(r.gmv_pct), exact: r.sales_exact }));
    const lines = [`Top ${products.length} sản phẩm ${coverage}:`, ...products.map((p) => `${p.rank}. ${p.product}${p.sku ? ` (${p.sku})` : ""}${scope.shops.length > 1 && p.shop ? ` · ${p.shop}` : ""}: doanh số ${p.sales_gmv}, ${p.orders} đơn, ${p.units} sp (${p.sales_change} so với kỳ trước).`)];
    return done({ data: { period: pp.label, sort_by: args.sortBy, products }, lines, source, rowCount: products.length, caveats, scope: auditScope });
  },
};

// ------------------------------------------------------------------ get_shopee_ads_performance

const adsArgs = z.object({ period: periodArg.optional().describe("Mặc định: hôm nay"), shop: shopArg }).strict();

interface ShopDailyRow {
  shop_id: string;
  report_date: string;
  expense: number | string | null;
  impression: number | string | null;
  clicks: number | string | null;
  direct_order: number | string | null;
  broad_order: number | string | null;
  direct_gmv: number | string | null;
  broad_gmv: number | string | null;
}

export const getShopeeAdsPerformance: SystemToolDefinition<z.infer<typeof adsArgs>> = {
  name: "get_shopee_ads_performance",
  title: "Hiệu quả quảng cáo Shopee",
  description: "Tổng quảng cáo Shopee (toàn bộ quảng cáo CPC của shop) trong kỳ: chi tiêu, hiển thị, nhấp, CTR, CPC, đơn và doanh số Broad / Direct, ROAS, ACOS, thời điểm đọc dữ liệu Ads gần nhất. Chỉ đọc, không thay đổi chiến dịch.",
  module: "shopee",
  sensitivity: "financial",
  requiredPermissions: ["app:shopee", "channel:view"],
  input: adsArgs,
  timeoutMs: 10_000,
  maxRows: 10,
  freshness: "Shopee Ads được đọc định kỳ (tổng shop hôm nay khoảng 20 phút / lần khi bật).",
  examples: ["Quảng cáo Shopee hôm nay chi bao nhiêu?", "ROAS 7 ngày qua thế nào?"],
  async run(args, ctx) {
    if (!ctx.flags.adsRealData) return fail("unavailable", "Dữ liệu quảng cáo thật chưa được bật trong hệ thống (SHOPEE_ADS_DATA_SOURCE chưa là real), nên không có số liệu Ads để trả lời.", { ads_real: false });
    const scope = await shopScope(ctx, args.shop);
    if (!scope.ok) return scope.result;
    const g = resolvePeriodArg(args.period, "today", ctx.now);
    if ("error" in g) return fail("invalid_args", g.error);
    const ids = scope.shops.map((s) => s.id);
    const [{ data, error }, fresh] = await Promise.all([
      ctx.db.from("shopee_ads_shop_daily_performance").select("shop_id, report_date, expense, impression, clicks, direct_order, broad_order, direct_gmv, broad_gmv").in("shop_id", ids).gte("report_date", g.fromDate).lte("report_date", g.toDate).order("report_date").order("shop_id").range(0, 999),
      loadAdsFreshness(ctx.db, ids).catch(() => []),
    ]);
    if (error) throw new ToolReadError("shopee_ads_shop_daily_performance", error.message);
    const rows = (data ?? []) as ShopDailyRow[];
    const shopTodayAt = fresh.map((f) => f.shopTodayAt).filter((v): v is string => !!v).sort()[0] ?? null;
    const stale = !shopTodayAt || ctx.now.getTime() - Date.parse(shopTodayAt) > 25 * 60_000;
    const coverage = `${g.label} · ${scope.shops.length} shop (${scope.shops.map((s) => s.name).join(", ")})`;
    const source: SourceInfo = { label: "Quảng cáo Shopee", origin: "bảng shopee_ads_shop_daily_performance (tổng shop)", href: "/shopee/ads", readAt: ctx.now.toISOString(), dataUpdatedAt: shopTodayAt, freshness: stale ? "stale" : "fresh", coverage };
    const auditScope = { from: g.fromDate, to: g.toDate, shop_ids: ids };
    const caveats = [ADS_ATTRIBUTION];
    if (g.toDate === new Date(ctx.now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10)) caveats.push(`Số của hôm nay là tạm tính đến lần đọc Ads gần nhất (${vnDateTime(shopTodayAt)}).`);
    if (stale) caveats.push("Dữ liệu Ads của hôm nay chưa được đọc trong 25 phút gần đây (có thể đã cũ).");
    const days = new Set(rows.map((r) => r.report_date));
    const missingShops = scope.shops.filter((s) => !rows.some((r) => r.shop_id === s.id));
    if (missingShops.length) caveats.push(`Chưa có số Ads của: ${missingShops.map((s) => s.name).join(", ")} trong kỳ (không tính là 0).`);
    if (!rows.length) return done({ data: { period: g.label, rows: 0 }, lines: [`${coverage}: chưa có số liệu quảng cáo.`], source, rowCount: 0, caveats, scope: auditScope, empty: true });
    const m = deriveMetrics(totalsOf(rows));
    const view = {
      period: g.label,
      days_with_data: days.size,
      spend: vnd(m.spend),
      impressions: qty(m.impressions),
      clicks: qty(m.clicks),
      ctr: m.ctr === null ? "—" : `${ratio((m.ctr ?? 0) * 100)}%`,
      cpc: m.cpc === null ? "—" : vnd(m.cpc),
      broad_orders: qty(m.orders),
      broad_gmv: vnd(m.revenue),
      broad_roas: ratio(m.roas),
      broad_acos: m.acos === null ? "—" : `${ratio((m.acos ?? 0) * 100, 1)}%`,
      direct_orders: qty(m.directOrders),
      direct_gmv: vnd(m.directRevenue),
      direct_roas: ratio(m.directRoas),
    };
    const lines = [
      `Quảng cáo ${coverage}: chi ${view.spend}, ${view.impressions} lượt hiển thị, ${view.clicks} lượt nhấp (CTR ${view.ctr}, CPC ${view.cpc}).`,
      `Broad: ${view.broad_orders} đơn, doanh số ${view.broad_gmv}, ROAS ${view.broad_roas}, ACOS ${view.broad_acos}. Direct: ${view.direct_orders} đơn, doanh số ${view.direct_gmv}, ROAS ${view.direct_roas}.`,
      `Đọc dữ liệu Ads hôm nay lần gần nhất: ${vnDateTime(shopTodayAt)}.`,
    ];
    return done({ data: view, lines, source, rowCount: rows.length, caveats, scope: auditScope });
  },
};

export const SHOPEE_TOOLS = [getShopeeOverview, getShopeeRevenue, getTopSellingProducts, getShopeeAdsPerformance] as const;
