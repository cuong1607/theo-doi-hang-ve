// ============================================================
// PRODUCT-COMBO-1 — combo SKU + BOM + atomic COGS + atomic inventory against
// the REAL database in .env.local (local Docker Supabase in dev):
//
//   node --env-file=.env.local --test src/lib/products/combo.integration.test.ts
//
// Purchases go through create_receipt (receipt triggers → cost ledger), sales
// are fixture channel orders costed by the engine. Dates in 2033.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { CostEngine } from "../inventory-cost/engine.ts";
import { calculateComboAvailableQty, ComboError, createComboProduct, deleteComboProduct, explodeComboForInventory, getComboOverview, getOrderItemComponentSnapshots, updateComboProduct, validateComboDefinition } from "./combo.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const engine = new CostEngine({ db, logger: () => {} });

const TAG = `pc${Date.now()}`;
const productIds: string[] = [];
const comboIds: string[] = [];
const shopIds: string[] = [];
let supplierId = "";
let n = 0;

before(async () => {
  const { data, error } = await db.from("suppliers").insert({ code: `${TAG}_hh`, name: "combo household", supplier_type: "business_household" }).select("id").single();
  if (error) throw error;
  supplierId = data.id;
});

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
  await db.from("receipts").delete().eq("receiver_name", TAG);
  const all = [...productIds, ...comboIds];
  if (all.length) {
    await db.from("inventory_cost_ledger").delete().in("product_id", productIds);
    await db.from("products").delete().in("id", comboIds);
    await db.from("products").delete().in("id", productIds);
  }
  if (supplierId) await db.from("suppliers").delete().eq("id", supplierId);
});

async function atomic(sku = `${TAG}_A${++n}`): Promise<string> {
  const { data, error } = await db.from("products").insert({ sku, name: `atomic ${sku}`, unit: "chiec", current_price: 1, supplier_id: supplierId }).select("id").single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id;
}

async function combo(components: Array<{ productId: string; quantity: string | number }>, sku = `${TAG}_C${++n}`): Promise<string> {
  const id = await createComboProduct(db, { sku, name: `combo ${sku}`, components });
  comboIds.push(id);
  return id;
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

async function order(lines: Array<{ productId: string | null; qty: number }>, opts: { status?: string; paidAt?: string; total?: string } = {}) {
  const { data: shop } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: "combo", data_source: "fixture" }).select("id").single();
  shopIds.push(shop!.id);
  const { data: o, error } = await db
    .from("channel_orders")
    .insert({ shop_id: shop!.id, external_order_sn: `${TAG}SN${n}`, order_status: opts.status ?? "READY_TO_SHIP", currency: "VND", paid_at_channel: opts.paidAt ?? "2033-01-15T03:00:00Z", channel_total_amount: opts.total ?? null })
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
  return { orderId: o!.id as string, itemIds, shopId: shop!.id as string };
}

const item = async (id: string) =>
  (await db.from("channel_order_items").select("cost_method, cost_per_unit_snapshot::text, total_cogs::text, cogs_reversed_at, cost_provisional").eq("id", id).single()).data!;
const state = async (p: string) => (await db.from("product_cost_state").select("quantity_on_hand::text, moving_average_cost::text").eq("product_id", p).maybeSingle()).data;
const ledgerOf = async (p: string) =>
  ((await db.from("inventory_cost_ledger").select("event_type, source_type, source_id, quantity_change::text, unit_cost::text, metadata").eq("product_id", p).order("event_time").order("order_key")).data ?? []) as Array<{
    event_type: string;
    source_type: string;
    source_id: string;
    quantity_change: string;
    unit_cost: string | null;
    metadata: Record<string, unknown> | null;
  }>;

// ================================================================ CRUD

test("PC 39: create A × 2, A × 3, multi-component; BOM stored in the DB; product_type combo, no supplier", async () => {
  const a = await atomic();
  const b = await atomic();
  const x2 = await combo([{ productId: a, quantity: 2 }]);
  const x3 = await combo([{ productId: a, quantity: "3" }]);
  const multi = await combo([{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }]);
  for (const [id, expected] of [[x2, [["2.0000"]]], [x3, [["3.0000"]]]] as const) {
    const { data } = await db.from("product_combo_components").select("quantity::text").eq("combo_product_id", id);
    assert.deepEqual(data!.map((r) => [r.quantity]), expected);
  }
  assert.equal((await db.from("product_combo_components").select("id").eq("combo_product_id", multi)).data!.length, 2);
  const p = (await db.from("products").select("product_type, supplier_id").eq("id", x3).single()).data!;
  assert.deepEqual([p.product_type, p.supplier_id], ["combo", null]);
});

test("PC 5 + 39: validation — empty BOM, qty 0 / negative, self, nested combo, duplicates merged, duplicate SKU", async () => {
  const a = await atomic();
  const c = await combo([{ productId: a, quantity: 1 }]);
  await assert.rejects(createComboProduct(db, { sku: `${TAG}_e`, name: "e", components: [] }), (e: unknown) => e instanceof ComboError && /ít nhất 1/.test((e as Error).message));
  await assert.rejects(createComboProduct(db, { sku: `${TAG}_z`, name: "z", components: [{ productId: a, quantity: 0 }] }), /lớn hơn 0|số dương/);
  await assert.rejects(createComboProduct(db, { sku: `${TAG}_n`, name: "n", components: [{ productId: a, quantity: -1 }] }), /số dương/);
  await assert.rejects(updateComboProduct(db, c, { sku: `${TAG}_self`, name: "self", components: [{ productId: c, quantity: 1 }] }), /chính nó/);
  await assert.rejects(createComboProduct(db, { sku: `${TAG}_nest`, name: "nest", components: [{ productId: c, quantity: 1 }] }), /không lồng combo/);
  // the DB rejects it too, whoever writes
  const raw = await db.rpc("save_combo_product", { p_id: null, p_sku: `${TAG}_raw`, p_name: "raw", p_unit: null, p_current_price: 0, p_note: null, p_components: [{ product_id: a, quantity: 0 }] });
  assert.ok(raw.error);
  const direct = await db.from("product_combo_components").insert({ combo_product_id: c, component_product_id: c, quantity: 1 });
  assert.ok(direct.error, "self-reference blocked by a constraint");
  const dup = await combo([{ productId: a, quantity: 1 }, { productId: a, quantity: "2.5" }]);
  assert.deepEqual((await db.from("product_combo_components").select("quantity::text").eq("combo_product_id", dup)).data, [{ quantity: "3.5000" }], "duplicates merged deterministically");
  await assert.rejects(createComboProduct(db, { sku: (await db.from("products").select("sku").eq("id", c).single()).data!.sku, name: "dup", components: [{ productId: a, quantity: 1 }] }), /SKU đã tồn tại/);
  // pure validation mirrors it
  assert.deepEqual(validateComboDefinition({ sku: " X ", name: " Y ", components: [{ productId: "b", quantity: "1" }, { productId: "a", quantity: 2 }, { productId: "b", quantity: "0.5" }] }).components, [
    { productId: "a", quantity: "2" },
    { productId: "b", quantity: "1.5" },
  ]);
});

test("PC 4 + 13 + 14: combo never gets stock, cost state, ledger rows or receipts; product type is immutable", async () => {
  const a = await atomic();
  const c = await combo([{ productId: a, quantity: 2 }]);
  await assert.rejects(receipt(c, 1, 1000, "2033-01-01"), /Combo không có tồn kho/);
  assert.ok((await db.from("product_cost_state").insert({ product_id: c })).error);
  assert.ok((await db.rpc("cost_lock_state", { p_product_id: c })).error, "even the engine cannot create a combo cost state");
  assert.equal(await db.rpc("cost_rebuild_product", { p_product_id: c, p_reason: "t", p_triggered_by: null }).then((r) => r.data), null, "rebuild of a combo is a no-op");
  assert.ok((await db.from("products").update({ product_type: "atomic" }).eq("id", c)).error);
  assert.ok((await db.from("products").update({ product_type: "combo" }).eq("id", a)).error);
});

// ================================================================ COGS + INVENTORY

test("PC 0 + 10 + 11 + 15 + 22: A × 3 sold 2 → 6 atomic units at A's moving average; sale_out only on A; snapshot rows; total = Σ components", async () => {
  const a = await atomic();
  await receipt(a, 100, 35000, "2033-01-01");
  const c = await combo([{ productId: a, quantity: 3 }]);
  const o = await order([{ productId: c, qty: 2 }]);
  assert.deepEqual(await engine.processOrder(o.orderId), { calculated: 1 });
  const it = await item(o.itemIds[0]);
  assert.deepEqual([it.cost_method, it.cost_per_unit_snapshot, it.total_cogs], ["combo_bom", "105000.0000", "210000.00"]);
  assert.equal((await state(a))!.quantity_on_hand, "94.0000", "100 → 94");
  assert.equal(await state(c), null, "no cost state for the combo");
  assert.equal((await db.from("inventory_cost_ledger").select("id").eq("product_id", c)).data!.length, 0, "no ledger row on the combo");
  const sale = (await ledgerOf(a)).find((l) => l.event_type === "sale_out")!;
  assert.deepEqual([sale.source_type, sale.quantity_change, sale.unit_cost], ["channel_order_item_component", "-6.0000", "35000.0000"]);
  assert.equal(sale.metadata!.parent_order_item_id, o.itemIds[0]);
  assert.equal(sale.metadata!.combo_product_id, c);
  const [snap] = (await getOrderItemComponentSnapshots(db, [o.itemIds[0]])).get(o.itemIds[0])!;
  assert.equal(sale.source_id !== undefined, true);
  assert.deepEqual(
    [snap.componentProductId, snap.quantityPerCombo, snap.orderQuantity, snap.totalComponentQuantity, snap.costPerUnitSnapshot, snap.componentTotalCogs],
    [a, "3.0000", "2.0000", "6.0000", "35000.0000", "210000.00"],
  );
  assert.equal((await db.from("order_financials").select("internal_cogs::text").eq("order_id", o.orderId).single()).data!.internal_cogs, "210000.00");
});

test("PC 12 + 40: multi-component BED-COMBO (PILLOW × 2 + SHEET × 1) qty 2 → 440.000; decimal BOM quantities exact", async () => {
  const pillow = await atomic();
  const sheet = await atomic();
  await receipt(pillow, 20, 50000, "2033-02-01");
  await receipt(sheet, 10, 120000, "2033-02-01");
  const c = await combo([{ productId: pillow, quantity: 2 }, { productId: sheet, quantity: 1 }]);
  const o = await order([{ productId: c, qty: 2 }], { paidAt: "2033-02-02T00:00:00Z" });
  await engine.processOrder(o.orderId);
  const it = await item(o.itemIds[0]);
  assert.deepEqual([it.cost_per_unit_snapshot, it.total_cogs], ["220000.0000", "440000.00"]);
  const snaps = (await getOrderItemComponentSnapshots(db, [o.itemIds[0]])).get(o.itemIds[0])!;
  assert.equal(snaps.length, 2);
  assert.deepEqual(new Set(snaps.map((s) => `${s.totalComponentQuantity}@${s.costPerUnitSnapshot}=${s.componentTotalCogs}`)), new Set(["4.0000@50000.0000=200000.00", "2.0000@120000.0000=240000.00"]));
  assert.deepEqual([(await state(pillow))!.quantity_on_hand, (await state(sheet))!.quantity_on_hand], ["16.0000", "8.0000"]);

  // decimal: 0.5 m of fabric per combo × 3 = 1.5 m at 33.333,33 → exact NUMERIC
  const fabric = await atomic();
  await receipt(fabric, 3, 33333.33, "2033-02-03");
  const half = await combo([{ productId: fabric, quantity: "0.5" }]);
  const o2 = await order([{ productId: half, qty: 3 }], { paidAt: "2033-02-04T00:00:00Z" });
  await engine.processOrder(o2.orderId);
  assert.deepEqual([(await item(o2.itemIds[0])).total_cogs, (await state(fabric))!.quantity_on_hand], ["50000.00", "1.5000"]);
});

test("PC 23: one component without any cost → COGS NULL, nothing posted (no partial); later purchase lets the retry cost it", async () => {
  const a = await atomic();
  const b = await atomic(); // never received
  await receipt(a, 10, 10000, "2033-03-01");
  const c = await combo([{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }]);
  const o = await order([{ productId: c, qty: 1 }], { paidAt: "2033-03-02T00:00:00Z" });
  assert.deepEqual(await engine.processOrder(o.orderId), { no_cost: 1 });
  assert.equal((await item(o.itemIds[0])).total_cogs, null);
  assert.equal((await db.from("channel_order_item_cogs_components").select("id").eq("channel_order_item_id", o.itemIds[0])).data!.length, 0, "no half snapshot");
  assert.equal((await ledgerOf(a)).filter((l) => l.event_type === "sale_out").length, 0, "A's sale withdrawn too");
  assert.equal((await state(a))!.quantity_on_hand, "10.0000");
  assert.equal((await db.from("order_financials").select("internal_cogs").eq("order_id", o.orderId).maybeSingle()).data?.internal_cogs ?? null, null);

  await receipt(b, 5, 7000, "2033-03-01");
  assert.deepEqual(await engine.processOrder(o.orderId), { calculated: 1 });
  assert.equal((await item(o.itemIds[0])).total_cogs, "17000.00");
});

test("PC 34 + 41: repeated processing is idempotent — no duplicate snapshots, sale_outs or reversals", async () => {
  const a = await atomic();
  await receipt(a, 10, 1000, "2033-04-01");
  const c = await combo([{ productId: a, quantity: 2 }]);
  const o = await order([{ productId: c, qty: 1 }], { paidAt: "2033-04-02T00:00:00Z" });
  for (let i = 0; i < 3; i++) await engine.processOrder(o.orderId);
  assert.equal((await db.from("channel_order_item_cogs_components").select("id").eq("channel_order_item_id", o.itemIds[0])).data!.length, 1);
  assert.equal((await ledgerOf(a)).filter((l) => l.event_type === "sale_out").length, 1);
  assert.equal((await state(a))!.quantity_on_hand, "8.0000");

  // PC 25: cancellation reverses the atomic quantities at the snapshot cost, once
  await db.from("channel_orders").update({ order_status: "CANCELLED", updated_at_channel: "2033-04-03T00:00:00Z" }).eq("id", o.orderId);
  assert.deepEqual(await engine.processOrder(o.orderId), { reversed: 1 });
  for (let i = 0; i < 2; i++) assert.deepEqual(await engine.processOrder(o.orderId), { already: 1 });
  const rev = (await ledgerOf(a)).filter((l) => l.event_type === "sale_reversal_in");
  assert.deepEqual(rev.map((r) => [r.source_type, r.quantity_change, r.unit_cost]), [["channel_order_item_component", "2.0000", "1000.0000"]]);
  assert.equal((await state(a))!.quantity_on_hand, "10.0000");
  assert.ok((await item(o.itemIds[0])).cogs_reversed_at);
});

test("PC 19 + 43 + 25: BOM edit — old order keeps A × 3 (snapshot), new order uses A × 2 + B × 1; cancelling the OLD order reverses A × 3", async () => {
  const a = await atomic();
  const b = await atomic();
  await receipt(a, 50, 10000, "2033-05-01");
  await receipt(b, 50, 20000, "2033-05-01");
  const sku = `${TAG}_BOM`;
  const c = await combo([{ productId: a, quantity: 3 }], sku);
  const o1 = await order([{ productId: c, qty: 1 }], { paidAt: "2033-05-02T00:00:00Z" });
  await engine.processOrder(o1.orderId);
  assert.equal((await item(o1.itemIds[0])).total_cogs, "30000.00");

  await updateComboProduct(db, c, { sku, name: "edited", components: [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }] });
  const o2 = await order([{ productId: c, qty: 1 }], { paidAt: "2033-05-03T00:00:00Z" });
  await engine.processOrder(o2.orderId);
  assert.equal((await item(o2.itemIds[0])).total_cogs, "40000.00", "new BOM: 2 × 10.000 + 1 × 20.000");

  const s1 = (await getOrderItemComponentSnapshots(db, [o1.itemIds[0]])).get(o1.itemIds[0])!;
  assert.deepEqual(s1.map((s) => [s.componentProductId, s.quantityPerCombo]), [[a, "3.0000"]], "historical BOM preserved");
  assert.equal((await item(o1.itemIds[0])).total_cogs, "30000.00", "historical COGS unchanged");
  // re-processing the old order does not pick up the new BOM
  await engine.processOrder(o1.orderId);
  assert.equal((await getOrderItemComponentSnapshots(db, [o1.itemIds[0]])).get(o1.itemIds[0])!.length, 1);

  const before = (await state(a))!.quantity_on_hand; // 50 − 3 − 2 = 45
  assert.equal(before, "45.0000");
  await db.from("channel_orders").update({ order_status: "CANCELLED", updated_at_channel: "2033-05-04T00:00:00Z" }).eq("id", o1.orderId);
  await engine.processOrder(o1.orderId);
  assert.deepEqual([(await state(a))!.quantity_on_hand, (await state(b))!.quantity_on_hand], ["48.0000", "49.0000"], "reversal uses the snapshot A × 3, never the current BOM");

  // snapshots are immutable
  const upd = await db.from("channel_order_item_cogs_components").update({ component_total_cogs: 1 }).eq("channel_order_item_id", o2.itemIds[0]);
  assert.equal(upd.error?.code, "CG001");
  // used combo cannot be hard-deleted
  assert.equal(await deleteComboProduct(db, c), "in_use");
});

test("PC 17 + 18 + 42: derived availability min(floor(stock / qty)); derived cost Σ avg × qty, NULL when a component has no cost", async () => {
  const a = await atomic();
  const b = await atomic();
  await receipt(a, 10, 30000, "2033-06-01");
  await receipt(b, 8, 50000, "2033-06-01");
  const c = await combo([{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }]);
  let ov = (await getComboOverview(db, c))!;
  assert.deepEqual([ov.availableQty, ov.currentUnitCost, ov.componentCount], ["5", "110000.0000", 2]);
  assert.equal(calculateComboAvailableQty(ov.components.map((x) => ({ quantity: x.quantity, quantityOnHand: x.quantityOnHand }))), 5);
  assert.equal(calculateComboAvailableQty([{ quantity: "2", quantityOnHand: "0" }, { quantity: "1", quantityOnHand: "8" }]), 0);
  assert.equal(calculateComboAvailableQty([{ quantity: "3", quantityOnHand: "-2" }]), 0, "negative costing stock counts as 0");
  assert.equal(calculateComboAvailableQty([{ quantity: "1.5", quantityOnHand: "4" }]), 2);
  const none = await atomic();
  const c2 = await combo([{ productId: a, quantity: 1 }, { productId: none, quantity: 1 }]);
  ov = (await getComboOverview(db, c2))!;
  assert.deepEqual([ov.currentUnitCost, ov.availableQty], [null, "0"], "Chưa đủ giá vốn — never a partial sum");
  assert.deepEqual(explodeComboForInventory([{ productId: a, quantity: "3" }, { productId: b, quantity: "0.5" }], "2"), [
    { productId: a, quantity: "6" },
    { productId: b, quantity: "1" },
  ]);
});

// ================================================================ SHOPEE MAPPING + FINANCIAL

test("PC 8 + 32 + 44: exact SKU auto-map maps a Shopee model to a combo (DB-only); orders then cost through the BOM", async () => {
  const a = await atomic();
  await receipt(a, 30, 40000, "2033-07-01");
  const sku = `${TAG}_THAM-X3`;
  const c = await combo([{ productId: a, quantity: 3 }], sku);
  const { data: shop } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_map`, shop_name: "map", data_source: "fixture" }).select("id").single();
  shopIds.push(shop!.id);
  const { data: cp } = await db.from("channel_products").insert({ shop_id: shop!.id, external_item_id: "9001", item_name: "Tham x3", has_model: true }).select("id").single();
  const { data: m } = await db.from("channel_product_models").insert({ channel_product_id: cp!.id, external_model_id: "1", model_sku: sku.toLowerCase() }).select("id").single();
  const { error } = await db.rpc("auto_map_channel_models", { p_shop_id: shop!.id });
  assert.equal(error, null);
  const mapped = (await db.from("channel_product_models").select("internal_product_id, mapping_status").eq("id", m!.id).single()).data!;
  assert.deepEqual([mapped.internal_product_id, mapped.mapping_status], [c, "auto_mapped"]);

  // PC 45: estimated profit from the summed combo COGS — no combo-specific financial code
  const o = await order([{ productId: c, qty: 2 }], { paidAt: "2033-07-02T00:00:00Z", total: "500000" });
  await engine.processOrder(o.orderId);
  assert.equal((await item(o.itemIds[0])).total_cogs, "240000.00", "A-X3 × 2 = 6 × 40.000");
  await db.rpc("apply_order_estimated_revenue", { p_order_id: o.orderId, p_amount: "400000", p_synced_at: new Date().toISOString() });
  const v = (await db.from("v_channel_order_summary").select("internal_cogs, estimated_profit").eq("order_id", o.orderId).single()).data!;
  assert.deepEqual(v, { internal_cogs: "240000.00", estimated_profit: "160000.00" });
});

test("PC 46: atomic products behave exactly as before (receipt → moving average → atomic COGS)", async () => {
  const a = await atomic();
  await receipt(a, 10, 50000, "2033-08-01");
  const o = await order([{ productId: a, qty: 2 }], { paidAt: "2033-08-02T00:00:00Z" });
  assert.deepEqual(await engine.processOrder(o.orderId), { calculated: 1 });
  const it = await item(o.itemIds[0]);
  assert.deepEqual([it.cost_method, it.total_cogs], ["moving_average", "100000.00"]);
  assert.equal((await db.from("channel_order_item_cogs_components").select("id").eq("channel_order_item_id", o.itemIds[0])).data!.length, 0);
  assert.equal((await ledgerOf(a)).find((l) => l.event_type === "sale_out")!.source_type, "channel_order_item");
  assert.equal((await db.from("products").select("product_type").eq("id", a).single()).data!.product_type, "atomic");
});

test("PC 36: a costed combo line keeps its mapping snapshot (re-map blocked); an unused combo can be hard-deleted", async () => {
  const a = await atomic();
  const b = await atomic();
  await receipt(a, 10, 1000, "2033-09-01");
  await receipt(b, 10, 2000, "2033-09-01");
  const c = await combo([{ productId: a, quantity: 1 }]);
  const o = await order([{ productId: c, qty: 1 }], { paidAt: "2033-09-02T00:00:00Z" });
  await engine.processOrder(o.orderId);
  assert.equal((await item(o.itemIds[0])).total_cogs, "1000.00");
  // a COSTED combo line keeps its history even if the model is re-mapped later
  await assert.rejects(
    Promise.resolve(db.from("channel_order_items").update({ internal_product_id: b }).eq("id", o.itemIds[0])).then((r) => {
      if (r.error) throw new Error(r.error.message);
    }),
    /đã được chốt/,
  );
  assert.equal(await deleteComboProduct(db, await combo([{ productId: a, quantity: 1 }])), "deleted", "an unused combo can be deleted");
});
