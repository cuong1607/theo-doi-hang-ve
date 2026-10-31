// ============================================================
// PRODUCT-ANALYTICS-3 — signal engine, health, priority and the paginated
// intelligence RPCs against the LOCAL database (migration 00071):
//
//   node --env-file=.env.local --test src/lib/product-analytics/product-intelligence.integration.test.ts
//
//   §75 signals   missing comparison, tiny denominator, large-scale decline, small product
//                 extreme %, partial today, stale data, Ads missing, Sales missing
//   §76 health    every label reachable, each with rule + confidence + signals
//   §77 attrib.   Broad GMV / sales = 500 % → no contribution / organic anywhere
//   §28 priority  tiny product −80 % ROAS ranks below a large product with smaller moves
//   §78 paging    boundaries, search + paging (accent-insensitive), sort + paging,
//                 filter + paging, authorization (shop scope, no anon / authenticated EXECUTE)
//   §80           reads write nothing (no job, no snapshot) — 0 provider calls
// Test shops are created and deleted here; nothing else is touched.
// ============================================================
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { upsertProductSalesFacts } from "../channels/shopee/product-analytics/sales-sync.ts";
import { addDays } from "../analytics/periods.ts";
import { intelligenceConfigJson, PRODUCT_INTELLIGENCE_CONFIG } from "./config.ts";
import { salesCoverage } from "./coverage.ts";
import { loadIntelligenceDetail, loadIntelligenceList, loadSignalSummary, type IntelListRow } from "./intelligence.ts";
import { resolveProductPeriod } from "./periods.ts";
import { mapOrderToSalesFacts, type ProductSalesFactRow } from "./sales-facts.ts";
import type { ProductIntel } from "./signals.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("Test tích hợp Product Intelligence chỉ chạy với DB local.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `pa3${Date.now()}`;
const CFG = intelligenceConfigJson();
const shopIds: string[] = [];
const period = resolveProductPeriod({ preset: "7d" });

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
});

// ------------------------------------------------------------------ engine (pure SQL function)

type M = Partial<Record<"gmv1" | "gmv0" | "orders1" | "orders0" | "units1" | "units0" | "spend1" | "spend0" | "impressions1" | "impressions0" | "clicks1" | "clicks0" | "broad_order1" | "broad_order0" | "broad_gmv1" | "broad_gmv0" | "campaigns", number | null>>;
const CTX_OK = {
  sales_state: "covered",
  covered_from: "2026-10-01",
  sales_current_complete: true,
  sales_previous_complete: true,
  sales_comparable: true,
  ads_comparable: true,
  same_time_ok: true,
  partial_today: false,
  hour_cutoff: null,
  sales_stale: false,
  ads_stale: false,
  ads_missing: false,
  has_snapshot: false,
};

async function evalIntel(m: M, ctx: Record<string, unknown> = {}, cfg: Record<string, unknown> = CFG): Promise<ProductIntel> {
  const { data, error } = await db.rpc("pa_intelligence_eval", { p_m: m, p_ctx: { ...CTX_OK, ...ctx }, p_cfg: cfg });
  if (error) throw new Error(error.message);
  return data as ProductIntel;
}

const types = (i: ProductIntel) => i.signals.map((s) => s.type);
const dq = (i: ProductIntel) => i.data_quality.map((s) => s.type);
const sig = (i: ProductIntel, t: string) => i.signals.find((s) => s.type === t);
const BIG = { orders1: 300, orders0: 420, units1: 330, units0: 460 };
/** large, steady order counts (no orders / units movement of their own) */
const FLAT = { orders1: 300, orders0: 300, units1: 330, units0: 330 };

test("PA3 / §75. tiny denominator → no signal; small product extreme % → NOTICE only; large-scale decline → WARNING with evidence", async () => {
  const tiny = await evalIntel({ gmv1: 10_000, gmv0: 100_000, orders1: 1, orders0: 3, units1: 1, units0: 3 });
  assert.equal(tiny.signals.length, 0, "previous below the minimum base: no movement signal");

  const small = await evalIntel({ gmv1: 100_000, gmv0: 600_000, orders1: 2, orders0: 9, units1: 2, units0: 9 });
  const s = sig(small, "SALES_DOWN")!;
  assert.ok(s && s.change_pct < -80, "−83 % is observed …");
  assert.equal(s.severity, "NOTICE", "… but a small product is never a WARNING");
  assert.equal(s.confidence, "MEDIUM", "small sample → MEDIUM confidence");

  const big = await evalIntel({ gmv1: 30_000_000, gmv0: 50_000_000, ...BIG });
  const b = sig(big, "SALES_DOWN")!;
  assert.equal(b.severity, "WARNING");
  assert.equal(b.confidence, "HIGH");
  assert.deepEqual([b.current, b.previous, b.change_pct, b.polarity, b.direction], [30_000_000, 50_000_000, -40, "negative", "down"], "evidence carried");
  assert.equal(b.abs_change, -20_000_000);
});

test("PA3 / §75. missing comparison / sales missing: no sales signal, missing data is NOT zero", async () => {
  const noPrev = await evalIntel({ gmv1: 30_000_000, gmv0: 1_000_000, ...BIG }, { sales_previous_complete: false, sales_comparable: false });
  assert.equal(noPrev.signals.filter((s) => s.family === "sales").length, 0, "an uncovered previous period would read +2900 %");
  assert.ok(dq(noPrev).includes("COMPARISON_UNAVAILABLE"));
  assert.equal(noPrev.health.label, "INSUFFICIENT_DATA");
  assert.equal(noPrev.health.confidence, "LOW");

  const missing = await evalIntel({ gmv1: null, gmv0: null, orders1: null, orders0: null, units1: null, units0: null }, { sales_state: "no_data", sales_current_complete: false, sales_previous_complete: false, sales_comparable: false });
  assert.ok(dq(missing).includes("SALES_DATA_MISSING"));
  assert.equal(missing.signals.length, 0);
  assert.equal(missing.priority.business_vnd, 0);

  const notBackfilled = await evalIntel({ gmv1: 2_000_000, gmv0: 0, ...BIG }, { sales_state: "not_backfilled", sales_current_complete: false, sales_previous_complete: false, sales_comparable: false });
  assert.ok(dq(notBackfilled).includes("SALES_INCOMPLETE"));
  assert.ok(!types(notBackfilled).includes("SALES_UP"), "no +∞ % from missing data");
});

test("PA3 / §75. partial today / stale data / Ads missing → data-quality signals + confidence downgrade", async () => {
  const m = { gmv1: 30_000_000, gmv0: 50_000_000, ...BIG };
  const partial = await evalIntel(m, { partial_today: true, hour_cutoff: 15 });
  assert.ok(dq(partial).includes("PARTIAL_TODAY"));
  assert.equal(sig(partial, "SALES_DOWN")!.confidence, "MEDIUM", "a partial day lowers confidence one level");
  const noHour = await evalIntel(m, { partial_today: true, hour_cutoff: 0, same_time_ok: false, sales_comparable: false });
  assert.ok(dq(noHour).includes("COMPARISON_UNAVAILABLE"));
  assert.equal(noHour.signals.length, 0);

  const stale = await evalIntel(m, { sales_stale: true, sales_age_minutes: 300 });
  assert.ok(dq(stale).includes("DATA_STALE"));
  assert.equal(sig(stale, "SALES_DOWN")!.confidence, "MEDIUM");

  const adsMissing = await evalIntel({ ...m, campaigns: 1, spend1: 500_000, spend0: 500_000 }, { ads_missing: true, ads_stale: true });
  assert.ok(dq(adsMissing).includes("ADS_DATA_MISSING"));
  const snap = await evalIntel(m, { has_snapshot: true });
  assert.ok(dq(snap).includes("SNAPSHOT_SEMANTICS_UNKNOWN"));
});

test("PA3 / §16 §49. Ads signals: semantic polarity (CPC up = negative, spend = neutral), ratio of sums, min denominators", async () => {
  const i = await evalIntel({
    gmv1: 20_000_000, gmv0: 20_000_000, ...BIG, campaigns: 1,
    spend1: 3_000_000, spend0: 2_000_000, impressions1: 50_000, impressions0: 80_000, clicks1: 1_000, clicks0: 1_600,
    broad_order1: 40, broad_order0: 100, broad_gmv1: 9_000_000, broad_gmv0: 14_000_000,
  });
  assert.equal(sig(i, "ADS_SPEND_UP")!.polarity, "neutral");
  assert.equal(sig(i, "ADS_SPEND_UP")!.severity, "INFO");
  assert.equal(sig(i, "ADS_CPC_UP")!.polarity, "negative", "CPC 1 250 → 3 000 is unfavourable");
  assert.equal(sig(i, "ADS_ROAS_DOWN")!.current, 3, "ROAS = Σ broad GMV / Σ spend");
  assert.equal(sig(i, "ADS_ROAS_DOWN")!.previous, 7);
  assert.ok(types(i).includes("ADS_CVR_DOWN"));
  assert.ok(types(i).includes("ADS_IMPRESSIONS_DOWN"));
  assert.ok(types(i).includes("SALES_STABLE"));

  const lowSpend = await evalIntel({ gmv1: 20_000_000, gmv0: 20_000_000, ...BIG, campaigns: 1, spend1: 50_000, spend0: 90_000, broad_gmv1: 100_000, broad_gmv0: 1_000_000, clicks1: 10, clicks0: 12 });
  assert.ok(!types(lowSpend).some((t) => t.startsWith("ADS_ROAS") || t.startsWith("ADS_CPC") || t.startsWith("ADS_CVR")), "ROAS / CPC / CVR need a real spend / click base in both periods");
  const noCampaign = await evalIntel({ gmv1: 1, gmv0: 1, spend1: 9_000_000, spend0: 1_000_000, campaigns: 0 });
  assert.ok(!types(noCampaign).some((t) => t.startsWith("ADS_")), "no single-item campaign → no Ads signal");
});

test("PA3 / §76. health: every label reachable, each with rule, confidence, signals (explainable)", async () => {
  const cases: Array<[string, M, Record<string, unknown>?]> = [
    ["GOOD", { gmv1: 60_000_000, gmv0: 40_000_000, orders1: 500, orders0: 330, units1: 520, units0: 350 }],
    ["STABLE", { gmv1: 41_000_000, gmv0: 40_000_000, orders1: 335, orders0: 330, units1: 350, units0: 350 }],
    ["WATCH", { gmv1: 26_000_000, gmv0: 40_000_000, orders1: 300, orders0: 330, units1: 320, units0: 350 }],
    [
      "WEAK",
      { gmv1: 24_000_000, gmv0: 40_000_000, orders1: 200, orders0: 330, units1: 220, units0: 350, campaigns: 1, spend1: 2_000_000, spend0: 2_000_000, broad_gmv1: 6_000_000, broad_gmv0: 12_000_000, clicks1: 900, clicks0: 900, broad_order1: 30, broad_order0: 60 },
    ],
    ["INSUFFICIENT_DATA", { gmv1: 100_000, gmv0: 200_000, orders1: 1, orders0: 2, units1: 1, units0: 2 }],
  ];
  for (const [label, m, ctx] of cases) {
    const i = await evalIntel(m, ctx);
    assert.equal(i.health.label, label, `${label}: got ${i.health.label} (${i.health.rule})`);
    assert.ok(i.health.rule && i.health.confidence && Array.isArray(i.signals) && Array.isArray(i.top_signals), `${label} explainable`);
  }
  const weak = await evalIntel(cases[3][1]);
  assert.equal(weak.health.rule, "sales_and_efficiency_down");
  assert.deepEqual(weak.top_signals.map((s) => s.polarity), weak.top_signals.map(() => "negative"), "top signals: unfavourable first");
  assert.equal(weak.health.severity, "WARNING");
  const sharp = await evalIntel({ gmv1: 10_000_000, gmv0: 40_000_000, orders1: 300, orders0: 330, units1: 320, units0: 350 });
  assert.equal(sharp.health.label, "WEAK");
  assert.equal(sharp.health.rule, "sales_down_sharply");
});

test("PA3 / §77. Broad Ads GMV / sales = 500 %: attribution stays attribution — no contribution / organic anywhere", async () => {
  const i = await evalIntel({ gmv1: 2_000_000, gmv0: 2_000_000, ...FLAT, campaigns: 1, spend1: 1_000_000, spend0: 1_000_000, broad_gmv1: 10_000_000, broad_gmv0: 10_000_000, clicks1: 500, clicks0: 500, broad_order1: 50, broad_order0: 50 });
  const text = JSON.stringify(i).toLowerCase();
  for (const bad of ["organic", "contribution", "share", "remainder", "non_ads", "caused"]) assert.ok(!text.includes(bad), `engine output never mentions "${bad}"`);
  assert.ok(i.signals.every((s) => s.metric !== "broad_gmv_minus_sales"));
  assert.equal(i.health.label, "STABLE", "a 500 % attribution ratio is not a signal by itself");
});

test("PA3 / §28 §27. priority: tiny product with ROAS −80 % ranks BELOW a large product with orders −25 % and ROAS −30 %", async () => {
  const tiny = await evalIntel({ gmv1: 100_000, gmv0: 110_000, orders1: 1, orders0: 1, units1: 1, units0: 1, campaigns: 1, spend1: 150_000, spend0: 150_000, broad_gmv1: 60_000, broad_gmv0: 300_000, clicks1: 60, clicks0: 60, broad_order1: 1, broad_order0: 5 });
  const big = await evalIntel({
    gmv1: 50_000_000, gmv0: 58_000_000, orders1: 300, orders0: 400, units1: 320, units0: 420, campaigns: 1,
    spend1: 5_000_000, spend0: 5_000_000, broad_gmv1: 21_000_000, broad_gmv0: 30_000_000, clicks1: 3_000, clicks0: 3_000, broad_order1: 120, broad_order0: 150,
  });
  assert.ok(sig(big, "ORDERS_DOWN") && sig(big, "ADS_ROAS_DOWN"));
  assert.ok(big.priority.score > tiny.priority.score, `big ${big.priority.score} > tiny ${tiny.priority.score}`);
  assert.equal(big.needs_attention, true);
  assert.equal(tiny.needs_attention, false);
  assert.ok(big.priority.scale_points > tiny.priority.scale_points);
  const none = await evalIntel({ gmv1: 41_000_000, gmv0: 40_000_000, ...FLAT });
  assert.equal(none.priority.score, 0);
  assert.equal(none.priority.level, "NONE");
});

test("PA3 / §18. thresholds come from config only: a p_cfg without a key is refused", async () => {
  const broken: Record<string, unknown> = { ...CFG };
  delete broken.min_sales_gmv;
  await assert.rejects(() => evalIntel({ gmv1: 1, gmv0: 1 }, {}, broken), /missing keys/);
  // a stricter config changes the result (the SQL holds no number of its own)
  const strict = await evalIntel({ gmv1: 30_000_000, gmv0: 50_000_000, ...BIG }, {}, { ...CFG, change_pct_minor: 50, change_pct_major: 80 });
  assert.equal(strict.signals.filter((s) => s.type === "SALES_DOWN").length, 0);
});

// ------------------------------------------------------------------ seeded data: list / detail / summary

let P = "";
let Q = "";
let R = "";
const vnTs = (date: string, hh = 10) => Math.floor(Date.parse(`${date}T${String(hh).padStart(2, "0")}:00:00+07:00`) / 1000);

async function newShop(n: number, opts: { backfilled: boolean; synced: boolean }) {
  const { data, error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: `${Date.now()}${n}`, shop_name: `${TAG} shop ${n}`, currency: "VND", data_source: "live", region: "VN", is_active: true })
    .select("id")
    .single();
  if (error) throw error;
  shopIds.push(data.id);
  const now = new Date().toISOString();
  await db.from("product_analytics_shop_settings").insert({ shop_id: data.id, sales_sync_enabled: opts.synced, sales_backfill_done_at: opts.backfilled ? now : null });
  if (opts.synced) await db.from("channel_sync_states").insert({ shop_id: data.id, sync_type: "product_sales_facts_read", last_success_at: now });
  return data.id as string;
}

function order(sn: string, date: string, lines: Array<{ item: number; qty: number; price: number; name?: string }>, status = "COMPLETED") {
  return {
    order_sn: sn,
    order_status: status,
    create_time: vnTs(date),
    update_time: vnTs(date, 12),
    currency: "VND",
    item_list: lines.map((l, i) => ({ line_item_id: i + 1, order_item_id: i + 1, item_id: l.item, model_id: 0, model_quantity_purchased: l.qty, cancelled_qty: 0, returned_qty: 0, model_original_price: l.price, model_discounted_price: l.price, item_name: l.name ?? `Sản phẩm ${l.item}`, item_sku: `SKU-${l.item}` })),
  };
}

async function seedOrders(shopId: string, orders: unknown[]) {
  const rows: ProductSalesFactRow[] = [];
  for (const o of orders) {
    const r = mapOrderToSalesFacts(o);
    if ("issue" in r) throw new Error(r.issue.reason);
    rows.push(...r.rows);
  }
  await upsertProductSalesFacts(db, shopId, rows);
}

async function campaign(shopId: string, item: string, spendCur: number, spendPrev: number, gmvCur: number, gmvPrev: number) {
  const { data, error } = await db.from("shopee_ads_campaigns").insert({ shop_id: shopId, provider_campaign_id: `${Math.floor(Math.random() * 1e12)}`, campaign_name: `c${item}`, provider_status: "ongoing", last_synced_at: new Date().toISOString() }).select("id").single();
  if (error) throw error;
  await db.from("shopee_ads_campaign_products").insert({ shop_id: shopId, campaign_id: data.id, provider_item_id: item });
  const perf = [
    ...Array.from({ length: 7 }, (_, d) => ({ date: addDays(period.from, d), e: spendCur / 7, g: gmvCur / 7 })),
    ...Array.from({ length: 7 }, (_, d) => ({ date: addDays(period.prevFrom, d), e: spendPrev / 7, g: gmvPrev / 7 })),
  ];
  const { error: e } = await db.from("shopee_ads_campaign_daily_performance").insert(
    perf.map((x) => ({ shop_id: shopId, campaign_id: data.id, report_date: x.date, expense: Math.round(x.e), impression: 5000, clicks: 200, direct_order: 2, broad_order: 4, direct_gmv: Math.round(x.g / 2), broad_gmv: Math.round(x.g), direct_item_sold: 2, broad_item_sold: 4, last_synced_at: new Date().toISOString() })),
  );
  if (e) throw e;
}

const NAMES: Record<number, string> = { 3: "Thảm lông xù phòng khách", 7: "Thảm lông cừu", 11: "Ga gối Đũi Hàn", 13: "Chăn hè đũi" };

before(async () => {
  P = await newShop(1, { backfilled: true, synced: true });
  Q = await newShop(2, { backfilled: true, synced: true });
  R = await newShop(3, { backfilled: false, synced: false }); // no sales data at all, but Ads
  const orders: unknown[] = [];
  for (let k = 1; k <= 60; k++) {
    const item = 9_000_000 + k;
    const o1 = 1 + (k % 7);
    const o0 = 1 + ((k + 3) % 7);
    for (let j = 0; j < o1; j++) orders.push(order(`${TAG}-P${k}-c${j}`, addDays(period.from, j % 7), [{ item, qty: 1, price: 10_000 * k, name: NAMES[k] }]));
    for (let j = 0; j < o0; j++) orders.push(order(`${TAG}-P${k}-p${j}`, addDays(period.prevFrom, j % 7), [{ item, qty: 1, price: 10_000 * k, name: NAMES[k] }]));
  }
  // one order with TWO products → hero counts it once
  orders.push(order(`${TAG}-MULTI`, addDays(period.from, 1), [{ item: 9_000_001, qty: 1, price: 10_000 }, { item: 9_000_002, qty: 1, price: 20_000 }]));
  // a large product falling, with Ads efficiency falling; a tiny one with ROAS −80 %
  for (let j = 0; j < 30; j++) orders.push(order(`${TAG}-BIG-c${j}`, addDays(period.from, j % 7), [{ item: 9_000_100, qty: 1, price: 1_000_000, name: "Sản phẩm lớn" }]));
  for (let j = 0; j < 50; j++) orders.push(order(`${TAG}-BIG-p${j}`, addDays(period.prevFrom, j % 7), [{ item: 9_000_100, qty: 1, price: 1_000_000, name: "Sản phẩm lớn" }]));
  orders.push(order(`${TAG}-TINY-c`, addDays(period.from, 2), [{ item: 9_000_101, qty: 1, price: 100_000, name: "Sản phẩm nhỏ" }]));
  orders.push(order(`${TAG}-TINY-p`, addDays(period.prevFrom, 2), [{ item: 9_000_101, qty: 1, price: 110_000, name: "Sản phẩm nhỏ" }]));
  await seedOrders(P, orders);
  for (let k = 1; k <= 20; k++) await campaign(P, String(9_000_000 + k), 700_000, 700_000, 2_100_000, 2_100_000);
  await campaign(P, "9000100", 5_000_000, 5_000_000, 15_000_000, 30_000_000);
  await campaign(P, "9000101", 150_000, 150_000, 60_000, 300_000);
  // shop Q reuses item ids: identity = shop + item, never joined across shops
  await seedOrders(Q, [order(`${TAG}-Q1`, addDays(period.from, 1), [{ item: 9_000_001, qty: 9, price: 999_000, name: "Thảm lông shop Q" }])]);
  await campaign(R, "9000500", 400_000, 400_000, 1_000_000, 1_000_000);
});

test("PA3 / §78. pagination boundaries: 50 per page, the rest on page 2, a page past the end clamps to the last", async () => {
  const p1 = await loadIntelligenceList(db, [P], period, { sort: "gmv" });
  assert.equal(p1.total, 62);
  assert.equal(p1.filtered, 62);
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.page, 1);
  const p2 = await loadIntelligenceList(db, [P], period, { sort: "gmv", page: 2 }, { withSummary: false });
  assert.equal(p2.rows.length, 12);
  assert.equal(p2.summary, null);
  const ids = new Set([...p1.rows, ...p2.rows].map((r) => r.id));
  assert.equal(ids.size, 62, "no row twice, none missing across pages");
  const past = await loadIntelligenceList(db, [P], period, { sort: "gmv", page: 99 }, { withSummary: false });
  assert.equal(past.page, 2);
  const small = await loadIntelligenceList(db, [P], period, { pageSize: 25, page: 3 }, { withSummary: false });
  assert.equal(small.rows.length, 12);
  const capped = await loadIntelligenceList(db, [P], period, { pageSize: 5000 }, { withSummary: false });
  assert.equal(capped.page_size, 100, "page size is capped in SQL");
});

test("PA3 / §78 §37. search + pagination: accent-insensitive over name / SKU / item id", async () => {
  const r = await loadIntelligenceList(db, [P], period, { q: "tham long", pageSize: 25 }, { withSummary: false });
  assert.deepEqual(r.rows.map((x) => x.item_id).sort(), ["9000003", "9000007"]);
  assert.equal(r.filtered, 2);
  const dui = await loadIntelligenceList(db, [P], period, { q: "DUI" }, { withSummary: false });
  assert.deepEqual(dui.rows.map((x) => x.item_id).sort(), ["9000011", "9000013"]);
  const sku = await loadIntelligenceList(db, [P], period, { q: "sku-9000042" }, { withSummary: false });
  assert.deepEqual(sku.rows.map((x) => x.item_id), ["9000042"]);
  const id = await loadIntelligenceList(db, [P], period, { q: "9000100" }, { withSummary: false });
  assert.equal(id.rows[0].name, "Sản phẩm lớn");
  const none = await loadIntelligenceList(db, [P], period, { q: "khong ton tai xyz", page: 4 }, { withSummary: false });
  assert.equal(none.filtered, 0);
  assert.equal(none.page, 1);
});

test("PA3 / §78 §36. sort + pagination: order holds across pages; nulls last; name asc", async () => {
  const p1 = await loadIntelligenceList(db, [P], period, { sort: "gmv", dir: "desc", pageSize: 25 }, { withSummary: false });
  const p2 = await loadIntelligenceList(db, [P], period, { sort: "gmv", dir: "desc", pageSize: 25, page: 2 }, { withSummary: false });
  const g = [...p1.rows, ...p2.rows].map((r) => r.gmv ?? -1);
  assert.deepEqual(g, [...g].sort((a, b) => b - a));
  const asc = await loadIntelligenceList(db, [P], period, { sort: "spend", dir: "asc", pageSize: 100 }, { withSummary: false });
  const sp = asc.rows.map((r) => r.spend);
  assert.deepEqual(sp, [...sp].sort((a, b) => a - b));
  const roas = await loadIntelligenceList(db, [P], period, { sort: "roas_pct", pageSize: 100 }, { withSummary: false });
  const firstNull = roas.rows.findIndex((r) => r.roas_pct === null);
  assert.ok(firstNull > 0 && roas.rows.slice(firstNull).every((r) => r.roas_pct === null), "rows without a comparison sort last");
  const names = await loadIntelligenceList(db, [P], period, { sort: "name", dir: "asc", pageSize: 100 }, { withSummary: false });
  assert.equal(names.rows[0].name, "Chăn hè đũi");
  const prio = await loadIntelligenceList(db, [P], period, { sort: "priority", pageSize: 100 }, { withSummary: false });
  const bigIdx = prio.rows.findIndex((r) => r.item_id === "9000100");
  const tinyIdx = prio.rows.findIndex((r) => r.item_id === "9000101");
  assert.equal(bigIdx, 0, "the large declining product is the first to review");
  assert.ok(tinyIdx > bigIdx);
});

test("PA3 / §78 §35. filter + pagination: Ads presence, health, signal type", async () => {
  const withAds = await loadIntelligenceList(db, [P], period, { ads: "with", pageSize: 25 }, { withSummary: false });
  assert.equal(withAds.filtered, 22);
  assert.equal(withAds.rows.length, 22);
  const without = await loadIntelligenceList(db, [P], period, { ads: "without" }, { withSummary: false });
  assert.equal(without.filtered, 40);
  const weak = await loadIntelligenceList(db, [P], period, { health: "WEAK" }, { withSummary: false });
  assert.ok(weak.rows.length > 0 && weak.rows.every((r) => r.health.label === "WEAK"));
  const down = await loadIntelligenceList(db, [P], period, { signal: "SALES_DOWN", pageSize: 25 }, { withSummary: false });
  assert.ok(down.filtered > 0 && down.rows.every((r: IntelListRow) => r.signal_types.includes("SALES_DOWN")));
  const attention = await loadIntelligenceList(db, [P], period, { health: "ATTENTION" }, { withSummary: false });
  assert.ok(attention.rows.every((r) => r.needs_attention));
});

test("PA3 / §78. authorization: a shop outside p_shop_ids never leaks; anon / authenticated cannot EXECUTE", async () => {
  const p = await loadIntelligenceList(db, [P], period, { q: "shop Q" }, { withSummary: false });
  assert.equal(p.filtered, 0);
  const q = await loadIntelligenceList(db, [Q], period, {}, { withSummary: false });
  assert.deepEqual(q.rows.map((r) => [r.item_id, r.gmv]), [["9000001", 8_991_000]], "same item id, other shop: its own facts only");
  if (anonKey) {
    const anon = createClient(url!, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await anon.rpc("product_intelligence_list", { p_shop_ids: [P], p_from: period.from, p_to: period.to, p_prev_from: period.prevFrom, p_prev_to: period.prevTo, p_hour_cutoff: null, p_partial_today: false, p_cfg: CFG });
    assert.ok(error, "anon must not execute product_intelligence_list");
    const { error: e2 } = await anon.rpc("pa_intelligence_eval", { p_m: {}, p_ctx: {}, p_cfg: CFG });
    assert.ok(e2);
  }
});

test("PA3 / §31 §32. summary: health distribution, attention top list, hero counts a multi-product order once", async () => {
  const r = await loadIntelligenceList(db, [P], period, { pageSize: 25 });
  const s = r.summary!;
  const counted = Object.values(s.health_counts).reduce((a, b) => a + (b ?? 0), 0);
  assert.equal(counted, 62);
  assert.ok(s.top_attention.length > 0 && s.top_attention[0].item_id === "9000100");
  assert.ok(s.top_attention.every((x) => x.needs_attention && x.health && x.top_signals.length > 0));
  const productOrders = (await loadIntelligenceList(db, [P], period, { pageSize: 100 }, { withSummary: false })).rows.reduce((a, x) => a + (x.orders ?? 0), 0);
  assert.equal(s.hero.orders.current, productOrders - 1, "the 2-product order is ONE shop order");
  assert.equal(s.hero.sales_availability, "complete");
  assert.equal(s.hero.sales_comparable, true);
  const only = await loadSignalSummary(db, [P], period);
  assert.deepEqual(only!.health_counts, s.health_counts, "product_signal_summary = same engine");
  const ctx = s.shop_context.find((c) => c.shop_id === P)!;
  assert.ok(ctx.sales_comparable_products > 0 && ctx.median_gmv_pct !== null);
});

test("PA3 / §34 missing≠zero. shop without sales data: gmv NULL (not 0), SALES_DATA_MISSING, hero no_data; coverage SQL = coverage.ts", async () => {
  const r = await loadIntelligenceList(db, [R], period);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].gmv, null);
  assert.equal(r.rows[0].sales_state, "no_data");
  assert.ok(r.rows[0].data_quality.includes("SALES_DATA_MISSING"));
  assert.equal(r.summary!.hero.sales_availability, "no_data");
  assert.equal(r.summary!.hero.gmv.current, null);
  const shops = (await loadIntelligenceList(db, [P, R], period, {}, { withSummary: false })).shops;
  for (const s of shops) {
    const ts = salesCoverage({ sales_last_success_at: s.sales_last_success_at, sales_backfill_done_at: s.sales_backfill_done_at }, period);
    assert.deepEqual([s.sales_state, s.covered_from, s.current_complete, s.previous_complete], [ts.state, ts.covered_from, ts.current_complete, ts.previous_complete], "SQL coverage mirrors coverage.ts");
  }
  const p30 = resolveProductPeriod({ preset: "30d" });
  const cov30 = (await loadIntelligenceList(db, [P], p30, {}, { withSummary: false })).rows;
  assert.ok(cov30.every((x) => x.gmv_pct === null && !x.signal_types.some((t) => t.startsWith("SALES_"))), "30d: previous period not covered → no sales Δ, no sales signal");
});

test("PA3 / §33. detail: full signals with evidence + shop context; a product with no activity is still returned", async () => {
  const d = await loadIntelligenceDetail(db, { shopId: P, itemId: "9000100" }, period);
  assert.ok(d);
  assert.ok(d!.row.intel.signals.some((s) => s.type === "SALES_DOWN" && s.previous === 50_000_000 && s.current === 30_000_000));
  assert.ok(d!.shop_context.products >= 62);
  assert.ok(d!.shop.sales_state === "covered");
  const { data: quiet } = await db.from("shopee_products").insert({ shop_id: P, provider_item_id: "9000999", name: "Không bán", metadata_source: "order_line", first_seen_source: "order_line" }).select("id").single();
  assert.ok(quiet);
  const q = await loadIntelligenceDetail(db, { shopId: P, itemId: "9000999" }, period);
  assert.equal(q!.row.intel.health.label, "INSUFFICIENT_DATA");
  assert.equal(q!.row.gmv, 0, "covered shop, no orders: a real zero");
  assert.equal(await loadIntelligenceDetail(db, { shopId: Q, itemId: "9000100" }, period), null, "product of another shop → null");
});

test("PA3 / §80. reads write nothing: no job, no API snapshot, no fact change (0 provider calls)", async () => {
  const count = async (t: string) => (await db.from(t).select("*", { count: "exact", head: true }).in("shop_id", [P, Q, R])).count ?? 0;
  const before = await Promise.all(["channel_sync_jobs", "channel_api_snapshots", "shopee_product_sales_facts"].map(count));
  await loadIntelligenceList(db, [P, Q, R], period, { q: "tham", health: "WATCH", page: 2 });
  await loadIntelligenceDetail(db, { shopId: P, itemId: "9000100" }, period);
  await loadSignalSummary(db, [P], period);
  const afterCounts = await Promise.all(["channel_sync_jobs", "channel_api_snapshots", "shopee_product_sales_facts"].map(count));
  assert.deepEqual(afterCounts, before);
  assert.ok(PRODUCT_INTELLIGENCE_CONFIG.attentionMinScore > 0);
});
