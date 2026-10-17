// ============================================================
// SHOPEE-6 — returns + disposition + restock + COGS reversal against the REAL
// database in .env.local (local Docker Supabase in dev):
//
//   node --env-file=.env.local --test src/lib/channels/shopee/returns.integration.test.ts
//
// Return sync goes through the real queue worker + runner with fixture
// providers; restock / transitions / financials through the DB functions
// (the same ones the admin UI calls via setReturnDisposition).
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { hasPermission } from "../../auth/permissions.ts";
import { CostEngine } from "../../inventory-cost/engine.ts";
import { createComboProduct, updateComboProduct } from "../../products/combo.ts";
import { getSyncConfig } from "../core/sync-config.ts";
import { getReturnDetail, ReturnDispositionError, setReturnDisposition } from "../core/returns.ts";
import { SyncWorker } from "../core/sync-worker.ts";
import { FixtureShopeeOrderProvider } from "./order-provider.ts";
import { FixtureShopeePaymentProvider } from "./payment-provider.ts";
import { FixtureShopeeProductProvider } from "./product-provider.ts";
import { FixtureShopeeReturnProvider } from "./return-provider.ts";
import { parseReturnDetail } from "./return-adapter.ts";
import { isReturnTerminal } from "./return-status.ts";
import { toJobFailure } from "./sync-errors.ts";
import { createShopeeRunnerFactory, requestShopeeSync } from "./sync-service.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const engine = new CostEngine({ db, logger: () => {} });

const TAG = `s6${Date.now()}`;
const NOW = Math.floor(Date.now() / 1000);
const shopIds: string[] = [];
const productIds: string[] = [];
const comboIds: string[] = [];
let supplierId = "";
let savedCutoff: string | null = null;
let n = 0;

before(async () => {
  const { data, error } = await db.from("suppliers").insert({ code: `${TAG}_hh`, name: "returns household", supplier_type: "business_household" }).select("id").single();
  if (error) throw error;
  supplierId = data.id;
  savedCutoff = ((await db.from("channel_sync_settings").select("orders_from").eq("id", true).single()).data?.orders_from as string | null) ?? null;
  await db.from("channel_sync_settings").update({ orders_from: null }).eq("id", true);
});

after(async () => {
  await db.from("channel_sync_settings").update({ orders_from: savedCutoff }).eq("id", true);
  if (shopIds.length) {
    // restock episodes / ledger rows reference order lines → remove inventory history first
    const { data: items } = await db.from("channel_order_items").select("id, channel_orders!inner(shop_id)").in("channel_orders.shop_id", shopIds);
    const lineIds = (items ?? []).map((i) => i.id as string);
    if (lineIds.length) {
      const { data: rs } = await db.from("channel_return_restocks").select("id").in("channel_order_item_id", lineIds);
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
  const sku = `${TAG}_A${++n}`;
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
  const { data, error } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: `returns ${n}`, currency: "VND", data_source: "fixture" }).select("id").single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

/** A costed order with one line per entry (external item id = index + 1, no model). */
async function soldOrder(shopId: string, lines: Array<{ productId: string; qty: number }>, opts: { sn?: string; paidAt?: string } = {}) {
  const sn = opts.sn ?? `${TAG}SN${++n}`;
  const { data: o, error } = await db
    .from("channel_orders")
    .insert({ shop_id: shopId, external_order_sn: sn, order_status: "COMPLETED", currency: "VND", paid_at_channel: opts.paidAt ?? "2034-01-10T03:00:00Z", created_at_channel: new Date((NOW - 3 * 86400) * 1000).toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  const itemIds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { data: it, error: e } = await db
      .from("channel_order_items")
      .insert({ order_id: o!.id, provider_line_key: `k${i}`, external_item_id: String(i + 1), item_name: `line ${i + 1}`, quantity: lines[i].qty, internal_product_id: lines[i].productId })
      .select("id")
      .single();
    if (e) throw e;
    itemIds.push(it!.id);
  }
  await engine.processOrder(o!.id);
  return { orderId: o!.id as string, sn, itemIds };
}

const rawReturn = (returnSn: string, orderSn: string, items: Array<{ itemId: number; amount: number }>, opts: { status?: string; update?: number; refund?: number } = {}) => ({
  return_sn: returnSn,
  order_sn: orderSn,
  status: opts.status ?? "REQUESTED",
  reason: "NOT_RECEIPT",
  text_reason: "test",
  refund_amount: opts.refund ?? 100000,
  currency: "VND",
  needs_logistics: true,
  create_time: NOW - 3600,
  update_time: opts.update ?? NOW - 600,
  user: { username: "buyer-pii" },
  item: items.map((i) => ({ item_id: i.itemId, model_id: 0, name: `line ${i.itemId}`, item_sku: "", variation_sku: "", amount: i.amount, refund_amount: 50000 })),
});

/** Stores a return directly through the same apply function the sync uses. */
async function storeReturn(shopId: string, orderId: string, raw: ReturnType<typeof rawReturn>) {
  const parsed = parseReturnDetail({ error: "", response: raw });
  if ("issue" in parsed) throw new Error(parsed.issue.reason);
  const d = parsed.detail;
  const { data, error } = await db.rpc("apply_channel_return", {
    p_shop_id: shopId,
    p_order_id: orderId,
    p_return: {
      external_return_sn: d.externalReturnSn,
      status: d.status,
      refund_amount: d.refundAmount,
      currency: d.currency,
      created_at_channel: d.createdAtChannel,
      updated_at_channel: d.updatedAtChannel,
      is_terminal: d.isTerminal,
    },
    p_items: d.items.map((i) => ({ external_item_id: i.externalItemId, external_model_id: i.externalModelId, quantity: i.quantity, item_name: i.itemName })),
    p_synced_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  const items = (
    await db
      .from("channel_return_items")
      .select("id, channel_order_item_id, quantity::text, inventory_disposition")
      .eq("return_id", (data as { return_id: string }).return_id)
      .order("channel_order_item_id", { ascending: true, nullsFirst: false })
  ).data!;
  return { returnId: (data as { return_id: string }).return_id, items };
}

const stock = async (p: string) => (await db.from("product_cost_state").select("quantity_on_hand::text, moving_average_cost::text").eq("product_id", p).single()).data!;
const ledgerOf = async (p: string, type: string) =>
  ((await db.from("inventory_cost_ledger").select("event_type, source_type, quantity_change::text, unit_cost::text").eq("product_id", p).eq("event_type", type)).data ?? []) as Array<{
    event_type: string;
    source_type: string;
    quantity_change: string;
    unit_cost: string;
  }>;
const fin = async (orderId: string) =>
  (await db.from("order_financials").select("internal_cogs::text, reversed_cogs::text, net_cogs::text, actual_shopee_income::text, actual_profit::text, seller_compensation_amount::text").eq("order_id", orderId).single()).data!;
const dispose = (returnItemId: string, disposition: "pending" | "restock" | "damaged" | "lost" | "disposed", reason?: string) =>
  setReturnDisposition(db, { returnItemId, disposition, reason, changedBy: null });

function returnWorker(shopId: string, fixtures: { returns: Map<string, Record<string, unknown>>; orders?: Map<string, unknown>; failSns?: string[] }) {
  const calls: string[] = [];
  const config = { ...getSyncConfig({}), shopAllowlist: [shopId] };
  const worker = new SyncWorker({
    db,
    config,
    workerId: `ret-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: () => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider({ listPages: [], ordersBySn: fixtures.orders ?? new Map() }, { onCall: (c) => void calls.push(c.apiName) }),
        product: new FixtureShopeeProductProvider({ itemListPages: [], itemBaseInfo: { error: "", response: { item_list: [] } }, modelLists: {} }),
        payment: new FixtureShopeePaymentProvider(new Map()),
        return: new FixtureShopeeReturnProvider({ returnsBySn: fixtures.returns }, { failSns: fixtures.failSns, onCall: (c) => void calls.push(`${c.apiName}:${(c.input as { returnSn?: string }).returnSn ?? ""}`) }),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });
  const run = async () => {
    await requestShopeeSync(db, { shopId, syncType: "return", mode: "manual" });
    const reports = [];
    for (let i = 0; i < 20; i++) {
      const r = await worker.runOne(30_000);
      if (!r) break;
      reports.push(r);
    }
    return reports;
  };
  return { run, calls };
}

// ================================================================ SYNC

test("SHOPEE-6 54: return sync — new return stored, items linked to the ORIGINAL order line, PII never stored; re-sync idempotent; status update; terminal not re-polled", async () => {
  const s = await shop();
  const a = await atomic();
  await receipt(a, 10, 40000, "2034-01-01");
  const o = await soldOrder(s, [{ productId: a, qty: 2 }]);
  const returns = new Map<string, Record<string, unknown>>([[`${TAG}R1`, rawReturn(`${TAG}R1`, o.sn, [{ itemId: 1, amount: 1 }])]]);
  const w = returnWorker(s, { returns });
  const [r1] = await w.run();
  assert.equal(r1.status, "success");
  const { data: ret } = await db.from("channel_returns").select("id, status, is_terminal, refund_amount::text, order_id").eq("shop_id", s).single();
  assert.deepEqual([ret!.status, ret!.is_terminal, ret!.refund_amount, ret!.order_id], ["REQUESTED", false, "100000.00", o.orderId]);
  const { data: items } = await db.from("channel_return_items").select("channel_order_item_id, internal_product_id, quantity::text, inventory_disposition").eq("return_id", ret!.id);
  assert.deepEqual(items, [{ channel_order_item_id: o.itemIds[0], internal_product_id: a, quantity: "1.0000", inventory_disposition: "pending" }]);
  const { data: snap } = await db.from("channel_api_snapshots").select("payload").eq("shop_id", s).eq("entity_type", "return").single();
  assert.equal((snap!.payload as Record<string, unknown>).user, undefined, "buyer identity stripped from the snapshot");
  assert.equal((await stock(a)).quantity_on_hand, "8.0000", "a return alone never moves stock (refund ≠ restock)");

  // idempotent: same data again → nothing new
  await w.run();
  assert.equal((await db.from("channel_returns").select("id").eq("shop_id", s)).data!.length, 1);
  assert.equal((await db.from("channel_return_items").select("id").eq("return_id", ret!.id)).data!.length, 1);

  // status change → updated; terminal afterwards
  returns.set(`${TAG}R1`, rawReturn(`${TAG}R1`, o.sn, [{ itemId: 1, amount: 1 }], { status: "REFUND_PAID", update: NOW - 300 }));
  await w.run();
  const after = (await db.from("channel_returns").select("status, is_terminal, completed_at").eq("id", ret!.id).single()).data!;
  assert.deepEqual([after.status, after.is_terminal, !!after.completed_at], ["REFUND_PAID", true, true]);
  assert.equal(isReturnTerminal("REFUND_PAID"), true);
  // terminal + unchanged → listed but not re-fetched
  const before = w.calls.filter((c) => c.startsWith("v2.returns.get_return_detail")).length;
  await w.run();
  assert.equal(w.calls.filter((c) => c.startsWith("v2.returns.get_return_detail")).length, before, "terminal unchanged return: no detail call");
});

test("SHOPEE-6 5 + 54: return before its order → the order is fetched and stored first; an unfetchable order → retry row with reason; one broken return never blocks the others", async () => {
  const s = await shop();
  const missingSn = `${TAG}LATE`;
  const order = {
    order_sn: missingSn,
    order_status: "COMPLETED",
    create_time: NOW - 7200,
    update_time: NOW - 3600,
    currency: "VND",
    total_amount: 100000,
    item_list: [{ order_item_id: 1, item_id: 1, item_name: "late", item_sku: "", model_id: 0, model_sku: "", model_original_price: 100000, model_discounted_price: 100000, model_quantity_purchased: 1 }],
  };
  const returns = new Map<string, Record<string, unknown>>([
    [`${TAG}R_LATE`, rawReturn(`${TAG}R_LATE`, missingSn, [{ itemId: 1, amount: 1 }])],
    [`${TAG}R_GONE`, rawReturn(`${TAG}R_GONE`, `${TAG}NOWHERE`, [{ itemId: 1, amount: 1 }])],
    [`${TAG}R_BAD`, rawReturn(`${TAG}R_BAD`, missingSn, [{ itemId: 1, amount: 1 }])],
  ]);
  const w = returnWorker(s, { returns, orders: new Map([[missingSn, order]]), failSns: [`${TAG}R_BAD`] });
  const [r] = await w.run();
  assert.equal(r.status, "success", "per-return failures do not fail the job");
  const { data: stored } = await db.from("channel_returns").select("external_return_sn, channel_orders!inner(external_order_sn)").eq("shop_id", s);
  assert.deepEqual(stored!.map((x) => x.external_return_sn), [`${TAG}R_LATE`], "only the return whose order could be fetched is stored");
  assert.ok(w.calls.includes("v2.order.get_order_detail"), "the order was fetched first");
  const { data: retry } = await db.from("channel_return_sync_retries").select("external_return_sn, reason, attempts").eq("shop_id", s);
  assert.deepEqual(retry, [{ external_return_sn: `${TAG}R_GONE`, reason: "order_missing", attempts: 1 }]);
  const job = (await db.from("channel_sync_jobs").select("records_failed, metadata").eq("id", r.jobId).single()).data!;
  assert.equal(job.records_failed, 2, "order_missing + provider error, each its own record");
  // the next job re-tries the retry row (seed) — still missing → attempts 2
  await w.run();
  assert.equal((await db.from("channel_return_sync_retries").select("attempts").eq("shop_id", s).single()).data!.attempts, 2);
});

// ================================================================ ATOMIC RESTOCK

test("SHOPEE-6 15 + 16 + 55 + 60: atomic restock — pending no movement; restock = return_in at the ORIGINAL snapshot cost (not the current average); retry never duplicates", async () => {
  const s = await shop();
  const a = await atomic();
  await receipt(a, 10, 40000, "2034-02-01");
  const o = await soldOrder(s, [{ productId: a, qty: 5 }], { paidAt: "2034-02-02T00:00:00Z" });
  assert.equal((await db.from("channel_order_items").select("cost_per_unit_snapshot::text").eq("id", o.itemIds[0]).single()).data!.cost_per_unit_snapshot, "40000.0000");
  // the current average moves after the sale (more stock at 70.000)
  await receipt(a, 5, 70000, "2034-02-03");
  assert.equal((await stock(a)).moving_average_cost, "55000.0000");

  const { items } = await storeReturn(s, o.orderId, rawReturn(`${TAG}R_A`, o.sn, [{ itemId: 1, amount: 2 }]));
  assert.equal((await stock(a)).quantity_on_hand, "10.0000", "pending → no movement");
  const r = await dispose(items[0].id, "restock");
  assert.deepEqual([r.changed, r.inventoryEffect, r.cogsDelta], [true, "restocked", "80000.00"]);
  const ins = await ledgerOf(a, "return_in");
  assert.deepEqual(ins.map((l) => [l.source_type, l.quantity_change, l.unit_cost]), [["channel_return_restock", "2.0000", "40000.0000"]], "original cost 40.000, never the current 55.000");
  assert.equal((await stock(a)).quantity_on_hand, "12.0000");
  // retry / same disposition again → no-op
  assert.equal((await dispose(items[0].id, "restock")).changed, false);
  assert.equal((await ledgerOf(a, "return_in")).length, 1);
  // the historical sale snapshot is untouched
  const line = (await db.from("channel_order_items").select("cost_per_unit_snapshot::text, total_cogs::text").eq("id", o.itemIds[0]).single()).data!;
  assert.deepEqual([line.cost_per_unit_snapshot, line.total_cogs], ["40000.0000", "200000.00"]);
  assert.deepEqual([(await fin(o.orderId)).internal_cogs, (await fin(o.orderId)).reversed_cogs, (await fin(o.orderId)).net_cogs], ["200000.00", "80000.00", "120000.00"]);
});

// ================================================================ COMBO RESTOCK

test("SHOPEE-6 17 + 18 + 19 + 36 + 56: combo partial return — historical component snapshot (A × 2 + B × 1), never the current BOM; no combo stock", async () => {
  const s = await shop();
  const a = await atomic();
  const b = await atomic();
  await receipt(a, 20, 30000, "2034-03-01");
  await receipt(b, 20, 50000, "2034-03-01");
  const sku = `${TAG}_COMBO`;
  const c = await createComboProduct(db, { sku, name: "combo", components: [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }] });
  comboIds.push(c);
  const o = await soldOrder(s, [{ productId: c, qty: 2 }], { paidAt: "2034-03-02T00:00:00Z" });
  assert.equal((await db.from("channel_order_items").select("total_cogs::text").eq("id", o.itemIds[0]).single()).data!.total_cogs, "220000.00");
  // BOM changes and costs move AFTER the sale
  await updateComboProduct(db, c, { sku, name: "combo v2", components: [{ productId: a, quantity: 5 }] });
  await receipt(a, 10, 90000, "2034-03-03");
  const before = [(await stock(a)).quantity_on_hand, (await stock(b)).quantity_on_hand]; // 16 + 10 = 26, 18

  const { items } = await storeReturn(s, o.orderId, rawReturn(`${TAG}R_C`, o.sn, [{ itemId: 1, amount: 1 }]));
  const r = await dispose(items[0].id, "restock");
  assert.equal(r.cogsDelta, "110000.00", "1 combo = 2 × 30.000 + 1 × 50.000");
  assert.deepEqual([(await stock(a)).quantity_on_hand, (await stock(b)).quantity_on_hand], [String(Number(before[0]) + 2) + ".0000", String(Number(before[1]) + 1) + ".0000"]);
  assert.deepEqual((await ledgerOf(a, "return_in")).map((l) => [l.quantity_change, l.unit_cost]), [["2.0000", "30000.0000"]]);
  assert.deepEqual((await ledgerOf(b, "return_in")).map((l) => [l.quantity_change, l.unit_cost]), [["1.0000", "50000.0000"]]);
  assert.equal((await db.from("inventory_cost_ledger").select("id").eq("product_id", c)).data!.length, 0, "never a combo ledger row");
  assert.deepEqual([(await fin(o.orderId)).reversed_cogs, (await fin(o.orderId)).net_cogs], ["110000.00", "110000.00"]);
  const detail = (await getReturnDetail(db, (await db.from("channel_returns").select("id").eq("external_return_sn", `${TAG}R_C`).single()).data!.id))!;
  assert.deepEqual(detail.items[0].orderLine!.components.map((x) => [x.sku.endsWith(""), x.quantityPerCombo]).length, 2);
});

// ================================================================ TRANSITIONS

test("SHOPEE-6 22–24 + 57: pending → restock → damaged (compensating OUT at the same cost) → restock (new episode) → lost → disposed; audit trail", async () => {
  const s = await shop();
  const a = await atomic();
  await receipt(a, 10, 20000, "2034-04-01");
  const o = await soldOrder(s, [{ productId: a, qty: 3 }], { paidAt: "2034-04-02T00:00:00Z" });
  await receipt(a, 10, 50000, "2034-04-03"); // average moves
  const { items } = await storeReturn(s, o.orderId, rawReturn(`${TAG}R_T`, o.sn, [{ itemId: 1, amount: 3 }]));
  const id = items[0].id;
  const q0 = (await stock(a)).quantity_on_hand; // 7 + 10 = 17
  await dispose(id, "restock");
  assert.equal((await stock(a)).quantity_on_hand, "20.0000");
  const toDamaged = await dispose(id, "damaged", "kiểm tra thấy rách");
  assert.deepEqual([toDamaged.inventoryEffect, toDamaged.cogsDelta], ["restock_reversed", "-60000.00"]);
  assert.equal((await stock(a)).quantity_on_hand, q0, "stock back to before the restock");
  const outs = await ledgerOf(a, "adjustment_out");
  assert.deepEqual(outs.map((l) => [l.source_type, l.quantity_change, l.unit_cost]), [["channel_return_restock", "-3.0000", "20000.0000"]], "same quantity, same ORIGINAL cost");
  assert.equal((await ledgerOf(a, "return_in")).length, 1, "the restock row is kept (history), not deleted");
  assert.equal((await fin(o.orderId)).reversed_cogs, "0.00", "damaged → no COGS reversal");

  await dispose(id, "restock");
  assert.equal((await ledgerOf(a, "return_in")).length, 2, "re-entering restock = a new episode");
  assert.equal((await fin(o.orderId)).reversed_cogs, "60000.00");
  await dispose(id, "lost");
  await dispose(id, "disposed");
  assert.equal((await ledgerOf(a, "adjustment_out")).length, 2, "lost compensates the 2nd episode; lost → disposed moves nothing");
  assert.equal((await stock(a)).quantity_on_hand, q0);
  const { data: events } = await db.from("channel_return_disposition_events").select("old_disposition, new_disposition, inventory_effect, reason").eq("return_item_id", id).order("changed_at");
  assert.deepEqual(
    events!.map((e) => `${e.old_disposition}>${e.new_disposition}:${e.inventory_effect}`),
    ["pending>restock:restocked", "restock>damaged:restock_reversed", "damaged>restock:restocked", "restock>lost:restock_reversed", "lost>disposed:none"],
  );
  assert.equal(events![1].reason, "kiểm tra thấy rách");
  // average after restock + full compensation is back to the pre-restock value
  assert.equal((await stock(a)).moving_average_cost, "37647.0588");
});

// ================================================================ CUMULATIVE

test("SHOPEE-6 20 + 58: Σ restocked ≤ sold — two partial returns on one line; over-return capped at the line, rest unmatched; concurrent restocks serialized", async () => {
  const s = await shop();
  const a = await atomic();
  await receipt(a, 10, 10000, "2034-05-01");
  const o = await soldOrder(s, [{ productId: a, qty: 5 }], { paidAt: "2034-05-02T00:00:00Z" });
  const r1 = await storeReturn(s, o.orderId, rawReturn(`${TAG}R_P1`, o.sn, [{ itemId: 1, amount: 3 }]));
  const r2 = await storeReturn(s, o.orderId, rawReturn(`${TAG}R_P2`, o.sn, [{ itemId: 1, amount: 4 }]));
  assert.deepEqual(r2.items.map((i) => [i.channel_order_item_id !== null, i.quantity]), [[true, "2.0000"], [false, "2.0000"]], "only 2 left on the line; the rest is visible but unmatched");
  await assert.rejects(dispose(r2.items[1].id, "restock"), (e: unknown) => e instanceof ReturnDispositionError && e.code === "RT001");
  // concurrency: both restocks at once — the row lock serializes them, total stays ≤ 5
  const results = await Promise.allSettled([dispose(r1.items[0].id, "restock"), dispose(r2.items[0].id, "restock")]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 2, "3 + 2 = 5 fits exactly");
  assert.equal((await stock(a)).quantity_on_hand, "10.0000");
  // a third return on the fully returned line: nothing left to match → unmatched, never restockable
  const r3 = await storeReturn(s, o.orderId, rawReturn(`${TAG}R_P3`, o.sn, [{ itemId: 1, amount: 4 }]));
  assert.deepEqual(r3.items.map((i) => [i.channel_order_item_id, i.quantity]), [[null, "4.0000"]]);
  // re-syncing R_P2 keeps its line quantity (2, restocked) and its disposition
  const again = await storeReturn(s, o.orderId, rawReturn(`${TAG}R_P2`, o.sn, [{ itemId: 1, amount: 4 }]));
  assert.deepEqual(again.items.map((i) => [i.channel_order_item_id !== null, i.quantity, i.inventory_disposition]), [[true, "2.0000", "restock"], [false, "2.0000", "pending"]]);
  assert.equal((await stock(a)).quantity_on_hand, "10.0000", "re-sync never moves stock");
});

// ================================================================ FINANCIAL

test("SHOPEE-6 25–35 + 59: refund inside the escrow income is not subtracted again; restock → net COGS 0, profit 150.000; lost → −30.000; seller compensation separate; return_adjusted", async () => {
  const s = await shop();
  const a = await atomic();
  await receipt(a, 10, 60000, "2034-06-01");
  const o = await soldOrder(s, [{ productId: a, qty: 3 }], { paidAt: "2034-06-02T00:00:00Z" });
  assert.equal((await fin(o.orderId)).internal_cogs, "180000.00");
  // settlement AFTER the refund: Shopee's escrow already nets it (300.000 → 150.000)
  await db.from("order_financials").update({ escrow_amount: 300000, escrow_amount_after_adjustment: 150000, refund_amount: -150000, seller_compensation_amount: 20000 }).eq("order_id", o.orderId);
  await db.from("channel_orders").update({ financial_status: "settlement_available" }).eq("id", o.orderId);
  assert.equal((await fin(o.orderId)).actual_profit, "-30000.00", "150.000 − 180.000 before any disposition");

  const { items } = await storeReturn(s, o.orderId, rawReturn(`${TAG}R_F`, o.sn, [{ itemId: 1, amount: 3 }], { refund: 150000 }));
  assert.equal((await db.from("channel_orders").select("financial_status").eq("id", o.orderId).single()).data!.financial_status, "return_adjusted");
  assert.equal((await fin(o.orderId)).actual_profit, "-30000.00", "a pending return reverses nothing and subtracts no refund");

  await dispose(items[0].id, "restock");
  let f = await fin(o.orderId);
  assert.deepEqual([f.reversed_cogs, f.net_cogs, f.actual_profit], ["180000.00", "0.00", "150000.00"], "restock: 150.000 − 0");
  await dispose(items[0].id, "lost");
  f = await fin(o.orderId);
  assert.deepEqual([f.reversed_cogs, f.net_cogs, f.actual_profit], ["0.00", "180000.00", "-30000.00"], "lost: 150.000 − 180.000");
  assert.equal(f.seller_compensation_amount, "20000.00", "seller compensation stays its own component (inside the escrow income, never netted into refund logic)");
  assert.equal(f.actual_shopee_income, "150000.00");
  await dispose(items[0].id, "damaged");
  assert.equal((await fin(o.orderId)).reversed_cogs, "0.00", "damaged → no reversal");
});

test("SHOPEE-6 RT002/RT003 guards + 61 permissions", async () => {
  const s = await shop();
  const a = await atomic(); // never received → no cost
  const o = await soldOrder(s, [{ productId: a, qty: 1 }], { paidAt: "2034-07-02T00:00:00Z" });
  const { items } = await storeReturn(s, o.orderId, rawReturn(`${TAG}R_G`, o.sn, [{ itemId: 1, amount: 1 }]));
  await assert.rejects(dispose(items[0].id, "restock"), (e: unknown) => e instanceof ReturnDispositionError && e.code === "RT003");
  assert.equal((await db.from("channel_return_items").select("inventory_disposition").eq("id", items[0].id).single()).data!.inventory_disposition, "pending", "a refused restock changes nothing");
  assert.equal(hasPermission("admin", "return:disposition"), true);
  assert.equal(hasPermission("staff", "return:disposition"), false);
  assert.equal(hasPermission("viewer", "return:disposition"), false);
  assert.equal(hasPermission("viewer", "channel:view"), true, "viewer still reads returns");
});
