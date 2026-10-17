// ============================================================
// SHOPEE-4 — Moving Weighted Average cost engine against the REAL database in
// .env.local (local Docker Supabase in dev):
//
//   node --env-file=.env.local --test src/lib/inventory-cost/cost-engine.integration.test.ts
//
// Purchases go through the app's own create_receipt / update_receipt RPCs, so
// the receipt triggers are exercised exactly as in production. Sale lines are
// fixture channel orders. Dates are in 2031 to stay clear of real data.
// Cleanup: shops (cascade orders), receipts, ledger rows, products.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { hasPermission } from "../auth/permissions.ts";
import { isOrderEligibleForInventoryOut } from "../channels/shopee/order-status.ts";
import { CostEngine } from "./engine.ts";
import { COSTING_VERSION } from "./types.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const db = createClient(url, serviceKey, opts);
const anon = createClient(url, anonKey, opts);
const engine = new CostEngine({ db, logger: () => {} });

const TAG = `s4${Date.now()}`;
const productIds: string[] = [];
const shopIds: string[] = [];
const supplierIds: string[] = [];
/** Household supplier (no VAT): the moving-average tests below are about the average, not VAT. */
let supplierId = "";
/** Company supplier: purchase cost = receipt price × (1 + invoice VAT). */
let companyId = "";
let n = 0;

async function supplier(type: "business_household" | "company"): Promise<string> {
  const { data, error } = await db.from("suppliers").insert({ code: `${TAG}_${type}_${++n}`, name: `cost ${type}`, supplier_type: type }).select("id").single();
  if (error) throw error;
  supplierIds.push(data.id);
  return data.id;
}

before(async () => {
  supplierId = await supplier("business_household");
  companyId = await supplier("company");
});

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
  // invoices first: their linked receipt days lock the receipts
  if (supplierIds.length) await db.from("invoices").delete().in("supplier_id", supplierIds);
  await db.from("receipts").delete().eq("receiver_name", TAG);
  if (productIds.length) {
    await db.from("inventory_cost_ledger").delete().in("product_id", productIds);
    await db.from("products").delete().in("id", productIds);
  }
  if (supplierIds.length) await db.from("suppliers").delete().in("id", supplierIds);
});

async function product(): Promise<string> {
  const { data, error } = await db.from("products").insert({ sku: `${TAG}_${++n}`, name: `cost ${n}`, unit: "chiec", current_price: 999999, supplier_id: supplierId }).select("id").single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id;
}

/** A real receipt through the app RPC (fires the cost triggers). */
async function receipt(items: Array<{ productId: string; qty: number | string; price: number | string }>, date = "2031-01-10", supplier = supplierId) {
  const { data, error } = await db.rpc("create_receipt", {
    p_receipt_date: date,
    p_shift: "morning",
    p_supplier_id: supplier,
    p_receiver_name: TAG,
    p_note: null,
    p_created_by: null,
    p_items: items.map((i) => ({ product_id: i.productId, unit_price: i.price, delivered_qty: i.qty, received_qty: i.qty })),
  });
  if (error) throw error;
  const receiptId = (Array.isArray(data) ? data[0] : data).receipt_id as string;
  const { data: rows } = await db.from("receipt_items").select("id, product_id").eq("receipt_id", receiptId);
  return { receiptId, itemIds: (rows ?? []).map((r) => r.id as string) };
}

/** A fixture channel order with one line per entry. */
async function order(lines: Array<{ productId: string | null; qty: number | string }>, opts2: { status?: string; paidAt?: string; total?: string } = {}) {
  const { data: shop } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: "cost", data_source: "fixture" }).select("id").single();
  shopIds.push(shop!.id);
  const { data: o, error } = await db
    .from("channel_orders")
    .insert({ shop_id: shop!.id, external_order_sn: `${TAG}SN${n}`, order_status: opts2.status ?? "READY_TO_SHIP", currency: "VND", paid_at_channel: opts2.paidAt ?? "2031-01-15T03:00:00Z", channel_total_amount: opts2.total ?? null })
    .select("id")
    .single();
  if (error) throw error;
  const itemIds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { data: it, error: e } = await db
      .from("channel_order_items")
      .insert({ order_id: o!.id, provider_line_key: `k${i}`, external_item_id: String(i), item_name: "x", quantity: lines[i].qty, internal_product_id: lines[i].productId })
      .select("id")
      .single();
    if (e) throw e;
    itemIds.push(it!.id);
  }
  return { orderId: o!.id as string, itemIds };
}

const state = async (p: string) => (await engine.getCurrentCost(p))!;
const item = async (id: string) =>
  (await db.from("channel_order_items").select("cost_method, cost_per_unit_snapshot::text, total_cogs::text, cogs_calculated_at, cogs_reversed_at").eq("id", id).single()).data!;
const ledger = async (p: string) =>
  (await db.from("inventory_cost_ledger").select("event_type, quantity_change::text, unit_cost::text, qty_after::text, avg_cost_after::text, movement_cost::text, metadata, base_unit_cost::text, vat_rate::text, cost_basis, invoice_id").eq("product_id", p).order("event_time").order("order_key")).data!;

// ------------------------------------------------------------ moving average

test("§55 / 1–6 / 17–19: 100@100k + 50@130k → avg 110k; sale 3 → COGS 330k; later purchase changes avg, not the old snapshot", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 100, price: 100000 }], "2031-01-01");
  await receipt([{ productId: p, qty: 50, price: 130000 }], "2031-01-02");
  let s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost, s.inventoryValue], ["150.0000", "110000.0000", "16500000.00"]);

  const o = await order([{ productId: p, qty: 3 }], { paidAt: "2031-01-03T02:00:00Z" });
  assert.equal(await engine.postSale(o.itemIds[0]), "calculated");
  let it = await item(o.itemIds[0]);
  assert.deepEqual([it.cost_method, it.cost_per_unit_snapshot, it.total_cogs], ["moving_average", "110000.0000", "330000.00"]);
  s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost, s.inventoryValue], ["147.0000", "110000.0000", "16170000.00"]);

  await receipt([{ productId: p, qty: 10, price: 140000 }], "2031-01-04");
  s = await state(p);
  // (147 × 110000 + 10 × 140000) / 157 = 111910.828025… → 4 dp
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost], ["157.0000", "111910.8280"]);
  it = await item(o.itemIds[0]);
  assert.equal(it.cost_per_unit_snapshot, "110000.0000", "historical snapshot unchanged");

  // A second sale after the new purchase uses the new average.
  const o2 = await order([{ productId: p, qty: 2 }], { paidAt: "2031-01-05T02:00:00Z" });
  await engine.postSale(o2.itemIds[0]);
  assert.deepEqual([(await item(o2.itemIds[0])).cost_per_unit_snapshot, (await item(o2.itemIds[0])).total_cogs], ["111910.8280", "223821.66"]);
});

test("20. products.current_price never affects COGS", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 5, price: 1000 }]);
  const o = await order([{ productId: p, qty: 1 }]);
  await engine.postSale(o.itemIds[0]);
  await db.from("products").update({ current_price: 1 }).eq("id", p);
  assert.equal((await item(o.itemIds[0])).cost_per_unit_snapshot, "1000.0000");
  assert.equal((await state(p)).movingAverageCost, "1000.0000");
});

// ------------------------------------------------------------ negative / missing

test("11–13: sale exceeding quantity → COGS at avg, negative flagged; later purchase restarts avg and recovers qty", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 10, price: 100 }], "2031-01-01");
  const o = await order([{ productId: p, qty: 12 }], { paidAt: "2031-01-02T00:00:00Z" });
  assert.equal(await engine.postSale(o.itemIds[0]), "calculated_negative");
  assert.equal((await item(o.itemIds[0])).total_cogs, "1200.00");
  assert.equal((await state(p)).quantityOnHand, "-2.0000");
  const sale = (await ledger(p)).find((l) => l.event_type === "sale_out")!;
  assert.equal((sale.metadata as { negative_inventory: boolean }).negative_inventory, true);
  const { data: neg } = await db.from("v_product_cost_overview").select("negative_quantity").eq("product_id", p).single();
  assert.equal(neg!.negative_quantity, true);

  await receipt([{ productId: p, qty: 5, price: 130 }], "2031-01-03");
  const s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost], ["3.0000", "130.0000"], "negative units were already costed out → avg restarts at the new cost");
});

test("7 + 9 + 10: sale before any purchase → no cost, nothing posted, NULL (not 0); unmapped and UNPAID lines are skipped", async () => {
  const p = await product();
  const o = await order([{ productId: p, qty: 1 }, { productId: null, qty: 1 }], { paidAt: "2031-01-01T00:00:00Z" });
  const counts = await engine.processOrder(o.orderId);
  assert.deepEqual(counts, { no_cost: 1, unmapped: 1 });
  const it = await item(o.itemIds[0]);
  assert.deepEqual([it.cost_per_unit_snapshot, it.total_cogs, it.cost_method], [null, null, null]);
  assert.equal((await ledger(p)).length, 0, "no fake sale event");
  const { data: sum } = await db.from("v_channel_order_summary").select("cogs_readiness, total_cogs, partial_cogs_sum").eq("order_id", o.orderId).single();
  assert.deepEqual(sum, { cogs_readiness: "incomplete", total_cogs: null, partial_cogs_sum: null });

  // A purchase dated AFTER the sale cannot cost it (historical moment); a back-dated one can.
  await receipt([{ productId: p, qty: 5, price: 700 }], "2031-01-05");
  assert.deepEqual(await engine.processOrder(o.orderId), { no_cost: 1, unmapped: 1 });
  await receipt([{ productId: p, qty: 5, price: 500 }], "2030-12-31");
  assert.deepEqual(await engine.processOrder(o.orderId), { calculated: 1, unmapped: 1 });
  assert.equal((await item(o.itemIds[0])).cost_per_unit_snapshot, "500.0000");

  const p2 = await product();
  await receipt([{ productId: p2, qty: 5, price: 1 }]);
  const unpaid = await order([{ productId: p2, qty: 1 }], { status: "UNPAID" });
  assert.deepEqual(await engine.processOrder(unpaid.orderId), { ineligible: 1 });
});

test("10b. a confirmed zero-cost purchase gives COGS 0 (zero ≠ unknown); zero received qty posts nothing", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 4, price: 0 }]);
  const o = await order([{ productId: p, qty: 1 }]);
  await engine.postSale(o.itemIds[0]);
  assert.equal((await item(o.itemIds[0])).total_cogs, "0.00");
  const p2 = await product();
  await receipt([{ productId: p2, qty: 0, price: 50 }]);
  assert.equal((await ledger(p2)).length, 0);
});

// ------------------------------------------------------------ idempotency

test("14–16: duplicate receipt posting / sale posting / order processing never double-counts", async () => {
  const p = await product();
  const r = await receipt([{ productId: p, qty: 10, price: 100 }]);
  assert.equal(await engine.postPurchase(r.itemIds[0]), "posted");
  assert.equal(await engine.postPurchase(r.itemIds[0]), "posted");
  assert.equal((await ledger(p)).filter((l) => l.event_type === "purchase_in").length, 1);

  const o = await order([{ productId: p, qty: 2 }]);
  assert.equal(await engine.postSale(o.itemIds[0]), "calculated");
  assert.equal(await engine.postSale(o.itemIds[0]), "already");
  assert.deepEqual(await engine.processOrder(o.orderId), { already: 1 });
  assert.equal((await ledger(p)).filter((l) => l.event_type === "sale_out").length, 1);
  assert.equal((await state(p)).quantityOnHand, "8.0000");
});

// ------------------------------------------------------------ reversal

test("21–23: cancellation reverses at the ORIGINAL snapshot cost, keeps the sale event and snapshot, only once", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 10, price: 100 }], "2031-01-01");
  const o = await order([{ productId: p, qty: 2 }], { paidAt: "2031-01-02T00:00:00Z" });
  await engine.processOrder(o.orderId);
  assert.equal((await state(p)).quantityOnHand, "8.0000");
  await receipt([{ productId: p, qty: 8, price: 200 }], "2031-01-03"); // avg → 150

  await db.from("channel_orders").update({ order_status: "CANCELLED", updated_at_channel: "2031-01-04T00:00:00Z" }).eq("id", o.orderId);
  assert.deepEqual(await engine.processOrder(o.orderId), { reversed: 1 });
  assert.deepEqual(await engine.processOrder(o.orderId), { already: 1 });
  const s = await state(p);
  // (16 × 150 + 2 × 100) / 18 = 144.4444…
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost], ["18.0000", "144.4444"]);
  const it = await item(o.itemIds[0]);
  assert.equal(it.cost_per_unit_snapshot, "100.0000", "snapshot kept");
  assert.ok(it.cogs_reversed_at);
  const events = (await ledger(p)).map((l) => l.event_type);
  assert.deepEqual(events, ["purchase_in", "sale_out", "purchase_in", "sale_reversal_in"]);
  const { data: fin } = await db.from("order_financials").select("internal_cogs::text").eq("order_id", o.orderId).single();
  assert.equal(fin!.internal_cogs, "0.00", "reversed line no longer counts in internal COGS");
});

// ------------------------------------------------------------ rebuild / receipts

test("24–27: deterministic order regardless of entry order; edits/deletes rebuild; old snapshots untouched", async () => {
  const p = await product();
  // Entered out of chronological order.
  await receipt([{ productId: p, qty: 50, price: 130000 }], "2031-02-02");
  await receipt([{ productId: p, qty: 100, price: 100000 }], "2031-02-01");
  assert.equal((await state(p)).movingAverageCost, "110000.0000", "same result as chronological entry");

  const o = await order([{ productId: p, qty: 3 }], { paidAt: "2031-02-03T00:00:00Z" });
  await engine.postSale(o.itemIds[0]);

  // Edit the first receipt's price through the app RPC (rebuild via trigger).
  const { data: first } = await db.from("receipts").select("id, receipt_date, shift, supplier_id, receiver_name").eq("receiver_name", TAG).eq("receipt_date", "2031-02-01").single();
  const { data: firstItem } = await db.from("receipt_items").select("id").eq("receipt_id", first!.id).single();
  const { error } = await db.rpc("update_receipt", {
    p_receipt_id: first!.id, p_receipt_date: "2031-02-01", p_shift: "morning", p_supplier_id: first!.supplier_id, p_receiver_name: TAG, p_note: null,
    p_items: [{ id: firstItem!.id, product_id: p, unit_price: 70000, delivered_qty: 100, received_qty: 100 }],
  });
  assert.equal(error, null);
  // (100 × 70000 + 50 × 130000) / 150 = 90000 ; after selling 3 → 147 @ 90000
  let s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost], ["147.0000", "90000.0000"]);
  assert.equal((await item(o.itemIds[0])).cost_per_unit_snapshot, "110000.0000", "historical COGS is immutable");
  const saleRow = (await ledger(p)).find((l) => l.event_type === "sale_out")!;
  assert.equal(saleRow.unit_cost, "90000.0000", "ledger shows the current reconstruction (documented difference)");

  // Manual rebuild is idempotent and audited.
  const before = await state(p);
  await engine.rebuildProduct(p, { reason: "test" });
  assert.deepEqual(await state(p), before);
  const { count } = await db.from("inventory_cost_rebuilds").select("id", { count: "exact", head: true }).eq("product_id", p).eq("reason", "test");
  assert.equal(count, 1);

  // Delete the second receipt → purchase removed, state recomputed.
  await db.from("receipts").delete().eq("receiver_name", TAG).eq("receipt_date", "2031-02-02");
  s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost], ["97.0000", "70000.0000"]);
});

test("receipt date change re-places the purchase in time", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 10, price: 100 }], "2031-03-01");
  const late = await receipt([{ productId: p, qty: 10, price: 300 }], "2031-03-10");
  const o = await order([{ productId: p, qty: 1 }], { paidAt: "2031-03-05T00:00:00Z" });
  await engine.postSale(o.itemIds[0]);
  assert.equal((await item(o.itemIds[0])).cost_per_unit_snapshot, "100.0000");
  await db.from("receipts").update({ receipt_date: "2031-03-02" }).eq("id", late.receiptId);
  const rows = await ledger(p);
  assert.deepEqual(rows.map((r) => r.event_type), ["purchase_in", "purchase_in", "sale_out"]);
  assert.equal(rows[2].unit_cost, "200.0000");
});

// ------------------------------------------------------------ concurrency

test("28–30: concurrent sales / purchases on one product serialize correctly", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 100, price: 50 }]);
  const orders = await Promise.all(Array.from({ length: 8 }, () => order([{ productId: p, qty: 1 }])));
  const results = await Promise.all(orders.map((o) => engine.processOrder(o.orderId)));
  assert.ok(results.every((r) => r.calculated === 1));
  assert.equal((await state(p)).quantityOnHand, "92.0000");

  await Promise.all([
    receipt([{ productId: p, qty: 10, price: 50 }]),
    receipt([{ productId: p, qty: 10, price: 50 }]),
    ...Array.from({ length: 3 }, async () => engine.processOrder((await order([{ productId: p, qty: 2 }])).orderId)),
  ]);
  const s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost], ["106.0000", "50.0000"]);
  const { count } = await db.from("inventory_cost_ledger").select("id", { count: "exact", head: true }).eq("product_id", p).eq("event_type", "sale_out");
  assert.equal(count, 11);
});

// ------------------------------------------------------------ precision

test("31–33: decimal quantities and unit costs, deterministic rounding", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: "3.5", price: "100.01" }], "2031-04-01");
  await receipt([{ productId: p, qty: "6.5", price: "99.99" }], "2031-04-02");
  // (3.5 × 100.01 + 6.5 × 99.99) / 10 = 99.997
  assert.equal((await state(p)).movingAverageCost, "99.9970");
  const o = await order([{ productId: p, qty: "1.5" }], { paidAt: "2031-04-03T00:00:00Z" });
  await engine.postSale(o.itemIds[0]);
  const it = await item(o.itemIds[0]);
  assert.deepEqual([it.cost_per_unit_snapshot, it.total_cogs], ["99.9970", "150.00"], "1.5 × 99.997 = 149.9955 → 150.00");
  const s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.inventoryValue], ["8.5000", "849.97"], "8.5 × 99.997 = 849.9745 → 849.97");
});

// ------------------------------------------------------------ immutability / financials

test("COGS snapshot immutable at DB level (CG001/CG002); internal_cogs only when every line is costed", async () => {
  const p = await product();
  const p2 = await product();
  await receipt([{ productId: p, qty: 5, price: 10 }]);
  const o = await order([{ productId: p, qty: 1 }, { productId: p2, qty: 1 }]);
  await engine.processOrder(o.orderId);
  let fin = (await db.from("order_financials").select("internal_cogs").eq("order_id", o.orderId).maybeSingle()).data;
  assert.equal(fin?.internal_cogs ?? null, null, "partial → no authoritative total");
  const { data: sum } = await db.from("v_channel_order_summary").select("cogs_readiness, total_cogs, partial_cogs_sum").eq("order_id", o.orderId).single();
  assert.deepEqual(sum, { cogs_readiness: "partial", total_cogs: null, partial_cogs_sum: "10.00" });

  await receipt([{ productId: p2, qty: 5, price: 20 }], "2031-01-01");
  await engine.processOrder(o.orderId);
  fin = (await db.from("order_financials").select("internal_cogs::text").eq("order_id", o.orderId).single()).data;
  assert.equal(fin!.internal_cogs, "30.00");

  const upd = await db.from("channel_order_items").update({ total_cogs: 1 }).eq("id", o.itemIds[0]);
  assert.equal(upd.error?.code, "CG001");
  const qty = await db.from("channel_order_items").update({ quantity: 9 }).eq("id", o.itemIds[0]);
  assert.equal(qty.error?.code, "CG001");
  const del = await db.from("channel_order_items").delete().eq("id", o.itemIds[0]);
  assert.equal(del.error?.code, "CG002");
});

test("opening balance (future baseline) is an IN event with its own cost", async () => {
  const p = await product();
  const { error } = await db.rpc("cost_post_manual_event", { p_product_id: p, p_event_type: "opening_balance", p_quantity: 20, p_unit_cost: 80, p_event_time: "2030-12-01T00:00:00Z", p_note: "test" });
  assert.equal(error, null);
  await receipt([{ productId: p, qty: 20, price: 120 }]);
  assert.equal((await state(p)).movingAverageCost, "100.0000");
});

// ------------------------------------------------------------ permissions / rules

test("34–36: only the server can run the engine; permission matrix", async () => {
  for (const fn of ["cost_rebuild_all", "cost_process_order", "cost_apply_order_item"]) {
    const { error } = await anon.rpc(fn, fn === "cost_rebuild_all" ? { p_triggered_by: null } : fn === "cost_process_order" ? { p_order_id: "00000000-0000-0000-0000-000000000000" } : { p_order_item_id: "00000000-0000-0000-0000-000000000000" });
    assert.ok(error, `${fn} denied to anon`);
  }
  const ins = await anon.from("inventory_cost_ledger").insert({ product_id: productIds[0], event_type: "adjustment_in", source_type: "manual_adjustment", event_time: new Date().toISOString(), order_key: "x", quantity_change: 1, unit_cost: 1 });
  assert.ok(ins.error, "no direct ledger writes");
  assert.equal(hasPermission("viewer", "cost:view"), true);
  assert.equal(hasPermission("staff", "cost:view"), true);
  assert.equal(hasPermission("staff", "cost:manage"), false);
  assert.equal(hasPermission("viewer", "cost:manage"), false);
  assert.equal(hasPermission("admin", "cost:manage"), true);
});

test("inventory-out status rule: TS mirror == DB rule", async () => {
  for (const status of ["UNPAID", "READY_TO_SHIP", "PROCESSED", "RETRY_SHIP", "SHIPPED", "TO_CONFIRM_RECEIVE", "IN_CANCEL", "CANCELLED", "TO_RETURN", "COMPLETED", "NEW_STATUS"]) {
    const { data, error } = await db.rpc("cost_order_status_eligible", { p_status: status });
    assert.equal(error, null);
    assert.equal(isOrderEligibleForInventoryOut(status), data, status);
  }
});

// ================================================================ PATCH: VAT-adjusted purchase cost
// Company receipts are costed at receipt price × (1 + VAT of the invoice
// linked to that receipt day — invoice_receipt_days); household receipts at
// the receipt price. No linked invoice → cost unknown ("VAT pending").

/** A company invoice linking whole receipt days (as "Tạo hóa đơn từ hàng đã nhận" does). */
async function invoiceFor(dates: string[], vatRate: number, supplier = companyId): Promise<string> {
  const { data, error } = await db
    .from("invoices")
    .insert({ invoice_no: `${TAG}-HD${++n}`, supplier_id: supplier, invoice_date: dates[0], vat_rate: vatRate, source_type: "from_receipts", receipt_start_date: [...dates].sort()[0] })
    .select("id")
    .single();
  if (error) throw error;
  const link = await db.from("invoice_receipt_days").insert(dates.map((d) => ({ invoice_id: data.id, supplier_id: supplier, receipt_date: d })));
  if (link.error) throw link.error;
  return data.id;
}
const purchases = async (p: string) => (await ledger(p)).filter((l) => l.event_type === "purchase_in");

test("PATCH 10–12: company + invoice VAT 8 % → 108.000; other VAT rate from ITS invoice; household → receipt price, no VAT", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 10, price: 100000 }], "2032-01-01", companyId);
  const inv = await invoiceFor(["2032-01-01"], 8);
  let [row] = await purchases(p);
  assert.deepEqual([row.base_unit_cost, row.vat_rate, row.cost_basis, row.unit_cost, row.invoice_id], ["100000.0000", "8.00", "invoice_vat", "108000.0000", inv]);
  assert.equal((await state(p)).movingAverageCost, "108000.0000");

  const p10 = await product();
  await receipt([{ productId: p10, qty: 1, price: 100000 }], "2032-01-02", companyId);
  await invoiceFor(["2032-01-02"], 10);
  assert.equal((await purchases(p10))[0].unit_cost, "110000.0000", "VAT rate comes from the invoice snapshot, not a constant");

  const ph = await product();
  await receipt([{ productId: ph, qty: 1, price: 100000 }], "2032-01-03", supplierId);
  [row] = await purchases(ph);
  assert.deepEqual([row.base_unit_cost, row.vat_rate, row.cost_basis, row.unit_cost], ["100000.0000", null, "raw", "100000.0000"], "household: no VAT added");
});

/** cost_settings.default_vat_rate (00054). Changing it rebuilds every provisional product (trigger). */
async function setDefaultVat(rate: number | null) {
  const { error } = await db.from("cost_settings").update({ default_vat_rate: rate }).eq("id", true);
  if (error) throw error;
}
const provisionalOf = async (itemId: string) =>
  (await db.from("channel_order_items").select("cost_provisional").eq("id", itemId).single()).data!.cost_provisional as boolean;

test("PATCH provisional VAT: company receipt without invoice → default VAT 8 % 'Tạm tính'; provisional COGS; invoice VAT 10 % trues it up (audited); final snapshot then locked", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 10, price: 100000 }], "2032-07-01", companyId);
  const [row] = await purchases(p);
  assert.deepEqual([row.base_unit_cost, row.unit_cost, row.cost_basis, row.vat_rate, row.invoice_id], ["100000.0000", "108000.0000", "provisional_vat", "8.00", null]);
  const ov = async () => (await db.from("v_product_cost_overview").select("moving_average_cost, cost_provisional, vat_pending").eq("product_id", p).single()).data!;
  assert.deepEqual(await ov(), { moving_average_cost: "108000.0000", cost_provisional: true, vat_pending: false });

  // sale at the provisional cost: COGS known now, flagged provisional
  const o = await order([{ productId: p, qty: 2 }], { paidAt: "2032-07-02T00:00:00Z", total: "400000" });
  assert.deepEqual(await engine.processOrder(o.orderId), { calculated: 1 });
  assert.deepEqual([(await item(o.itemIds[0])).total_cogs, await provisionalOf(o.itemIds[0])], ["216000.00", true]);
  assert.equal((await db.from("order_financials").select("internal_cogs::text").eq("order_id", o.orderId).single()).data!.internal_cogs, "216000.00");
  assert.equal((await db.from("v_channel_order_summary").select("cogs_provisional").eq("order_id", o.orderId).single()).data!.cogs_provisional, true);
  // provisional lines are not restatement candidates (they true up by themselves)
  assert.equal((await engine.restatementCandidates(5000)).filter((c) => c.productId === p).length, 0);

  // a household purchase on top keeps the average provisional (provisional units still in stock)
  await receipt([{ productId: p, qty: 2, price: 90000 }], "2032-07-03", supplierId);
  assert.equal((await ov()).cost_provisional, true);

  // the invoice arrives with a DIFFERENT VAT (10 %) → rebuild → provisional COGS corrected, now final
  await invoiceFor(["2032-07-01"], 10);
  const [fixed] = await purchases(p);
  assert.deepEqual([fixed.unit_cost, fixed.cost_basis, fixed.vat_rate], ["110000.0000", "invoice_vat", "10.00"]);
  assert.equal((await ov()).cost_provisional, false);
  assert.deepEqual([(await item(o.itemIds[0])).cost_per_unit_snapshot, (await item(o.itemIds[0])).total_cogs, await provisionalOf(o.itemIds[0])], ["110000.0000", "220000.00", false]);
  assert.equal((await db.from("order_financials").select("internal_cogs::text").eq("order_id", o.orderId).single()).data!.internal_cogs, "220000.00");
  const { data: audit } = await db.from("cogs_restatements").select("old_total_cogs::text, new_total_cogs::text, source, reason, adjusted_by").eq("order_item_id", o.itemIds[0]);
  assert.deepEqual(audit, [{ old_total_cogs: "216000.00", new_total_cogs: "220000.00", source: "provisional_true_up", reason: "Tự động: giá vốn tạm tính → VAT hóa đơn", adjusted_by: null }]);

  // final now: a later VAT edit rebuilds the ledger but never touches this snapshot
  await db.from("invoices").update({ vat_rate: 8 }).eq("invoice_no", (await db.from("invoice_receipt_days").select("invoices(invoice_no)").eq("supplier_id", companyId).eq("receipt_date", "2032-07-01").single()).data!.invoices!.invoice_no);
  assert.equal((await item(o.itemIds[0])).total_cogs, "220000.00", "a final snapshot is history — only explicit restatement changes it");
  assert.equal((await engine.restatementCandidates(5000)).filter((c) => c.productId === p).length, 1);
});

test("PATCH provisional VAT: same VAT on the invoice clears the flag without an audit row; default VAT change re-costs provisional purchases", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 4, price: 50000 }], "2032-08-01", companyId);
  const o = await order([{ productId: p, qty: 1 }], { paidAt: "2032-08-02T00:00:00Z" });
  await engine.processOrder(o.orderId);
  assert.deepEqual([(await item(o.itemIds[0])).total_cogs, await provisionalOf(o.itemIds[0])], ["54000.00", true]);
  try {
    await setDefaultVat(10);
    assert.equal((await purchases(p))[0].unit_cost, "55000.0000", "default VAT edit re-costs provisional purchases (trigger)");
    assert.deepEqual([(await item(o.itemIds[0])).total_cogs, await provisionalOf(o.itemIds[0])], ["55000.00", true], "still provisional, follows the default");
  } finally {
    await setDefaultVat(8);
  }
  assert.equal((await item(o.itemIds[0])).total_cogs, "54000.00");
  await invoiceFor(["2032-08-01"], 8);
  assert.deepEqual([(await item(o.itemIds[0])).total_cogs, await provisionalOf(o.itemIds[0])], ["54000.00", false]);
  const { data: audit } = await db.from("cogs_restatements").select("new_total_cogs::text, reason").eq("order_item_id", o.itemIds[0]).order("adjusted_at");
  assert.deepEqual(
    audit!.map((a) => a.new_total_cogs),
    ["55000.00", "54000.00"],
    "audit rows only for value changes (default 8→10→8); the invoice at the same 8 % only finalises",
  );
});

test("PATCH 13 + 22 (no default VAT configured): company receipt without an invoice → no fabricated cost; sale waits; linking the invoice fills COGS; cancelled pending sale is withdrawn", async () => {
  await setDefaultVat(null);
  try {
    await vatPendingScenario();
  } finally {
    await setDefaultVat(8);
  }
});

async function vatPendingScenario() {
  const p = await product();
  await receipt([{ productId: p, qty: 10, price: 100000 }], "2032-02-01", companyId);
  const [row] = await purchases(p);
  assert.deepEqual([row.unit_cost, row.cost_basis, row.vat_rate], [null, "vat_pending", null]);
  let s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost], ["10.0000", null]);
  assert.equal((await db.from("v_product_cost_overview").select("vat_pending").eq("product_id", p).single()).data!.vat_pending, true);

  const o = await order([{ productId: p, qty: 2 }], { paidAt: "2032-02-02T00:00:00Z" });
  assert.deepEqual(await engine.processOrder(o.orderId), { cost_pending: 1 });
  assert.deepEqual([(await item(o.itemIds[0])).total_cogs, (await item(o.itemIds[0])).cost_per_unit_snapshot], [null, null], "COGS Chưa tính — never a guessed cost");
  assert.equal((await state(p)).quantityOnHand, "8.0000", "the sale still moves the costing quantity");
  const sale = (await ledger(p)).find((l) => l.event_type === "sale_out")!;
  assert.equal((sale.metadata as { cost_pending: boolean }).cost_pending, true);
  assert.equal((await db.from("order_financials").select("internal_cogs").eq("order_id", o.orderId).maybeSingle()).data?.internal_cogs ?? null, null);
  assert.deepEqual(await engine.processOrder(o.orderId), { cost_pending: 1 }, "idempotent while pending");

  const cancelled = await order([{ productId: p, qty: 1 }], { paidAt: "2032-02-03T00:00:00Z" });
  await engine.processOrder(cancelled.orderId);
  await db.from("channel_orders").update({ order_status: "CANCELLED", updated_at_channel: "2032-02-04T00:00:00Z" }).eq("id", cancelled.orderId);
  assert.deepEqual(await engine.processOrder(cancelled.orderId), { withdrawn_pending: 1 });
  assert.equal((await state(p)).quantityOnHand, "8.0000", "withdrawn, not reversed at an unknown cost");

  // The invoice for that day is created → rebuild (trigger) → first COGS fill
  await invoiceFor(["2032-02-01"], 8);
  s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost], ["8.0000", "108000.0000"]);
  const it = await item(o.itemIds[0]);
  assert.deepEqual([it.cost_per_unit_snapshot, it.total_cogs], ["108000.0000", "216000.00"]);
  assert.equal((await db.from("channel_order_items").select("cost_version").eq("id", o.itemIds[0]).single()).data!.cost_version, COSTING_VERSION);
  assert.equal((await db.from("order_financials").select("internal_cogs::text").eq("order_id", o.orderId).single()).data!.internal_cogs, "216000.00");
  assert.equal(await provisionalOf(o.itemIds[0]), false, "invoice VAT = final cost");
  assert.deepEqual(await engine.processOrder(o.orderId), { already: 1 });
}

test("PATCH §23 / 15–18: moving average over VAT-adjusted costs; sale of 2 → 230.400; a later purchase never changes the old snapshot", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 100, price: 100000 }], "2032-03-01", companyId);
  await receipt([{ productId: p, qty: 50, price: 120000 }], "2032-03-02", companyId);
  await invoiceFor(["2032-03-01", "2032-03-02"], 8);
  // (100 × 108.000 + 50 × 129.600) / 150 = 115.200
  const s = await state(p);
  assert.deepEqual([s.quantityOnHand, s.movingAverageCost], ["150.0000", "115200.0000"]);
  const first = (await purchases(p))[0];
  assert.equal(first.avg_cost_after, "108000.0000", "first purchase: average = its effective cost");

  const o = await order([{ productId: p, qty: 2 }], { paidAt: "2032-03-03T00:00:00Z" });
  assert.equal(await engine.postSale(o.itemIds[0]), "calculated");
  assert.deepEqual([(await item(o.itemIds[0])).cost_per_unit_snapshot, (await item(o.itemIds[0])).total_cogs], ["115200.0000", "230400.00"]);

  await receipt([{ productId: p, qty: 10, price: 200000 }], "2032-03-04", supplierId);
  assert.notEqual((await state(p)).movingAverageCost, "115200.0000");
  assert.equal((await item(o.itemIds[0])).total_cogs, "230400.00", "future purchase does not touch the historical snapshot");
});

test("PATCH 14 + 19 + 26: VAT is never applied twice — rebuilds, VAT edits back and forth always start from the raw receipt price", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 5, price: 100000 }], "2032-04-01", companyId);
  const inv = await invoiceFor(["2032-04-01"], 8);
  for (let i = 0; i < 3; i++) await engine.rebuildProduct(p, { reason: "test" });
  assert.equal((await purchases(p))[0].unit_cost, "108000.0000");
  await db.from("invoices").update({ vat_rate: 10 }).eq("id", inv);
  assert.equal((await purchases(p))[0].unit_cost, "110000.0000", "VAT edit on the invoice rebuilds (trigger)");
  await db.from("invoices").update({ vat_rate: 8 }).eq("id", inv);
  await engine.rebuildAll();
  const [row] = await purchases(p);
  assert.deepEqual([row.base_unit_cost, row.unit_cost], ["100000.0000", "108000.0000"]);
  assert.equal((await state(p)).movingAverageCost, "108000.0000");
  // supplier type change is a VAT input too
  await db.from("suppliers").update({ supplier_type: "business_household" }).eq("id", companyId);
  assert.deepEqual([(await purchases(p))[0].cost_basis, (await purchases(p))[0].unit_cost], ["raw", "100000.0000"]);
  await db.from("suppliers").update({ supplier_type: "company" }).eq("id", companyId);
  assert.equal((await purchases(p))[0].unit_cost, "108000.0000");
});

test("PATCH 20–25 + §24: rebuild never restates history; dry-run diff; explicit restatement updates the snapshot, audit row, internal COGS and estimated profit", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 10, price: 200000 }], "2032-05-01", companyId);
  const inv = await invoiceFor(["2032-05-01"], 0); // invoice first entered without VAT
  const o = await order([{ productId: p, qty: 1 }], { paidAt: "2032-05-02T00:00:00Z", total: "350000" });
  await engine.processOrder(o.orderId);
  assert.equal((await item(o.itemIds[0])).total_cogs, "200000.00");
  assert.equal((await db.rpc("apply_order_estimated_revenue", { p_order_id: o.orderId, p_amount: "300000", p_synced_at: new Date().toISOString() })).error, null);
  const view = async () =>
    (await db.from("v_channel_order_summary").select("internal_cogs, estimated_profit, estimated_margin_pct").eq("order_id", o.orderId).single()).data!;
  assert.deepEqual(await view(), { internal_cogs: "200000.00", estimated_profit: "100000.00", estimated_margin_pct: "28.6" });

  // VAT corrected to 8 % → ledger rebuilt (trigger) … but the order's COGS stays (20)
  await db.from("invoices").update({ vat_rate: 8 }).eq("id", inv);
  assert.equal((await state(p)).movingAverageCost, "216000.0000");
  assert.equal((await item(o.itemIds[0])).total_cogs, "200000.00", "historical COGS unchanged by default");
  assert.equal((await view()).internal_cogs, "200000.00");

  // dry-run (21, 22)
  const mine = (await engine.restatementCandidates(5000)).filter((c) => c.productId === p);
  assert.equal(mine.length, 1);
  assert.deepEqual(
    [mine[0].orderItemId, mine[0].oldCostPerUnit, mine[0].newCostPerUnit, mine[0].oldTotalCogs, mine[0].newTotalCogs, mine[0].difference, mine[0].restatable],
    [o.itemIds[0], "200000.0000", "216000.0000", "200000.00", "216000.00", "16000.00", true],
  );
  const summary = await engine.restatementSummary();
  assert.ok(summary.affectedLines >= 1 && summary.restatableLines >= 1);
  // LOCAL-LIVE-1 §41/§43: per-product preview with old vs new estimated profit
  const preview = await engine.previewHistoricalCogsRestatement(p);
  assert.equal(preview.ordersAffected, 1);
  assert.deepEqual(
    [preview.lines[0].oldTotalCogs, preview.lines[0].newTotalCogs, preview.lines[0].difference, preview.lines[0].oldOrderEstimatedProfit, preview.lines[0].newOrderInternalCogs, preview.lines[0].newOrderEstimatedProfit],
    ["200000.00", "216000.00", "16000.00", "100000.00", "216000.00", "84000.00"],
  );
  assert.equal((await engine.previewHistoricalCogsRestatement((await product()))).lines.length, 0, "other products are not included");
  assert.equal((await item(o.itemIds[0])).total_cogs, "200000.00", "dry-run changes nothing");
  assert.equal((await view()).estimated_profit, "100000.00", "preview does not touch estimated profit");

  // explicit restatement (23–25); reason required
  await assert.rejects(engine.restateOrderCogs([o.itemIds[0]], "  "), /lý do/);
  const r = await engine.restateOrderCogs([o.itemIds[0]], "VAT đầu vào 8 %", null);
  assert.deepEqual([r.restated, r.skipped, r.orders, r.oldTotal, r.newTotal], [1, 0, 1, "200000.00", "216000.00"]);
  const it = await item(o.itemIds[0]);
  assert.deepEqual([it.cost_per_unit_snapshot, it.total_cogs], ["216000.0000", "216000.00"]);
  // §24: 300.000 − 216.000 = 84.000; margin over the order total 350.000 → 24,0 %
  assert.deepEqual(await view(), { internal_cogs: "216000.00", estimated_profit: "84000.00", estimated_margin_pct: "24.0" });
  const { data: audit } = await db
    .from("cogs_restatements")
    .select("batch_id, old_cost_per_unit::text, new_cost_per_unit::text, old_total_cogs::text, new_total_cogs::text, old_cost_version, new_cost_version, reason, adjusted_at")
    .eq("order_item_id", o.itemIds[0]);
  assert.equal(audit!.length, 1);
  assert.deepEqual(
    [audit![0].old_cost_per_unit, audit![0].new_cost_per_unit, audit![0].old_total_cogs, audit![0].new_total_cogs, audit![0].new_cost_version, audit![0].reason, audit![0].batch_id],
    ["200000.0000", "216000.0000", "200000.00", "216000.00", COSTING_VERSION, "VAT đầu vào 8 %", r.batchId],
  );
  assert.ok(audit![0].adjusted_at);

  // 26: nothing left to restate, a second run is a no-op (no double VAT)
  assert.equal((await engine.restatementCandidates(5000)).filter((c) => c.productId === p).length, 0);
  assert.equal((await engine.restateOrderCogs([o.itemIds[0]], "again")).restated, 0);
  await engine.rebuildProduct(p);
  assert.equal((await item(o.itemIds[0])).total_cogs, "216000.00");
});

test("PATCH restatement safety: pending (unknown) new cost is not restatable; direct snapshot edits still blocked; anon cannot restate", async () => {
  const p = await product();
  await receipt([{ productId: p, qty: 5, price: 1000 }], "2032-06-01", companyId);
  const inv = await invoiceFor(["2032-06-01"], 8);
  const o = await order([{ productId: p, qty: 1 }], { paidAt: "2032-06-02T00:00:00Z" });
  await engine.processOrder(o.orderId);
  assert.equal((await item(o.itemIds[0])).total_cogs, "1080.00");
  // invoice deleted with no default VAT configured → the day is no longer linked → new cost unknown
  await setDefaultVat(null);
  try {
    await db.from("invoices").delete().eq("id", inv);
    const [c] = (await engine.restatementCandidates(5000)).filter((x) => x.productId === p);
    assert.deepEqual([c.newCostPerUnit, c.restatable], [null, false]);
    const [pl] = (await engine.previewHistoricalCogsRestatement(p)).lines;
    assert.deepEqual([pl.newCostPerUnit, pl.restatable, pl.newOrderEstimatedProfit], [null, false, null], "unknown new cost → unknown new profit, never zero");
    assert.equal((await engine.restateOrderCogs([o.itemIds[0]], "thử")).restated, 0, "never restated to an unknown cost");
    assert.equal((await item(o.itemIds[0])).total_cogs, "1080.00");
  } finally {
    await setDefaultVat(8);
  }
  // with the default back, the purchase is provisional at 1.080 again; the FINAL snapshot was never touched
  assert.deepEqual([(await item(o.itemIds[0])).total_cogs, await provisionalOf(o.itemIds[0])], ["1080.00", false]);

  const upd = await db.from("channel_order_items").update({ total_cogs: 1 }).eq("id", o.itemIds[0]);
  assert.equal(upd.error?.code, "CG001", "only the restatement function may change a locked snapshot");
  for (const [fn, args] of [
    ["cost_restate_order_cogs", { p_item_ids: [o.itemIds[0]], p_reason: "x", p_by: null }],
    ["cost_restatement_candidates", { p_limit: 1 }],
    ["cost_restatement_preview_product", { p_product_id: p }],
    ["apply_order_estimated_revenue", { p_order_id: o.orderId, p_amount: 1, p_synced_at: new Date().toISOString() }],
  ] as const) {
    const { error } = await anon.rpc(fn, args);
    assert.ok(error, `${fn} denied to anon`);
  }
});
