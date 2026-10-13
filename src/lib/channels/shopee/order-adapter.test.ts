// Run: node --test src/lib/channels/shopee/order-adapter.test.ts
// SHOPEE-3 pure tests: order adapter on the checked-in fixtures, identity keys,
// time windows, concurrency helper, status helpers (no DB, no network).
import { test } from "node:test";
import assert from "node:assert/strict";

import { mapWithConcurrency, splitTimeWindows } from "../core/time-windows.ts";
import { buildShopeeOrderItemIdentity, orderFingerprint, parseOrderDetails, parseOrderListPage } from "./order-adapter.ts";
import { loadOrderFixtures, MAX_ORDER_WINDOW_SECONDS } from "./order-provider.ts";
import { isFinancialSyncEligible, isOrderActive, isOrderCancelled, isOrderCompleted } from "./order-status.ts";

const fixtures = loadOrderFixtures();
const detail = (sn: string) => parseOrderDetails({ error: "", response: { order_list: [fixtures.ordersBySn.get(sn)] } });

test("fixtures load: 2 list pages, 7 orders", () => {
  assert.equal(fixtures.listPages.length, 2);
  assert.equal(fixtures.ordersBySn.size, 7);
});

test("get_order_list parsing: sns, status, more / next_cursor", () => {
  const p1 = parseOrderListPage(fixtures.listPages[0]);
  assert.deepEqual(p1.orders.map((o) => o.orderSn), ["251013NORMAL01", "251013MULTI002", "251013MODELS03", "251013UNMAP004"]);
  assert.equal(p1.more, true);
  assert.equal(p1.nextCursor, "fixture-cursor-2");
  const p2 = parseOrderListPage(fixtures.listPages[1]);
  assert.equal(p2.more, false);
  assert.equal(p2.nextCursor, null, "empty cursor → null");
  const bad = parseOrderListPage({ error: "", response: { more: false, order_list: [{ order_sn: "" }, { order_status: "X" }, { order_sn: "OK1" }] } });
  assert.deepEqual(bad.orders.map((o) => o.orderSn), ["OK1"]);
  assert.equal(bad.issues.length, 2);
});

test("normal order mapping: header fields, no-model line (model_id 0 → null), decimal strings", () => {
  const { orders, issues } = detail("251013NORMAL01");
  assert.equal(issues.length, 0);
  const o = orders[0];
  assert.deepEqual(
    [o.externalOrderSn, o.orderStatus, o.currency, o.cod, o.paymentMethod, o.channelTotalAmount, o.estimatedShippingFee, o.shippingCarrier],
    ["251013NORMAL01", "READY_TO_SHIP", "VND", false, "Online Payment", "105000", "15000", "SPX Express"],
  );
  assert.equal(o.createdAtChannel, new Date(1760300000 * 1000).toISOString());
  const line = o.items[0];
  assert.deepEqual(
    [line.providerLineKey, line.externalOrderItemId, line.externalItemId, line.externalModelId, line.modelSku, line.quantity, line.originalUnitPrice, line.discountedUnitPrice],
    ["100001|800000101|-", "100001", "800000101", null, null, "2", "59000", "45000"],
  );
});

test("multi-model order: blank model_sku → null, one line per model", () => {
  const o = detail("251013MODELS03").orders[0];
  assert.deepEqual(o.items.map((i) => [i.externalModelId, i.modelSku]), [
    ["9000001021", "bao_ve_dem_thuong_m6x2m"],
    ["9000001022", "bao_ve_dem_thuong_m8x2m"],
    ["9000001023", null],
  ]);
});

test("identity: shared order_item_id (bundle) stays distinct; exact repeat gets an occurrence suffix", () => {
  const o = detail("251013BUNDLE07").orders[0];
  assert.deepEqual(o.items.map((i) => i.providerLineKey), [
    "700001|800000101|-",
    "700001|800000102|9000001021",
    "700002|800000102|9000001022",
    "700002|800000102|9000001022#2",
  ]);
  assert.equal(new Set(o.items.map((i) => i.providerLineKey)).size, 4, "unique within the order by construction");
  assert.equal(buildShopeeOrderItemIdentity({ orderItemId: null, itemId: "1", modelId: null }), "-|1|-");
});

test("an order with an invalid line is rejected whole (no silently wrong totals); currency fallback", () => {
  const bad = parseOrderDetails({
    error: "",
    response: {
      order_list: [
        { order_sn: "A1", currency: "VND", item_list: [{ item_id: 1, model_quantity_purchased: 1 }, { item_id: 2, model_quantity_purchased: 0 }] },
        { order_sn: "A2", currency: "VND", item_list: [{ model_quantity_purchased: 1 }] },
        { order_sn: "A3", item_list: [{ item_id: 3, model_quantity_purchased: 1, model_id: "0" }] },
        { order_sn: "A4", item_list: [] },
        { order_status: "COMPLETED" },
      ],
    },
  }, { fallbackCurrency: "VND" });
  assert.deepEqual(bad.orders.map((o) => o.externalOrderSn), ["A3", "A4"]);
  assert.deepEqual(bad.issues.map((i) => i.externalId), ["A1", "A2", null]);
  assert.equal(bad.orders[0].currency, "VND", "shop currency used when the order omits it");
  assert.equal(bad.orders[0].items[0].itemName, "#3", "missing item_name → placeholder, not a reject");
  const noCurrency = parseOrderDetails({ error: "", response: { order_list: [{ order_sn: "B1", item_list: [] }] } });
  assert.equal(noCurrency.orders.length, 0, "no currency anywhere → rejected (NOT NULL)");
});

test("fingerprint changes on status / structure, not on package noise", () => {
  const raw = structuredClone(fixtures.ordersBySn.get("251013NORMAL01")) as Record<string, unknown>;
  const fp = (r: unknown) => orderFingerprint(parseOrderDetails({ error: "", response: { order_list: [r] } }).orders[0]);
  const base = fp(raw);
  assert.equal(fp({ ...raw, package_list: [{ package_number: "OTHER" }] }), base);
  assert.notEqual(fp({ ...raw, order_status: "SHIPPED" }), base);
  const items = structuredClone(raw.item_list) as Array<Record<string, unknown>>;
  items[0].model_quantity_purchased = 3;
  assert.notEqual(fp({ ...raw, item_list: items }), base);
});

test("windows: any range is split into ≤ 15-day windows", () => {
  const from = 1_700_000_000;
  const w = splitTimeWindows(from, from + 40 * 86400, MAX_ORDER_WINDOW_SECONDS);
  assert.equal(w.length, 3);
  assert.ok(w.every((x) => x.to - x.from <= MAX_ORDER_WINDOW_SECONDS));
  assert.equal(w[0].from, from);
  assert.equal(w[2].to, from + 40 * 86400);
  assert.equal(w[1].from, w[0].to);
  assert.equal(splitTimeWindows(from, from + 60, MAX_ORDER_WINDOW_SECONDS).length, 1);
  assert.throws(() => splitTimeWindows(from, from - 1, MAX_ORDER_WINDOW_SECONDS));
});

test("mapWithConcurrency never exceeds the limit and keeps result order", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
});

test("status helpers: COMPLETED ≠ settled, CANCELLED distinct, IN_CANCEL still active", () => {
  assert.equal(isOrderCompleted("COMPLETED"), true);
  assert.equal(isFinancialSyncEligible("COMPLETED"), true);
  assert.equal(isFinancialSyncEligible("SHIPPED"), false);
  assert.equal(isOrderCancelled("CANCELLED"), true);
  assert.equal(isOrderActive("IN_CANCEL"), true);
  assert.equal(isOrderActive("CANCELLED"), false);
  assert.equal(isOrderActive("SOMETHING_NEW"), false);
});
