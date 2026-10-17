// ============================================================
// SHOPEE-8 — analytics read model against the REAL database in .env.local
// (local Docker Supabase in dev):
//
//   node --env-file=.env.local --test src/lib/channels/core/analytics.integration.test.ts
//
// Fixtures go through the real cost engine (receipts → moving average →
// order COGS snapshots, combo BOM snapshots) and the real SHOPEE-6 / -7
// write paths (returns + dispositions, releases, payouts). Orders live in
// 2035 so nothing else in the database falls into the ranges.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { CostEngine } from "../../inventory-cost/engine.ts";
import { createComboProduct, updateComboProduct } from "../../products/combo.ts";
import { parseReturnDetail } from "../shopee/return-adapter.ts";
import {
  getAnalyticsSummary,
  getAnalyticsTrend,
  getAtomicConsumption,
  getCashflowAnalytics,
  getDataQuality,
  getLossOrders,
  getMarginBands,
  getPendingReleaseOrders,
  getProductAnalytics,
  getReturnsAnalytics,
  getShopComparison,
  resolveAnalyticsScope,
  type AnalyticsScope,
} from "./analytics.ts";
import { setReturnDisposition } from "./returns.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const engine = new CostEngine({ db, logger: () => {} });

const TAG = `s8${Date.now()}`;
const DAY = "2035-05-10";
const AT = "2035-05-10T05:00:00Z"; // 12:00 VN
const shopIds: string[] = [];
const productIds: string[] = [];
const comboIds: string[] = [];
let supplierId = "";
let n = 0;

const scopeOf = (ids: string[]): AnalyticsScope => ({ shopIds: ids, currency: "VND", excludedShops: [], selectedShopId: ids.length === 1 ? ids[0] : null, shops: [] });
const range = (from = DAY, to = DAY) => ({ from, to });

after(async () => {
  if (shopIds.length) {
    const { data: items } = await db.from("channel_order_items").select("id, channel_orders!inner(shop_id)").in("channel_orders.shop_id", shopIds);
    const lineIds = (items ?? []).map((i) => i.id as string);
    for (let i = 0; i < lineIds.length; i += 200) {
      const { data: rs } = await db.from("channel_return_restocks").select("id").in("channel_order_item_id", lineIds.slice(i, i + 200));
      const rsIds = (rs ?? []).map((r) => r.id as string);
      if (rsIds.length) {
        await db.from("inventory_cost_ledger").delete().in("source_id", rsIds);
        await db.from("channel_return_restocks").delete().in("id", rsIds);
      }
    }
    await db.from("shops").delete().in("id", shopIds);
  }
  await db.from("receipts").delete().eq("receiver_name", TAG);
  if (productIds.length) await db.from("inventory_cost_ledger").delete().in("product_id", productIds);
  if (comboIds.length) await db.from("products").delete().in("id", comboIds);
  if (productIds.length) await db.from("products").delete().in("id", productIds);
  if (supplierId) await db.from("suppliers").delete().eq("id", supplierId);
});

// ------------------------------------------------------------------ helpers

async function atomic(): Promise<string> {
  const sku = `${TAG}_P${++n}`;
  const { data, error } = await db.from("products").insert({ sku, name: sku, unit: "chiec", current_price: 1, supplier_id: supplierId }).select("id").single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id;
}

async function receipt(productId: string, qty: number, price: number, date: string) {
  const { error } = await db.rpc("create_receipt", {
    p_receipt_date: date,
    p_shift: "morning",
    p_supplier_id: supplierId,
    p_receiver_name: TAG,
    p_note: null,
    p_created_by: null,
    p_items: [{ product_id: productId, unit_price: price, delivered_qty: qty, received_qty: qty }],
  });
  if (error) throw new Error(error.message);
}

async function shop(): Promise<string> {
  const { data, error } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: `analytics ${n}`, currency: "VND", data_source: "fixture" }).select("id").single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

type Line = { productId: string | null; qty: number; price: number };

/** An order through the cost engine + its Shopee figures (null = not synced yet). */
async function order(shopId: string, lines: Line[], fin: { total: number; est?: number | null; actual?: number | null; status?: string; at?: string; sn?: string }) {
  const sn = fin.sn ?? `${TAG}SN${++n}`;
  const at = fin.at ?? AT;
  const { data: o, error } = await db
    .from("channel_orders")
    .insert({ shop_id: shopId, external_order_sn: sn, order_status: fin.status ?? "COMPLETED", currency: "VND", channel_total_amount: fin.total, created_at_channel: at, paid_at_channel: at, updated_at_channel: at })
    .select("id")
    .single();
  if (error) throw error;
  const itemIds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { data: it, error: e } = await db
      .from("channel_order_items")
      .insert({ order_id: o!.id, provider_line_key: `k${i}`, external_item_id: String(i + 1), item_name: `line ${i + 1}`, quantity: lines[i].qty, discounted_unit_price: lines[i].price, original_unit_price: lines[i].price, internal_product_id: lines[i].productId })
      .select("id")
      .single();
    if (e) throw e;
    itemIds.push(it!.id);
  }
  await engine.processOrder(o!.id);
  const patch: Record<string, unknown> = {};
  if (fin.est != null) patch.estimated_order_revenue = fin.est;
  if (fin.actual != null) Object.assign(patch, { escrow_amount: fin.actual, escrow_amount_after_adjustment: fin.actual });
  if (Object.keys(patch).length) {
    const { error: fe } = await db.from("order_financials").upsert({ order_id: o!.id, ...patch }, { onConflict: "order_id" });
    if (fe) throw fe;
  }
  return { orderId: o!.id as string, sn, itemIds };
}

async function returnOf(shopId: string, orderId: string, orderSn: string, itemId: number, qty: number, disposition: "restock" | "lost" | "damaged") {
  const parsed = parseReturnDetail({
    error: "",
    response: { return_sn: `${TAG}R${++n}`, order_sn: orderSn, status: "REFUND_PAID", refund_amount: 50000, currency: "VND", create_time: Date.parse(AT) / 1000 + 3600, update_time: Date.parse(AT) / 1000 + 7200, item: [{ item_id: itemId, model_id: 0, amount: qty }] },
  });
  if ("issue" in parsed) throw new Error(parsed.issue.reason);
  const d = parsed.detail;
  const { data, error } = await db.rpc("apply_channel_return", {
    p_shop_id: shopId,
    p_order_id: orderId,
    p_return: { external_return_sn: d.externalReturnSn, status: d.status, refund_amount: d.refundAmount, currency: d.currency, created_at_channel: d.createdAtChannel, updated_at_channel: d.updatedAtChannel, is_terminal: d.isTerminal },
    p_items: d.items.map((i) => ({ external_item_id: i.externalItemId, external_model_id: i.externalModelId, quantity: i.quantity, item_name: i.itemName })),
    p_synced_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  const { data: items } = await db.from("channel_return_items").select("id").eq("return_id", (data as { return_id: string }).return_id);
  await setReturnDisposition(db, { returnItemId: items![0].id as string, disposition, changedBy: null });
}

// ------------------------------------------------------------- fixture

let S1 = "";
let A = "";
let B = "";
let C = "";
let K = "";
const ids: Record<string, { orderId: string; sn: string; itemIds: string[] }> = {};

before(async () => {
  const { data, error } = await db.from("suppliers").insert({ code: `${TAG}_hh`, name: "analytics household", supplier_type: "business_household" }).select("id").single();
  if (error) throw error;
  supplierId = data.id;
  A = await atomic(); // cost 40.000
  B = await atomic(); // cost 10.000
  C = await atomic(); // no receipt → no cost
  await receipt(A, 100, 40000, "2035-05-01");
  await receipt(B, 100, 10000, "2035-05-01");
  K = await createComboProduct(db, { sku: `${TAG}_K`, name: "combo 2A+1B", components: [{ productId: A, quantity: 2 }, { productId: B, quantity: 1 }] });
  comboIds.push(K);

  S1 = await shop();
  ids.o1 = await order(S1, [{ productId: A, qty: 1, price: 100000 }], { total: 100000, est: 90000, actual: 90000 });
  ids.o2 = await order(S1, [{ productId: B, qty: 9, price: 100000 }], { total: 900000, est: 180000, actual: 180000 });
  ids.o3 = await order(S1, [{ productId: A, qty: 1, price: 50000 }], { total: 50000, est: 30000, status: "SHIPPED" }); // estimated loss
  ids.o4 = await order(S1, [{ productId: K, qty: 1, price: 200000 }], { total: 200000, est: 150000, actual: 150000 }); // combo
  ids.o5 = await order(S1, [{ productId: A, qty: 2, price: 100000 }], { total: 200000, est: 160000, actual: 120000 }); // returned → restock
  ids.o6 = await order(S1, [{ productId: A, qty: 1, price: 100000 }], { total: 100000, est: 90000, actual: 50000 }); // returned → lost
  ids.o7 = await order(S1, [{ productId: null, qty: 1, price: 50000 }], { total: 50000, est: 50000, status: "SHIPPED" }); // unmapped
  ids.o8 = await order(S1, [{ productId: C, qty: 1, price: 30000 }], { total: 30000, est: 25000, status: "SHIPPED" }); // missing COGS
  ids.o9 = await order(S1, [{ productId: A, qty: 1, price: 100000 }], { total: 100000, est: 90000, status: "CANCELLED" });
  await returnOf(S1, ids.o5.orderId, ids.o5.sn, 1, 1, "restock");
  await returnOf(S1, ids.o6.orderId, ids.o6.sn, 1, 1, "lost");
  // after the sale: the combo BOM and A's cost change — history must not move
  await updateComboProduct(db, K, { sku: `${TAG}_K`, name: "combo v2", components: [{ productId: A, quantity: 5 }] });
  await receipt(A, 10, 400000, "2035-05-12");
});

// ================================================================ KPI

test("SHOPEE-8 89 + 90: KPIs — three money layers, coverage, net COGS, weighted margins; cancelled excluded; missing never 0", async () => {
  const s = await getAnalyticsSummary(db, scopeOf([S1]), range());
  assert.equal(s.orders_created, 9);
  assert.equal(s.order_count, 8, "cancelled order is not a sale");
  assert.equal(s.cancelled_count, 1);
  assert.equal(s.order_value, "1630000.00", "Σ channel_total_amount");
  assert.deepEqual([s.estimated_revenue, s.estimated_revenue_orders], ["775000.00", 8]);
  assert.deepEqual([s.estimated_profit, s.estimated_profit_orders, s.estimated_margin], ["320000.00", 6, "20.6"], "320k / 1.550k (orders WITH estimated profit only)");
  assert.deepEqual([s.actual_income, s.actual_income_orders], ["590000.00", 5]);
  assert.deepEqual([s.actual_profit, s.actual_profit_orders, s.actual_margin], ["290000.00", 5, "19.3"], "290k / 1.500k");
  assert.deepEqual([s.original_cogs, s.reversed_cogs, s.net_cogs, s.cogs_orders], ["380000.00", "40000.00", "340000.00", 6]);
  assert.deepEqual([s.missing_cogs_orders, s.unmapped_orders, s.missing_estimated_orders, s.awaiting_actual_orders], [2, 1, 0, 0]);
  assert.deepEqual([s.loss_estimated_orders, s.loss_actual_orders], [1, 0]);
  assert.deepEqual([s.orders_with_returns, s.returned_units], [2, "2.0000"]);
});

test("SHOPEE-8 95: weighted margin regression — 50/100 + 90/900 = 14 %, not the naive 30 %", async () => {
  const s2 = await shop();
  await order(s2, [{ productId: B, qty: 1, price: 100000 }], { total: 100, est: 60, actual: 60 });
  await order(s2, [{ productId: B, qty: 1, price: 900000 }], { total: 900, est: 100, actual: 100 });
  // COGS 10.000 per B would swamp the toy amounts → make each order's profit exactly 50 and 90 via income
  const { data: os } = await db.from("channel_orders").select("id, channel_total_amount").eq("shop_id", s2).order("channel_total_amount");
  await db.from("order_financials").update({ escrow_amount_after_adjustment: 10050 }).eq("order_id", os![0].id);
  await db.from("order_financials").update({ escrow_amount_after_adjustment: 10090 }).eq("order_id", os![1].id);
  const s = await getAnalyticsSummary(db, scopeOf([s2]), range());
  assert.equal(s.actual_profit, "140.00");
  assert.equal(s.actual_margin, "14.0");
});

// ================================================================ PRODUCTS / COMBO

test("SHOPEE-8 16 + 17 + 92: SKU ranking — combo is its own sellable SKU with its historical COGS; atomic consumption separate; Σ SKU = order totals", async () => {
  const { rows, total } = await getProductAnalytics(db, scopeOf([S1]), range(), { sort: "units", limit: 50 });
  assert.equal(total, 4, "A, B, combo, C (unmapped line excluded)");
  const by = new Map(rows.map((r) => [r.product_id, r]));
  const a = by.get(A)!;
  const k = by.get(K)!;
  const b = by.get(B)!;
  assert.deepEqual([a.units, a.orders, a.cogs], ["5.0000", 4, "200000.00"]);
  assert.deepEqual([b.units, b.orders], ["9.0000", 1], "combo sales never add B units to the primary ranking");
  assert.deepEqual([k.product_type, k.units, k.cogs, k.estimated_profit, k.actual_profit], ["combo", "1.0000", "90000.00", "60000.00", "60000.00"], "historical combo COGS, not the new BOM / cost");
  assert.equal(by.get(C)!.cost_flag, "cogs_missing");
  // A: est 90+30+160+90 − 200 = 170k ; actual 90+120+50 − (40+80−40+40) = 140k
  assert.deepEqual([a.estimated_profit, a.actual_profit, a.returned_units, a.return_rate], ["170000.00", "140000.00", "2.0000", "40.0"]);
  const sumValue = rows.reduce((acc, r) => acc + Number(r.order_value ?? 0), 0);
  assert.equal(sumValue, 1580000, "Σ allocated order value = order value of mapped orders (1.630k − unmapped 50k)");

  const cons = await getAtomicConsumption(db, scopeOf([S1]), range());
  const ca = cons.find((c) => c.product_id === A)!;
  const cb = cons.find((c) => c.product_id === B)!;
  assert.deepEqual([ca.direct_units, ca.via_combo_units, ca.total_units], ["5.0000", "2.0000", "7.0000"]);
  assert.deepEqual([cb.direct_units, cb.via_combo_units], ["9.0000", "1.0000"]);

  // "SKU cần chú ý" follows the CENTRAL threshold (B margin 10.0 %: not < 10, but < 15)
  const attention = await getProductAnalytics(db, scopeOf([S1]), range(), { attention: true, limit: 50 });
  assert.deepEqual(attention.rows.map((r) => r.product_id), []);
  await db.from("analytics_settings").update({ low_margin_threshold_pct: 15 }).eq("id", true);
  try {
    const at15 = await getProductAnalytics(db, scopeOf([S1]), range(), { attention: true, limit: 50 });
    assert.deepEqual(at15.rows.map((r) => r.product_id), [B]);
  } finally {
    await db.from("analytics_settings").update({ low_margin_threshold_pct: 10 }).eq("id", true);
  }
});

// ================================================================ LOSS / BANDS

test("SHOPEE-8 21 + 22 + 23: loss orders labelled estimated vs actual; margin bands from settings", async () => {
  const loss = await getLossOrders(db, scopeOf([S1]), range());
  assert.deepEqual(loss.rows.map((r) => [r.external_order_sn, r.loss_state, r.estimated_profit]), [[ids.o3.sn, "estimated_loss", "-10000.00"]]);
  const bands = await getMarginBands(db, scopeOf([S1]), range(), "actual");
  // actual margins: o1 50 %, o2 10 %, o4 30 %, o5 40 %, o6 10 %
  assert.deepEqual(bands.map((b) => b.orders), [0, 0, 2, 0, 3]);
  assert.equal(bands.reduce((s, b) => s + b.orders, 0), 5, "every order with actual profit in exactly one band");
});

// ================================================================ RETURNS

test("SHOPEE-8 91: returns — restock reversed, lost not recovered, unit vs order return rate, actual profit after return", async () => {
  const r = await getReturnsAnalytics(db, scopeOf([S1]), range());
  assert.deepEqual([r.return_count, r.returned_units, r.restocked_units, r.lost_units], [2, "2.0000", "1.0000", "1.0000"]);
  assert.deepEqual([r.cogs_involved, r.cogs_reversed, r.cogs_not_recovered], ["80000.00", "40000.00", "40000.00"]);
  assert.deepEqual([r.cohort_units, r.cohort_returned_units, r.unit_return_rate], ["17.0000", "2.0000", "11.8"], "units returned / units sold");
  assert.deepEqual([r.cohort_orders, r.cohort_orders_with_returns, r.order_return_rate], [8, 2, "25.0"], "a separate, labelled order-based rate");
  const o5 = (await db.from("order_financials").select("actual_profit::text").eq("order_id", ids.o5.orderId).single()).data!;
  assert.equal(o5.actual_profit, "80000.00", "120k income − (80k − 40k restocked)");
});

// ================================================================ MULTI SHOP

test("SHOPEE-8 93: shop filter, All Shops aggregation, isolation with the same order_sn", async () => {
  const s3 = await shop();
  await order(s3, [{ productId: A, qty: 1, price: 100000 }], { total: 100000, est: 90000, actual: 90000, sn: ids.o1.sn });
  const one = await getAnalyticsSummary(db, scopeOf([s3]), range());
  assert.deepEqual([one.order_count, one.order_value], [1, "100000.00"]);
  const both = await getAnalyticsSummary(db, scopeOf([S1, s3]), range());
  assert.deepEqual([both.order_count, both.order_value, both.actual_profit], [9, "1730000.00", "340000.00"]);
  const cmp = await getShopComparison(db, scopeOf([S1, s3]), range());
  assert.deepEqual(cmp.map((c) => [c.shop_id, c.orders]).sort(), [[S1, 8], [s3, 1]].sort());

  // the server decides the shop set: an unknown id from the URL is ignored
  const scope = (await resolveAnalyticsScope(db, "00000000-0000-0000-0000-000000000000"))!;
  assert.equal(scope.selectedShopId, null);
  assert.ok(scope.shopIds.includes(S1));
  assert.deepEqual((await resolveAnalyticsScope(db, s3))!.shopIds, [s3]);
});

// ================================================================ DATES

test("SHOPEE-8 94: VN day boundary, custom range, order date vs payout date", async () => {
  const s4 = await shop();
  await order(s4, [{ productId: B, qty: 1, price: 10000 }], { total: 10000, at: "2035-05-10T16:59:59Z" }); // 23:59:59 VN, 10/05
  const next = await order(s4, [{ productId: B, qty: 1, price: 20000 }], { total: 20000, at: "2035-05-10T17:00:00Z", actual: 15000 }); // 00:00 VN, 11/05
  assert.equal((await getAnalyticsSummary(db, scopeOf([s4]), range())).order_value, "10000.00");
  assert.equal((await getAnalyticsSummary(db, scopeOf([s4]), range("2035-05-11", "2035-05-11"))).order_value, "20000.00");
  assert.equal((await getAnalyticsSummary(db, scopeOf([s4]), range("2035-05-10", "2035-05-11"))).order_count, 2);
  const hours = await getAnalyticsTrend(db, scopeOf([s4]), range(), "hour");
  assert.equal(hours.length, 24);
  assert.equal(hours[23].bucket, "2035-05-10T23:00");
  assert.equal(hours[23].orders, 1);

  // the order of 11/05 is released on 20/05 and paid out on 21/05 → cash on those days, not on 11/05
  await db.rpc("apply_income_releases", { p_shop_id: s4, p_source: "escrow_list", p_entries: [{ order_sn: next.sn, amount: "15000", currency: "VND", release_time: "2035-05-20T03:00:00Z" }] });
  await db.rpc("apply_payout", {
    p_shop_id: s4,
    p_source: "payout_detail",
    p_payout: { provider_payout_id: `${TAG}PO`, payout_amount: "15500", payout_currency: "VND", payout_time: "2035-05-21T03:00:00Z", payout_status: "completed" },
    p_orders: [{ order_sn: next.sn, amount: "15000", currency: "VND" }],
    p_adjustments: [],
  });
  const onOrderDay = await getCashflowAnalytics(db, scopeOf([s4]), range("2035-05-11", "2035-05-11"));
  assert.deepEqual([onOrderDay.released_amount, onOrderDay.payout_amount], ["0", "0"]);
  const cash = await getCashflowAnalytics(db, scopeOf([s4]), range("2035-05-20", "2035-05-21"));
  assert.deepEqual([cash.released_amount, cash.payout_amount, cash.payout_count], ["15000.00", "15500.00", 1]);
  assert.deepEqual([cash.open_mismatch_payouts, cash.open_mismatch_value, cash.payouts_by_status.mismatch], [1, "500.00", 1]);
});

test("SHOPEE-8 32: release aging in whole days (0–1, 2–3, 4–7, > 7) and the bucket drilldown", async () => {
  const s6 = await shop();
  for (const d of [0.5, 1.5, 2.5, 5, 10]) {
    const at = new Date(Date.now() - d * 86_400_000).toISOString();
    await order(s6, [{ productId: B, qty: 1, price: 10000 }], { total: 10000, actual: 9000, at });
  }
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  const c = await getCashflowAnalytics(db, scopeOf([s6]), range(today, today));
  assert.deepEqual(c.aging.map((a) => [a.lower_days, a.upper_days, a.orders]), [[0, 1, 2], [1, 3, 1], [3, 7, 1], [7, null, 1]], "each order in exactly one bucket");
  assert.deepEqual([c.pending_orders, c.pending_amount], [5, "45000.00"]);
  const b2 = await getPendingReleaseOrders(db, scopeOf([s6]), { lower: 1, upper: 3 });
  assert.equal(b2.total, 1);
  const b1 = await getPendingReleaseOrders(db, scopeOf([s6]), { lower: null, upper: 1 });
  assert.equal(b1.total, 2);
});

// ================================================================ DATA QUALITY

test("SHOPEE-8 24 + 26: data quality counts", async () => {
  const q = await getDataQuality(db, scopeOf([S1]), range());
  assert.deepEqual([q.orders, q.unmapped_orders, q.missing_cogs_orders, q.awaiting_actual_orders, q.returns_pending_disposition], [8, 1, 2, 0, 0]);
  assert.equal(q.sold_products_no_cost, 1, "C sold without any cost");
  assert.equal(q.financial_status.pending + (q.financial_status.return_adjusted ?? 0) + (q.financial_status.settlement_available ?? 0), 8);
});

// ================================================================ PERFORMANCE

test("SHOPEE-8 96: thousands of orders — aggregated in the database, bounded result sizes", async () => {
  const s5 = await shop();
  const N = 4000;
  const orders = Array.from({ length: N }, (_, i) => ({
    shop_id: s5,
    external_order_sn: `${TAG}PERF${i}`,
    order_status: i % 25 === 0 ? "CANCELLED" : "COMPLETED",
    currency: "VND",
    channel_total_amount: 100000 + (i % 7) * 1000,
    created_at_channel: new Date(Date.parse("2035-06-01T00:00:00Z") + (i % 30) * 86_400_000 + (i % 24) * 3_600_000).toISOString(),
  }));
  const orderIds: string[] = [];
  for (let i = 0; i < N; i += 1000) {
    const { data, error } = await db.from("channel_orders").insert(orders.slice(i, i + 1000)).select("id");
    if (error) throw error;
    orderIds.push(...data!.map((d) => d.id as string));
  }
  const items = orderIds.flatMap((id, i) => [
    { order_id: id, provider_line_key: "a", external_item_id: "1", item_name: "perf a", quantity: 1, discounted_unit_price: 60000, internal_product_id: A, total_cogs: 40000, cost_per_unit_snapshot: 40000 },
    { order_id: id, provider_line_key: "b", external_item_id: "2", item_name: "perf b", quantity: 1 + (i % 3), discounted_unit_price: 40000, internal_product_id: B, total_cogs: 10000 * (1 + (i % 3)), cost_per_unit_snapshot: 10000 },
  ]);
  for (let i = 0; i < items.length; i += 1000) {
    const { error } = await db.from("channel_order_items").insert(items.slice(i, i + 1000));
    if (error) throw error;
  }
  const fins = orderIds.map((id, i) => ({ order_id: id, estimated_order_revenue: 90000, internal_cogs: 40000 + 10000 * (1 + (i % 3)), ...(i % 2 ? { escrow_amount: 85000, escrow_amount_after_adjustment: 85000 } : {}) }));
  for (let i = 0; i < fins.length; i += 1000) {
    const { error } = await db.from("order_financials").insert(fins.slice(i, i + 1000));
    if (error) throw error;
  }
  const scope = scopeOf([s5]);
  const r = range("2035-06-01", "2035-06-30");
  const timed = async <T>(fn: () => Promise<T>) => {
    const t = performance.now();
    const v = await fn();
    return { v, ms: Math.round(performance.now() - t) };
  };
  const sum = await timed(() => getAnalyticsSummary(db, scope, r));
  const trend = await timed(() => getAnalyticsTrend(db, scope, r, "day"));
  const prods = await timed(() => getProductAnalytics(db, scope, r, { limit: 25 }));
  const loss = await timed(() => getLossOrders(db, scope, r));
  const quality = await timed(() => getDataQuality(db, scope, r));
  console.info(JSON.stringify({ perf: { orders: N, lines: items.length, summaryMs: sum.ms, trendMs: trend.ms, productsMs: prods.ms, lossMs: loss.ms, qualityMs: quality.ms } }));
  // expected count by VN calendar day (orders after 17:00 UTC on 30/06 are already 01/07 in Vietnam)
  const vnJune = orders.filter((o) => o.order_status !== "CANCELLED" && new Date(Date.parse(o.created_at_channel) + 7 * 3_600_000).toISOString().slice(0, 7) === "2035-06").length;
  assert.equal(sum.v.order_count, vnJune);
  assert.ok(vnJune < N - N / 25, "the UTC-midnight trap is really exercised");
  assert.equal(trend.v.length, 30, "30 points for 30 days, never one per order");
  assert.ok(prods.v.rows.length <= 25);
  for (const t of [sum, trend, prods, loss, quality]) assert.ok(t.ms < 5000, `query bounded (${t.ms} ms)`);
});
