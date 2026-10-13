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
let supplierId = "";
let n = 0;

before(async () => {
  supplierId = (await db.from("suppliers").select("id").eq("is_active", true).limit(1).single()).data!.id;
});

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
  await db.from("receipts").delete().eq("receiver_name", TAG);
  if (productIds.length) {
    await db.from("inventory_cost_ledger").delete().in("product_id", productIds);
    await db.from("products").delete().in("id", productIds);
  }
});

async function product(): Promise<string> {
  const { data, error } = await db.from("products").insert({ sku: `${TAG}_${++n}`, name: `cost ${n}`, unit: "chiec", current_price: 999999, supplier_id: supplierId }).select("id").single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id;
}

/** A real receipt through the app RPC (fires the cost triggers). */
async function receipt(items: Array<{ productId: string; qty: number | string; price: number | string }>, date = "2031-01-10") {
  const { data, error } = await db.rpc("create_receipt", {
    p_receipt_date: date,
    p_shift: "morning",
    p_supplier_id: supplierId,
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
async function order(lines: Array<{ productId: string | null; qty: number | string }>, opts2: { status?: string; paidAt?: string } = {}) {
  const { data: shop } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: "cost", data_source: "fixture" }).select("id").single();
  shopIds.push(shop!.id);
  const { data: o, error } = await db
    .from("channel_orders")
    .insert({ shop_id: shop!.id, external_order_sn: `${TAG}SN${n}`, order_status: opts2.status ?? "READY_TO_SHIP", currency: "VND", paid_at_channel: opts2.paidAt ?? "2031-01-15T03:00:00Z" })
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
  (await db.from("inventory_cost_ledger").select("event_type, quantity_change::text, unit_cost::text, qty_after::text, avg_cost_after::text, movement_cost::text, metadata").eq("product_id", p).order("event_time").order("order_key")).data!;

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
