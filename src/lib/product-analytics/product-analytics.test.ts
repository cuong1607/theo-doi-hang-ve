// ============================================================
// PRODUCT-ANALYTICS-2 — pure tests (no DB):
//   node --test src/lib/product-analytics/product-analytics.test.ts
// status semantics · order → fact mapping (privacy whitelist, line identity,
// Decimal strings, VN report date) · periods / same-time · signals (facts only)
// · data quality · list search · product phrase resolution · read-only
// allowlist · scheduler planning · static guards (no organic = total − Ads,
// no SQL tool, no legacy job re-enabled).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { classifyProductSalesOrderStatus, PRODUCT_SALES_STATUS_TABLE } from "./sales-status.ts";
import { mapOrderToSalesFacts, productSalesReportDate, PRODUCT_SALES_FACT_KEYS, providerId } from "./sales-facts.ts";
import { resolveProductPeriod } from "./periods.ts";
import { deltaTone, describeSignal, HEALTH_LABELS, HEALTH_TEXT, healthRuleText, priorityExplain, PRIORITY_TEXT, signalTone } from "./signals.ts";
import { buildProductDataQuality } from "./data-quality.ts";
import { ATTRIBUTION_INDICATOR_LABEL, ATTRIBUTION_INDICATOR_TOOLTIP, formatAge, formatPct, formatSalesValue, salesAvailability } from "./display.ts";
import { salesComparable, salesCoverage, salesCoverageNote, salesExact } from "./coverage.ts";
import { getProductAnalyticsSyncConfig, intelligenceConfigJson, PRODUCT_ANALYTICS_PRIORITY } from "./config.ts";
import { parseProductAnalyticsQuery } from "./url-state.ts";
import type { PaDelta, ProductSummary, ShopFreshnessRow } from "./types.ts";
import { resolveProductPhrase } from "../conversation/service.ts";
import { isProductSalesReadRequest, PRODUCT_SALES_READ_ENDPOINTS } from "../channels/shopee/product-analytics/read-only-policy.ts";
import { parseExtraInfo, parseSalesOrderListPage, planSalesWindows } from "../channels/shopee/product-analytics/sales-sync.ts";
import { planProductAnalyticsShop } from "../channels/shopee/product-analytics/sales-schedule.ts";
import { activeProductAnalyticsSyncTypes, activeSyncTypes, retiredSyncTypes } from "../channels/core/sync-domains.ts";
import { getShopeeFlags } from "../feature-flags.ts";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");

function order(over: Record<string, unknown> = {}, lines?: Array<Record<string, unknown>>) {
  return {
    order_sn: "2610290ABCDEF",
    order_status: "SHIPPED",
    create_time: 1761757200, // 2025-10-29T17:00:00Z = 2025-10-30 00:00 VN
    update_time: 1761760800,
    pay_time: 1761757300,
    currency: "VND",
    total_amount: 999999,
    message_to_seller: "giao giờ hành chính, gọi 0901234567",
    recipient_address: { name: "Nguyễn Văn A", phone: "0901234567", full_address: "1 Lê Lợi" },
    buyer_username: "buyer_x",
    buyer_user_id: 123456,
    item_list: lines ?? [
      { line_item_id: 9001, order_item_id: 77, item_id: 111, model_id: 222, model_quantity_purchased: 2, cancelled_qty: 0, returned_qty: 0, model_original_price: 250000, model_discounted_price: 199999.5, item_name: "Thảm lông xù", item_sku: "TLX-01", promotion_type: "product_promotion_VN", image_info: { image_url: "https://cf.shopee.vn/file/abcDEF_1" } },
    ],
    ...over,
  };
}

// ------------------------------------------------------------------ status semantics

test("PA2 / §10. classifyProductSalesOrderStatus: explicit mapping, no paid/confirmed guess", () => {
  const counted = PRODUCT_SALES_STATUS_TABLE.filter((r) => r.counted).map((r) => r.status).sort();
  assert.deepEqual(counted, ["COMPLETED", "PROCESSED", "READY_TO_SHIP", "RETRY_SHIP", "SHIPPED", "TO_CONFIRM_RECEIVE", "TO_RETURN"]);
  assert.deepEqual(classifyProductSalesOrderStatus("UNPAID"), { statusClass: "pending_payment", isValidForSales: false, isCancelled: false, isCompleted: false });
  assert.deepEqual(classifyProductSalesOrderStatus("CANCELLED"), { statusClass: "cancelled", isValidForSales: false, isCancelled: true, isCompleted: false });
  assert.equal(classifyProductSalesOrderStatus("IN_CANCEL").isValidForSales, false, "cancellation requested → conservative");
  assert.equal(classifyProductSalesOrderStatus("COMPLETED").isCompleted, true);
  assert.equal(classifyProductSalesOrderStatus("TO_RETURN").isValidForSales, true, "gross: returns are not netted");
  assert.equal(classifyProductSalesOrderStatus("SOMETHING_NEW").statusClass, "unknown");
  assert.equal(classifyProductSalesOrderStatus("SOMETHING_NEW").isValidForSales, false);
  assert.equal(classifyProductSalesOrderStatus(null).statusClass, "unknown");
});

// ------------------------------------------------------------------ mapping

test("PA2 / §7 §70. privacy: fact rows carry ONLY whitelisted keys — no buyer name / phone / address / message", () => {
  const r = mapOrderToSalesFacts(order());
  assert.ok("rows" in r);
  for (const row of r.rows) assert.deepEqual(Object.keys(row).sort(), [...PRODUCT_SALES_FACT_KEYS].sort());
  const text = JSON.stringify(r);
  for (const pii of ["0901234567", "Nguyễn Văn A", "Lê Lợi", "buyer_x", "123456", "giao giờ", "message_to_seller", "recipient"]) assert.ok(!text.includes(pii), `leaked ${pii}`);
});

test("PA2 / §66 §67. money stays a Decimal STRING (no JS float math); unit price kept exactly", () => {
  const r = mapOrderToSalesFacts(order());
  assert.ok("rows" in r);
  assert.equal(r.rows[0].unit_discounted_price, "199999.5");
  assert.equal(r.rows[0].unit_original_price, "250000");
  assert.equal(typeof r.rows[0].unit_discounted_price, "string");
  const bad = mapOrderToSalesFacts(order({}, [{ line_item_id: 1, item_id: 111, model_quantity_purchased: 1, model_discounted_price: 1e21 }]));
  assert.ok("rows" in bad && bad.rows[0].unit_discounted_price === null, "non round-trip number → null, never approximated");
});

test("PA2 / §66. multi-item order, same item twice (gift line), missing model id → one row per line_item_id", () => {
  const r = mapOrderToSalesFacts(
    order({}, [
      { line_item_id: 1, item_id: 111, model_id: 222, model_quantity_purchased: 3, model_discounted_price: 100000 },
      { line_item_id: 2, item_id: 111, model_id: 222, model_quantity_purchased: 1, model_discounted_price: 0, promotion_type: "add_on_free_gift_sub" },
      { line_item_id: 3, item_id: 333, model_id: 0, model_quantity_purchased: 1, model_discounted_price: 50000 },
    ]),
  );
  assert.ok("rows" in r);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows.map((x) => x.provider_line_item_id), ["1", "2", "3"]);
  assert.equal(r.rows[0].quantity, 3);
  assert.equal(r.rows[1].is_free_gift, true);
  assert.equal(r.rows[2].provider_model_id, null, "model_id 0 = no variation");
});

test("PA2 / §66. invalid line → the WHOLE order is an issue (totals never silently partial); duplicate line id refused", () => {
  const missing = mapOrderToSalesFacts(order({}, [{ line_item_id: 1, item_id: 111, model_quantity_purchased: 1 }, { item_id: 112, model_quantity_purchased: 1 }]));
  assert.ok("issue" in missing && /line_item_id/.test(missing.issue.reason));
  const dup = mapOrderToSalesFacts(order({}, [{ line_item_id: 5, item_id: 1, model_quantity_purchased: 1 }, { line_item_id: 5, item_id: 2, model_quantity_purchased: 1 }]));
  assert.ok("issue" in dup && /trùng/.test(dup.issue.reason));
  assert.ok("issue" in mapOrderToSalesFacts(order({ create_time: 0 })));
  assert.ok("issue" in mapOrderToSalesFacts({ order_status: "SHIPPED" }));
});

test("PA2 / §16 §66. report date = VN business date (cross-midnight UTC does not shift the day)", () => {
  // 2026-10-30 16:59:59Z = 23:59:59 VN on 30/10 ; 17:00:00Z = 00:00 VN on 31/10
  assert.equal(productSalesReportDate("2026-10-30T16:59:59Z"), "2026-10-30");
  assert.equal(productSalesReportDate("2026-10-30T17:00:00Z"), "2026-10-31");
  const r = mapOrderToSalesFacts(order({ create_time: Date.parse("2026-10-30T17:30:00Z") / 1000 }));
  assert.ok("rows" in r && productSalesReportDate(r.rows[0].order_created_at) === "2026-10-31");
});

test("PA2. provider ids: numbers beyond 2^53 refused (precision already lost), strings kept exact", () => {
  assert.equal(providerId(12345), "12345");
  assert.equal(providerId("98765432109876543"), "98765432109876543");
  assert.equal(providerId(2 ** 60), null);
  assert.equal(providerId(0, { zeroIsNull: true }), null);
  assert.equal(providerId(-1), null);
});

test("PA2. cancelled quantity: partial cancel reduces counted quantity source; cancelled order flags", () => {
  const r = mapOrderToSalesFacts(order({ order_status: "CANCELLED" }, [{ line_item_id: 1, item_id: 1, model_quantity_purchased: 2, cancelled_qty: 2, model_discounted_price: 1000 }]));
  assert.ok("rows" in r);
  assert.equal(r.rows[0].is_cancelled, true);
  assert.equal(r.rows[0].is_valid_for_sales, false);
  assert.equal(r.rows[0].cancelled_qty, 2);
  const over = mapOrderToSalesFacts(order({}, [{ line_item_id: 1, item_id: 1, model_quantity_purchased: 2, cancelled_qty: 9 }]));
  assert.ok("rows" in over && over.rows[0].cancelled_qty === 2, "never more than purchased");
});

// ------------------------------------------------------------------ periods / same-time

test("PA2 / §35 §40 §41. periods: 7d / 30d = completed days; today = same completed hour; custom including today flagged partial", () => {
  const now = new Date("2026-10-30T08:20:00Z"); // 15:20 VN
  const d7 = resolveProductPeriod({ preset: "7d" }, now);
  assert.deepEqual([d7.from, d7.to, d7.prevFrom, d7.prevTo, d7.partialToday], ["2026-10-23", "2026-10-29", "2026-10-16", "2026-10-22", false]);
  const d30 = resolveProductPeriod({ preset: "30d" }, now);
  assert.deepEqual([d30.from, d30.to, d30.prevTo], ["2026-09-30", "2026-10-29", "2026-09-29"]);
  const today = resolveProductPeriod({ preset: "today" }, now);
  assert.deepEqual([today.from, today.prevFrom, today.partialToday, today.hourCutoff], ["2026-10-30", "2026-10-29", true, 15]);
  const custom = resolveProductPeriod({ preset: "custom", from: "2026-10-25", to: "2026-11-05" }, now);
  assert.deepEqual([custom.to, custom.partialToday, custom.hourCutoff, custom.prevFrom, custom.prevTo], ["2026-10-30", true, null, "2026-10-19", "2026-10-24"]);
  const midnight = resolveProductPeriod({ preset: "today" }, new Date("2026-10-29T17:10:00Z"));
  assert.equal(midnight.hourCutoff, 0);
});

// ------------------------------------------------------------------ signals + quality

const D = (current: number | null, previous: number | null): PaDelta => ({ current, previous, abs: current !== null && previous !== null ? current - previous : null, pct: current !== null && previous ? Math.round(((current - previous) / previous) * 10_000) / 100 : null });

function summary(over: Partial<{ gmv: PaDelta; orders: PaDelta; spend: PaDelta; roas: PaDelta; clicks: PaDelta; campaigns: number; prevRows: number | null }> = {}): ProductSummary {
  const z = D(0, 0);
  return {
    identity: { product_id: "p", shop_id: "s", provider_item_id: "1", name: "x", sku: null, image_url: null, provider_status: "NORMAL", metadata_source: "ads_enrichment", metadata_updated_at: null },
    period: { from: "2026-10-23", to: "2026-10-29", prev_from: "2026-10-16", prev_to: "2026-10-22", hour_cutoff: null },
    sales: { gmv: over.gmv ?? z, orders: over.orders ?? z, units: z, cancelled_orders: z, fact_lines: 0 },
    ads: { single_item_campaigns: over.campaigns ?? 1, shared_campaigns_excluded: 0, spend: over.spend ?? z, impressions: z, clicks: over.clicks ?? z, direct_order: z, broad_order: z, direct_gmv: z, broad_gmv: z, cpc: z, ctr: z, direct_roas: z, broad_roas: over.roas ?? z, direct_cvr: z, broad_cvr: z, broad_gmv_to_sales_indicator: z, fact_rows: 7, previous_fact_rows: over.prevRows ?? null },
    snapshot: null,
  };
}

const FRESH: ShopFreshnessRow = { shop_id: "s", sales_enabled: true, extra_info_enabled: false, sales_last_success_at: "2026-10-30T08:00:00Z", sales_backfill_done_at: "2026-10-29T00:00:00Z", sales_active_jobs: 0, fact_lines: 10, first_report_date: "2026-09-30", last_report_date: "2026-10-30", last_order_created_at: null, extra_info_last_captured_at: null, products: 3, ads_campaign_today_at: "2026-10-30T08:10:00Z" };
const NOW = new Date("2026-10-30T08:20:00Z");

test("PA3 / §14 §25 §53. signal wording is factual: 'Doanh số giảm 21%', never a cause", () => {
  assert.equal(describeSignal({ metric: "sales_gmv", direction: "down", change_pct: -21.04 }), "Doanh số giảm 21%");
  assert.equal(describeSignal({ metric: "ads_cpc", direction: "up", change_pct: 12.5 }), "CPC tăng 12,5%");
  assert.match(describeSignal({ metric: "sales_gmv", direction: "flat", change_pct: -3 }), /ổn định/);
  const texts = [...HEALTH_LABELS.map((h) => HEALTH_TEXT[h]), ...(["no_comparable_data", "low_volume", "sales_and_efficiency_down", "sales_down_sharply", "warning_signals", "multiple_notices", "sales_growing", "no_significant_change"] as const).map((r) => healthRuleText(r))];
  for (const t of texts) {
    assert.ok(t.length > 0);
    assert.ok(!/do quảng cáo|vì quảng cáo|Ads gây|Ads tạo ra|nguyên nhân là|caused|thị trường/i.test(t), `no causal / market claim: ${t}`);
  }
  assert.equal(Object.keys(HEALTH_TEXT).length, 5);
  assert.deepEqual(HEALTH_LABELS.map((h) => HEALTH_TEXT[h]), ["Tốt", "Ổn định", "Cần theo dõi", "Yếu", "Chưa đủ dữ liệu"]);
});

test("PA3 / §49. semantic colour: CPC down is good, spend is neutral, sales down is bad — never 'negative = red'", () => {
  assert.equal(deltaTone("ads_cpc", -20), "good");
  assert.equal(deltaTone("ads_cpc", 20), "bad");
  assert.equal(deltaTone("ads_spend", -40), "neutral");
  assert.equal(deltaTone("ads_spend", 40), "neutral");
  assert.equal(deltaTone("sales_gmv", -15), "bad");
  assert.equal(deltaTone("ads_broad_roas", 15), "good");
  assert.equal(deltaTone("sales_gmv", 1), "neutral", "tiny moves stay neutral");
  assert.equal(deltaTone("cancelled_orders", 30), "bad");
  assert.equal(signalTone({ polarity: "negative", severity: "WARNING" }), "bad");
  assert.equal(signalTone({ polarity: "negative", severity: "NOTICE" }), "warning");
  assert.equal(signalTone({ polarity: "positive", severity: "INFO" }), "good");
  assert.equal(signalTone({ polarity: "neutral", severity: "INFO" }), "neutral");
});

test("PA3 / §27 §48. priority is explained, never a bare number", () => {
  const t = priorityExplain({ score: 76, level: "MEDIUM", signal_points: 28, scale_points: 17, business_vnd: 55_000_000, confidence: "HIGH" });
  assert.match(t, /76 điểm = 28 điểm tín hiệu bất lợi × \(1 \+ 17\/10 quy mô\) × 1/);
  assert.equal(PRIORITY_TEXT.HIGH, "Ưu tiên cao");
});

test("PA3 / §18. every threshold the SQL engine requires is in config.ts (one place)", () => {
  const sql = readFileSync(path.join(SRC, "..", "supabase/migrations/00071_product_intelligence.sql"), "utf8");
  const required = [...sql.match(/k_required constant text\[\] := ARRAY\[([^\]]+)\]/)![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(required.length >= 20);
  const cfg = intelligenceConfigJson();
  for (const k of [...required, "backfill_days", "sales_stale_minutes", "ads_stale_minutes"]) assert.equal(typeof cfg[k], "number", `config key ${k}`);
  // the engine SQL has no movement threshold of its own (they all come through p_cfg)
  const engine = sql.slice(sql.indexOf("CREATE FUNCTION public.pa_intelligence_eval"), sql.indexOf("-- C. per-shop context"));
  assert.ok(!/\b(15|20|30|50|500000|100000)\b/.test(engine.replace(/--.*$/gm, "")), "no magic threshold inside pa_intelligence_eval");
});

test("PA2 / §39 §40. data quality: stale → DATA_STALE; partial today without same-time → no comparison signals; warnings explicit", () => {
  const s = summary({ gmv: D(1_000_000, 5_000_000) });
  const stale = buildProductDataQuality({ now: NOW, freshness: { ...FRESH, sales_last_success_at: "2026-10-29T00:00:00Z" }, summary: s, partialToday: false, hourCutoff: null });
  assert.equal(stale.sales_freshness.stale, true);
  const partial = buildProductDataQuality({ now: NOW, freshness: FRESH, summary: s, partialToday: true, hourCutoff: null });
  assert.equal(partial.same_time_comparison.sales_available, false);
  const today = buildProductDataQuality({ now: NOW, freshness: FRESH, summary: summary({ prevRows: 0 }), partialToday: true, hourCutoff: 15 });
  assert.equal(today.same_time_comparison.applied, true);
  assert.equal(today.same_time_comparison.ads_available, false, "no hourly Ads rows of yesterday → Ads same-time unavailable");
  assert.ok(today.semantic_warnings.some((w) => /15:00/.test(w)));
  const none = buildProductDataQuality({ now: NOW, freshness: null, summary: s, partialToday: false, hourCutoff: null });
  assert.ok(none.missing_sources.includes("sales"));
  assert.ok(none.semantic_warnings.some((w) => /attribution/i.test(w)));
});

test("PA2P / §34. missing data is not zero: coverage per period; no sales % / signal without both periods covered", () => {
  const p7 = resolveProductPeriod({ preset: "7d" }, NOW); // 10-23..10-29, prev from 10-16
  const p30 = resolveProductPeriod({ preset: "30d" }, NOW); // 09-30..10-29, prev from 08-31
  // never read
  assert.deepEqual(salesCoverage(null, p7), { state: "no_data", covered_from: null, current_complete: false, previous_complete: false });
  // only manual 48 h reads, no backfill (production state on 2026-10-31)
  const manual = salesCoverage({ sales_last_success_at: "2026-10-31T01:20:00Z", sales_backfill_done_at: null }, p7);
  assert.equal(manual.state, "not_backfilled");
  assert.equal(salesExact(manual) || salesComparable(manual), false);
  // backfill finished 2026-10-29 07:00 VN → covered from 2026-09-29
  const c7 = salesCoverage(FRESH, p7);
  assert.deepEqual([c7.covered_from, salesExact(c7), salesComparable(c7)], ["2026-09-29", true, true]);
  const c30 = salesCoverage(FRESH, p30);
  assert.deepEqual([salesExact(c30), salesComparable(c30)], [true, false], "30d previous period is older than the backfill");
  assert.match(salesCoverageNote(c30)!, /không tính % thay đổi/);
  assert.equal(salesCoverageNote(c7), null);
  for (const period of [p30, p7]) {
    const fresh = period === p30 ? FRESH : { ...FRESH, sales_backfill_done_at: null };
    const q = buildProductDataQuality({ now: NOW, freshness: fresh, summary: summary({ gmv: D(5_000_000, 600_000) }), partialToday: false, hourCutoff: null, period });
    assert.ok(q.semantic_warnings.length > 0 && q.sales_coverage.previous_complete === false);
  }
  // (signal suppression without coverage + SQL Δ clearing: product-intelligence.integration.test.ts)
});

// ------------------------------------------------------------------ display rules (PA-3)

test("PA3 / §34. display: no data → '—', not covered → '≥ x', exact otherwise; never a fabricated 0", () => {
  const f = (n: number | null) => (n === null ? "—" : String(n));
  assert.equal(formatSalesValue(1_000, "no_data", f), "—");
  assert.equal(formatSalesValue(null, "complete", f), "—");
  assert.equal(formatSalesValue(1_000, "lower_bound", f), "≥ 1000");
  assert.equal(formatSalesValue(0, "lower_bound", f), "—", "a lower bound of 0 says nothing");
  assert.equal(formatSalesValue(0, "complete", f), "0", "covered + no orders = a real 0");
  assert.equal(salesAvailability({ sales_state: "no_data", sales_exact: false }), "no_data");
  assert.equal(salesAvailability({ sales_state: "not_backfilled", sales_exact: false }), "lower_bound");
  assert.equal(salesAvailability({ sales_state: "covered", sales_exact: true }), "complete");
  assert.equal(formatPct(-21.04), "−21%");
  assert.equal(formatPct(12.5), "+12,5%");
  assert.equal(formatAge(12), "12 phút trước");
  assert.equal(formatAge(null), "chưa có");
});

test("PA3 / §10 §77. attribution indicator: exact label + tooltip; never 'contribution' / 'sales share' / 'organic remainder'", () => {
  assert.equal(ATTRIBUTION_INDICATOR_LABEL, "Ads attribution / total sales indicator");
  assert.match(ATTRIBUTION_INDICATOR_TOOLTIP, /This compares Shopee Ads attribution GMV against product sales facts\. It is NOT a sales-share percentage and may exceed 100%\./);
  const files = [...walk(path.join(SRC, "lib/product-analytics")), ...walk(path.join(SRC, "components/product-analytics")), ...walk(path.join(SRC, "app/(authenticated)/shopee/product-analytics"))];
  for (const f of files) {
    const code = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/Ads contribution|Ads sales share|organic remainder|doanh số tự nhiên\s*=|Ads tạo ra \d|Ads generated/i.test(code), `${f}: forbidden attribution wording`);
  }
});

test("PA2 / §51. Zalo product phrase → canonical product of THAT shop only; ambiguous → null", () => {
  const c = [
    { id: "p1", itemId: "111", name: "Thảm lông xù cao cấp", sku: "TLX-01" },
    { id: "p2", itemId: "222", name: "Thảm trải sàn", sku: "TTS" },
  ];
  assert.equal(resolveProductPhrase("tham long xu", c), "p1");
  assert.equal(resolveProductPhrase("TLX-01", c), "p1");
  assert.equal(resolveProductPhrase("222", c), null, "short digit run is not treated as an item id");
  assert.equal(resolveProductPhrase("111", c), null);
  assert.equal(resolveProductPhrase("22222", [...c, { id: "p3", itemId: "22222", name: "x", sku: null }]), "p3", "exact item id of this shop");
  assert.equal(resolveProductPhrase("99999", c), null, "item id not in this shop (maybe another shop's) → null");
  assert.equal(resolveProductPhrase("thảm", c), null, "ambiguous");
  assert.equal(resolveProductPhrase("chăn", c), null, "unknown");
});

test("PA2 / PA3 §34 §35 §36. URL state: defaults (priority sort, 50 rows), sanitising, health / signal filters", () => {
  const s = parseProductAnalyticsQuery({ shop: "not-a-uuid", ads: "maybe", sort: "drop table", page: "-3", health: "BAD", signal: "x;--", size: "1000" }, NOW);
  assert.equal(s.shop, "all");
  assert.equal(s.list.ads, "all");
  assert.equal(s.list.sort, "priority");
  assert.equal(s.list.page, 1);
  assert.equal(s.list.pageSize, 50);
  assert.equal(s.list.health, "all");
  assert.equal(s.list.signal, "all");
  assert.equal(s.period.preset, "7d");
  const ok = parseProductAnalyticsQuery({ health: "ATTENTION", signal: "ADS_ROAS_DOWN", sort: "roas_pct", dir: "asc", page: "3", size: "25" }, NOW);
  assert.deepEqual([ok.list.health, ok.list.signal, ok.list.sort, ok.list.dir, ok.list.page, ok.list.pageSize], ["ATTENTION", "ADS_ROAS_DOWN", "roas_pct", "asc", 3, 25]);
});

// ------------------------------------------------------------------ read-only + scheduling

test("PA2 / §5 §22. reader allowlist: exactly the verified order reads + extra info, GET only, no write path", () => {
  assert.deepEqual(Object.values(PRODUCT_SALES_READ_ENDPOINTS).sort(), ["/api/v2/order/get_order_detail", "/api/v2/order/get_order_list", "/api/v2/product/get_item_extra_info"]);
  for (const p of Object.values(PRODUCT_SALES_READ_ENDPOINTS)) {
    assert.equal(isProductSalesReadRequest("GET", p), true);
    assert.equal(isProductSalesReadRequest("POST", p), false);
  }
  for (const p of ["/api/v2/order/cancel_order", "/api/v2/order/set_note", "/api/v2/product/update_item", "/api/v2/order/get_buyer_invoice_info", "/api/v2/order/handle_buyer_cancellation"]) assert.equal(isProductSalesReadRequest("GET", p), false, p);
  const reader = readFileSync(path.join(SRC, "lib/channels/shopee/product-analytics/sales-reader.ts"), "utf8");
  assert.ok(!/recipient_address|buyer_user|buyer_username|invoice/.test(reader.replace(/\/\/.*$/gm, "")), "no buyer field requested");
  assert.match(reader, /PRODUCT_SALES_DETAIL_FIELDS = "item_list,pay_time"/);
});

test("PA2 / §17 §18 §19. windows: backfill = 30 completed days + today by create_time; hot/cold by update_time (overlap)", () => {
  const cfg = getProductAnalyticsSyncConfig({});
  const now = new Date("2026-10-30T08:00:00Z");
  const b = planSalesWindows("backfill", now, cfg);
  assert.equal(b.field, "create_time");
  assert.equal(b.windows[0].from, Date.parse("2026-09-30T00:00:00+07:00") / 1000);
  assert.equal(b.windows.at(-1)!.to, now.getTime() / 1000);
  for (const w of b.windows) assert.ok(w.to - w.from <= 15 * 86400, "≤ 15 days per request");
  const h = planSalesWindows("hot", now, cfg);
  assert.equal(h.field, "update_time");
  assert.equal(h.windows[0].to - h.windows[0].from, 48 * 3600);
  assert.equal(planSalesWindows("cold", now, cfg).windows.reduce((a, w) => a + (w.to - w.from), 0), 8 * 86400);
});

test("PA2 / §20 §21. scheduler: flags OFF → nothing; backfill before COLD; priorities below Ads HOT (2–5)", () => {
  const off = getProductAnalyticsSyncConfig({});
  assert.equal(off.salesSyncEnabled, false);
  assert.equal(off.extraInfoSyncEnabled, false);
  const now = new Date("2026-10-30T09:10:00Z"); // 16:10 VN (after the 16:00 COLD slot)
  assert.deepEqual(planProductAnalyticsShop({ now, offsetMinutes: 0, config: off, state: { salesEnabled: true, extraInfoEnabled: true, backfillDone: false, slots: {} } }), []);
  const on = getProductAnalyticsSyncConfig({ PRODUCT_SALES_SYNC_ENABLED: "true", PRODUCT_EXTRA_INFO_SYNC_ENABLED: "true" });
  const first = planProductAnalyticsShop({ now, offsetMinutes: 0, config: on, state: { salesEnabled: true, extraInfoEnabled: false, backfillDone: false, slots: {} } });
  assert.deepEqual(first.map((s) => s.kind).sort(), ["backfill", "hot"]);
  const later = planProductAnalyticsShop({ now, offsetMinutes: 0, config: on, state: { salesEnabled: true, extraInfoEnabled: true, backfillDone: true, slots: {} } });
  assert.deepEqual(later.map((s) => s.kind).sort(), ["cold", "extra", "hot"]);
  const again = planProductAnalyticsShop({ now, offsetMinutes: 0, config: on, state: { salesEnabled: true, extraInfoEnabled: true, backfillDone: true, slots: Object.fromEntries(later.map((s) => [s.column, s.slotAt.toISOString()])) } });
  assert.deepEqual(again, [], "a claimed slot is never planned twice");
  assert.ok(Object.values(PRODUCT_ANALYTICS_PRIORITY).every((p) => p > 5), "below every Ads daily / hourly HOT priority");
  assert.deepEqual(activeProductAnalyticsSyncTypes(off), []);
  assert.deepEqual(activeProductAnalyticsSyncTypes(on), ["product_sales_facts_read", "product_extra_info_read"]);
});

test("PA2 / §1. legacy modules stay retired: new types are NOT legacy, legacy types still not runnable by default", () => {
  const flags = getShopeeFlags({});
  assert.deepEqual(activeSyncTypes(flags), [], "SHOPEE_LEGACY_MODULES_ENABLED default false");
  assert.ok(retiredSyncTypes(flags).includes("order") && retiredSyncTypes(flags).includes("product"));
  assert.ok(!(retiredSyncTypes(flags) as string[]).includes("product_sales_facts_read"));
  const route = readFileSync(path.join(SRC, "app/api/internal/shopee/sync-scheduler/route.ts"), "utf8");
  assert.ok(!/SHOPEE_AUTO_SYNC_ENABLED\s*=\s*true|legacyModulesEnabled\s*=\s*true/.test(route));
  const sync = readFileSync(path.join(SRC, "lib/channels/shopee/product-analytics/sales-sync.ts"), "utf8");
  assert.ok(!/order-sync|order-provider|ShopeeOrderSyncService|sync_type:\s*"order"/.test(sync), "no legacy order module reused");
});

test("PA2. parsers: list page cursor / extra info values as returned", () => {
  assert.deepEqual(parseSalesOrderListPage({ error: "", response: { more: true, next_cursor: "abc", order_list: [{ order_sn: "A" }, { order_sn: "A" }, { order_sn: "B" }] } }), { orderSns: ["A", "B"], more: true, nextCursor: "abc" });
  assert.throws(() => parseSalesOrderListPage({ error: "error_auth", message: "x" }));
  assert.deepEqual(parseExtraInfo({ error: "", response: { item_list: [{ item_id: 5, sale: 10, views: 3, likes: 1, rating_star: 4.876, comment_count: 2 }, { item_id: "bad" }] } }), [{ provider_item_id: "5", sale: 10, views: 3, likes: 1, rating_star: 4.88, comment_count: 2 }]);
});

// ------------------------------------------------------------------ static guards

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|sql)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

test("PA2 / §32 §69. ATTRIBUTION GUARD: nothing computes organic = total − broad Ads (code + SQL)", () => {
  const files = [
    ...walk(path.join(SRC, "lib/product-analytics")),
    ...walk(path.join(SRC, "components/product-analytics")),
    ...walk(path.join(SRC, "app/(authenticated)/shopee/product-analytics")),
    path.join(SRC, "..", "supabase/migrations/00070_shopee_product_analytics.sql"),
    path.join(SRC, "..", "supabase/migrations/00071_product_intelligence.sql"),
  ];
  for (const f of files) {
    const code = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/--.*$/gm, "");
    assert.ok(!/organic\w*\s*[:=]/i.test(code), `${f}: organic metric defined`);
    assert.ok(!/(gmv|sales|orders)\w*\s*-\s*\w*broad/i.test(code), `${f}: total − broad Ads`);
    assert.ok(!/(gmv|sales|orders)\w*\s*-\s*\w*(ads|direct)_?(gmv|order)/i.test(code), `${f}: total − Ads`);
  }
});

test("PA2 / §54. no arbitrary SQL tool, no SQL text in agent tool module", () => {
  const tools = readFileSync(path.join(SRC, "lib/product-analytics/agent-tools.ts"), "utf8");
  assert.ok(!/execute_sql|raw_query|run_sql|\.rpc\("(?!product_analytics_)/.test(tools));
  assert.ok(!/\bselect\s+\*|\binsert\s+into|\bdelete\s+from/i.test(tools), "no SQL strings");
});
