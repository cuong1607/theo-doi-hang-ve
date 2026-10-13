// ============================================================
// SHOPEE-3 — order sync against the REAL database in .env.local (local Docker
// Supabase in dev) with the FIXTURE order provider:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/order-sync.integration.test.ts
//
// Each test seeds its own fixture shop + Shopee catalog (with chosen mappings)
// and builds its own order fixtures, so mapping outcomes are deterministic.
// Everything is deleted in `after` (shop cascade; test products deleted).
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { hasPermission } from "../../auth/permissions.ts";
import { changeChannelModelMappingControlled, mapChannelModelToProduct, unmapChannelModel } from "../core/sku-mapping.ts";
import { ShopeeApiError } from "./errors.ts";
import { FixtureShopeeOrderProvider, type ListOrdersInput, type OrderFixtureSet } from "./order-provider.ts";
import { OrderSyncRefusedError, ShopeeOrderSyncService, type ProductEnsurer } from "./order-sync.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `s3${Date.now()}`;
const shopIds: string[] = [];
const productIds: string[] = [];
let supplierId = "";
let userId = "";
let n = 0;
const NOW = Math.floor(Date.now() / 1000);

before(async () => {
  supplierId = (await db.from("suppliers").select("id").limit(1).single()).data!.id;
  userId = (await db.from("profiles").select("id").limit(1).single()).data!.id;
});

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
  if (productIds.length) await db.from("products").delete().in("id", productIds);
});

async function product(label: string): Promise<string> {
  const { data, error } = await db.from("products").insert({ sku: `${TAG}_${label}_${++n}`, name: label, unit: "chiec", current_price: 777, supplier_id: supplierId }).select("id").single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id;
}

async function shop(dataSource: "fixture" | "live" = "fixture"): Promise<string> {
  const { data, error } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: "orders", currency: "VND", data_source: dataSource }).select("id").single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

/** Seeds Shopee catalog units; model null → synthetic NO_MODEL unit. Returns channel model id by "item|model". */
async function catalog(shopId: string, units: Array<{ item: string; model: string | null; productId?: string | null }>) {
  const ids = new Map<string, string>();
  for (const u of units) {
    const { data: cp } = await db
      .from("channel_products")
      .upsert({ shop_id: shopId, external_item_id: u.item, item_name: `Item ${u.item}`, has_model: u.model !== null }, { onConflict: "shop_id,external_item_id" })
      .select("id")
      .single();
    const { data: m, error } = await db
      .from("channel_product_models")
      .insert({
        channel_product_id: cp!.id,
        external_model_id: u.model ?? "NO_MODEL",
        is_synthetic: u.model === null,
        internal_product_id: u.productId ?? null,
        mapping_status: u.productId ? "manual_mapped" : "unmapped",
      })
      .select("id")
      .single();
    if (error) throw error;
    ids.set(`${u.item}|${u.model ?? "NO_MODEL"}`, m!.id);
  }
  return ids;
}

type Line = { oid?: number | null; item: number; model?: number; qty?: number; orig?: number | null; disc?: number | null; sku?: string };
type OrderSpec = { sn: string; status?: string; update?: number; lines: Line[] };

function fixtures(orders: OrderSpec[], pageSize = 100): OrderFixtureSet {
  const ordersBySn = new Map<string, unknown>();
  for (const o of orders) {
    ordersBySn.set(o.sn, {
      order_sn: o.sn,
      order_status: o.status ?? "READY_TO_SHIP",
      create_time: (o.update ?? NOW - 3600) - 600,
      update_time: o.update ?? NOW - 3600,
      currency: "VND",
      total_amount: 100000,
      shipping_carrier: "SPX Express",
      item_list: o.lines.map((l, i) => ({
        order_item_id: l.oid === undefined ? 1000 + i : l.oid,
        item_id: l.item,
        item_name: `Item ${l.item}`,
        item_sku: l.sku ?? "",
        model_id: l.model ?? 0,
        model_sku: l.sku ?? "",
        model_original_price: l.orig === undefined ? 60000 : l.orig,
        model_discounted_price: l.disc === undefined ? 45000 : l.disc,
        model_quantity_purchased: l.qty ?? 1,
      })),
    });
  }
  const sns = orders.map((o) => o.sn);
  const listPages: unknown[] = [];
  for (let i = 0; i < Math.max(sns.length, 1); i += pageSize) {
    const more = i + pageSize < sns.length;
    listPages.push({
      error: "",
      request_id: `fx-${i}`,
      response: { more, next_cursor: more ? `c${i + pageSize}` : "", order_list: sns.slice(i, i + pageSize).map((sn) => ({ order_sn: sn, order_status: "READY_TO_SHIP" })) },
    });
  }
  return { listPages, ordersBySn };
}

function syncer(fx: OrderFixtureSet, opts: { products?: ProductEnsurer; filterByTime?: boolean; onCall?: (c: { apiName: string; input: unknown }) => void | Promise<void> } = {}) {
  const calls: Array<{ apiName: string; input: unknown }> = [];
  const provider = new FixtureShopeeOrderProvider(fx, {
    filterByTime: opts.filterByTime,
    onCall: async (c) => {
      calls.push(c);
      await opts.onCall?.(c);
    },
  });
  return { service: new ShopeeOrderSyncService({ db, provider, products: opts.products ?? null, logger: () => {} }), calls };
}

const summary = async (shopId: string) =>
  (await db.from("v_channel_order_summary").select("*").eq("shop_id", shopId).order("external_order_sn")).data as Array<Record<string, string | number | boolean | null>>;
const lines = async (sn: string, shopId: string) => {
  const { data: o } = await db.from("channel_orders").select("id").eq("shop_id", shopId).eq("external_order_sn", sn).single();
  return (await db.from("channel_order_items").select("*").eq("order_id", o!.id).order("provider_line_key")).data as Array<Record<string, string | null>>;
};

// ------------------------------------------------------------ order list

test("1 + 2 + 6. cursor pagination across pages; duplicate discovery stored once", async () => {
  const shopId = await shop();
  const fx = fixtures(Array.from({ length: 5 }, (_, i) => ({ sn: `${TAG}P${i}`, lines: [{ item: 1 }] })), 2);
  // Duplicate: page 2 lists an order already listed on page 1.
  ((fx.listPages[1] as { response: { order_list: unknown[] } }).response.order_list).push({ order_sn: `${TAG}P0` });
  const { service, calls } = syncer(fx);
  const r = await service.sync(shopId);
  assert.equal(r.status, "success", "item 1 is not in the catalog: lines stay unresolved, which is NOT a sync failure");
  assert.equal(r.linesUnresolved, 5);
  const listCalls = calls.filter((c) => c.apiName === "v2.order.get_order_list").map((c) => (c.input as ListOrdersInput).cursor);
  assert.deepEqual(listCalls, ["", "c2", "c4"]);
  assert.equal(r.pagesFetched, 3);
  assert.equal(r.ordersDiscovered, 5);
  assert.equal((await summary(shopId)).length, 5);
});

test("3. repeated cursor → that window fails safely (no infinite loop), run marked failed", async () => {
  const shopId = await shop();
  const fx = fixtures([{ sn: `${TAG}R1`, lines: [{ item: 1 }] }]);
  (fx.listPages[0] as { response: { more: boolean; next_cursor: string } }).response.more = true;
  (fx.listPages[0] as { response: { more: boolean; next_cursor: string } }).response.next_cursor = "";
  const r = await syncer(fx).service.sync(shopId);
  assert.equal(r.status, "failed");
  assert.equal(r.errorCode, "discovery_failed");
  assert.match(r.errorMessage ?? "", /next_cursor/);
});

test("4. backfill over 40 days is split into ≤ 15-day windows and finds orders in every window", async () => {
  const shopId = await shop();
  await catalog(shopId, [{ item: "1", model: null }]);
  const from = NOW - 40 * 86400;
  const fx = fixtures([
    { sn: `${TAG}W1`, update: from + 2 * 86400, lines: [{ item: 1 }] },
    { sn: `${TAG}W2`, update: from + 20 * 86400, lines: [{ item: 1 }] },
    { sn: `${TAG}W3`, update: from + 35 * 86400, lines: [{ item: 1 }] },
  ]);
  const { service, calls } = syncer(fx, { filterByTime: true });
  const r = await service.backfill({ shopId, from: new Date(from * 1000), to: new Date(NOW * 1000) });
  assert.equal(r.status, "success", JSON.stringify(r.failures));
  const windows = calls.filter((c) => c.apiName === "v2.order.get_order_list").map((c) => c.input as ListOrdersInput);
  assert.equal(windows.length, 3);
  assert.ok(windows.every((w) => w.timeRangeField === "update_time" && w.timeTo - w.timeFrom <= 15 * 86400));
  assert.equal(r.ordersDiscovered, 3);
  const { data: state } = await db.from("channel_sync_states").select("last_success_at").eq("shop_id", shopId).eq("sync_type", "order").single();
  assert.equal(state!.last_success_at, null, "backfill never advances the incremental checkpoint");
});

test("5. incremental uses last success − 10 min overlap; first run looks back 15 days", async () => {
  const shopId = await shop();
  await catalog(shopId, [{ item: "1", model: null }]);
  const fx = fixtures([{ sn: `${TAG}I1`, lines: [{ item: 1 }] }]);
  const first = syncer(fx);
  await first.service.sync(shopId);
  const w1 = first.calls.find((c) => c.apiName === "v2.order.get_order_list")!.input as ListOrdersInput;
  assert.ok(Math.abs(w1.timeTo - w1.timeFrom - 15 * 86400) <= 2);
  const { data: state } = await db.from("channel_sync_states").select("last_success_at").eq("shop_id", shopId).eq("sync_type", "order").single();
  const second = syncer(fx);
  await second.service.sync(shopId);
  const w2 = second.calls.find((c) => c.apiName === "v2.order.get_order_list")!.input as ListOrdersInput;
  assert.equal(w2.timeFrom, Math.floor((new Date(state!.last_success_at).getTime() - 600_000) / 1000));
});

// ------------------------------------------------------------ order detail

test("7–13 + 15. normal / multi-item / multi-model / no-model / blank SKU / cancelled / completed; re-sync no duplicates", async () => {
  const shopId = await shop();
  const pa = await product("A");
  const pb = await product("B");
  await catalog(shopId, [
    { item: "10", model: null, productId: pa },
    { item: "20", model: "201", productId: pb },
    { item: "20", model: "202", productId: pa },
  ]);
  const fx = fixtures([
    { sn: `${TAG}NORMAL`, lines: [{ item: 10, qty: 2 }] },
    { sn: `${TAG}MULTI`, lines: [{ item: 10 }, { item: 20, model: 201, qty: 3 }] },
    { sn: `${TAG}MODELS`, lines: [{ item: 20, model: 201 }, { item: 20, model: 202, sku: "" }] },
    { sn: `${TAG}CANCEL`, status: "CANCELLED", lines: [{ item: 10 }] },
    { sn: `${TAG}DONE`, status: "COMPLETED", lines: [{ item: 20, model: 202 }] },
  ]);
  const r1 = await syncer(fx).service.sync(shopId);
  assert.equal(r1.status, "success", JSON.stringify(r1.failures));
  assert.deepEqual([r1.counts.created, r1.counts.updated, r1.ordersCancelled, r1.ordersCompleted], [5, 0, 1, 1]);
  const r2 = await syncer(fx).service.sync(shopId);
  assert.deepEqual([r2.counts.created, r2.counts.updated], [0, 5]);

  const rows = await summary(shopId);
  assert.equal(rows.length, 5);
  const by = Object.fromEntries(rows.map((r) => [r.external_order_sn, r]));
  assert.equal(by[`${TAG}MULTI`].line_count, 2);
  assert.equal(by[`${TAG}CANCEL`].order_status, "CANCELLED", "cancelled orders are kept");
  assert.equal(by[`${TAG}DONE`].financial_sync_eligible, true);
  assert.equal(by[`${TAG}NORMAL`].financial_sync_eligible, false);
  assert.ok(rows.every((r) => r.financial_status === "pending"), "no misleading 'estimated' status");

  const normal = await lines(`${TAG}NORMAL`, shopId);
  assert.equal(normal.length, 1);
  assert.deepEqual([normal[0].external_model_id, normal[0].internal_product_id], [null, pa], "no-model line → synthetic unit → product");
  const models = await lines(`${TAG}MODELS`, shopId);
  assert.deepEqual(models.map((l) => [l.external_model_id, l.model_sku, l.internal_product_id]), [
    ["201", null, pb],
    ["202", null, pa],
  ]);
  const { count } = await db.from("channel_order_items").select("id", { count: "exact", head: true }).in("order_id", (await db.from("channel_orders").select("id").eq("shop_id", shopId)).data!.map((o) => o.id));
  assert.equal(count, 7, "no duplicate lines after re-sync");
});

test("14. status update on re-sync updates the same order", async () => {
  const shopId = await shop();
  await catalog(shopId, [{ item: "1", model: null }]);
  await syncer(fixtures([{ sn: `${TAG}ST`, status: "READY_TO_SHIP", lines: [{ item: 1 }] }])).service.sync(shopId);
  await syncer(fixtures([{ sn: `${TAG}ST`, status: "SHIPPED", update: NOW - 60, lines: [{ item: 1 }] }])).service.sync(shopId);
  const rows = await summary(shopId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_status, "SHIPPED");
});

// ------------------------------------------------------------ mapping readiness

test("16 + 17 + 18 + 21. readiness complete / partial / unmapped; SKU text never used to map", async () => {
  const shopId = await shop();
  const pa = await product("A");
  const { data: p } = await db.from("products").select("sku").eq("id", pa).single();
  await catalog(shopId, [
    { item: "1", model: null, productId: pa },
    { item: "2", model: null }, // unmapped unit whose order line carries the internal SKU text
  ]);
  await syncer(
    fixtures([
      { sn: `${TAG}ALL`, lines: [{ item: 1 }] },
      { sn: `${TAG}PART`, lines: [{ item: 1 }, { item: 2, sku: p!.sku }] },
      { sn: `${TAG}NONE`, lines: [{ item: 2, sku: p!.sku }] },
    ]),
  ).service.sync(shopId);
  const by = Object.fromEntries((await summary(shopId)).map((r) => [r.external_order_sn, r]));
  assert.deepEqual([by[`${TAG}ALL`].mapping_readiness, by[`${TAG}ALL`].cogs_readiness], ["complete", "pending"], "mapped but no cost yet → COGS pending");
  assert.deepEqual([by[`${TAG}PART`].mapping_readiness, by[`${TAG}PART`].cogs_readiness], ["partial", "incomplete"]);
  assert.deepEqual([by[`${TAG}NONE`].mapping_readiness, by[`${TAG}NONE`].cogs_readiness], ["unmapped", "incomplete"]);
  const none = await lines(`${TAG}NONE`, shopId);
  assert.equal(none[0].internal_product_id, null, "exact internal SKU in the order line is NOT used as identity");
  assert.equal(none[0].total_cogs, null, "unknown COGS stays NULL, never 0");
});

test("19 + 20. missing listing: ensureItems() is asked once, then resolved; without it the line stays unresolved", async () => {
  const shopId = await shop();
  const pa = await product("A");
  const fx = fixtures([{ sn: `${TAG}MISS`, lines: [{ item: 77 }, { item: 78 }] }]);

  const noEnsure = await syncer(fx).service.sync(shopId);
  assert.equal(noEnsure.status, "success", "unresolved lines are not a failure");
  assert.equal(noEnsure.linesUnresolved, 2);
  let ls = await lines(`${TAG}MISS`, shopId);
  assert.ok(ls.every((l) => l.channel_model_id === null && l.internal_product_id === null));

  const asked: string[][] = [];
  const ensurer: ProductEnsurer = {
    async ensureItems(sid, itemIds) {
      asked.push(itemIds);
      await catalog(sid, [{ item: "77", model: null, productId: pa }]); // 78 still unknown to "Shopee"
      return { failures: [] };
    },
  };
  await syncer(fx, { products: ensurer }).service.sync(shopId);
  assert.deepEqual(asked, [["77", "78"]]);
  ls = await lines(`${TAG}MISS`, shopId);
  assert.deepEqual(ls.map((l) => [l.external_item_id, l.internal_product_id]), [["77", pa], ["78", null]]);
});

// ------------------------------------------------------------ historical mapping

test("22 + 23 + 24. line snapshot; later mapping backfills NULL lines only; old snapshots never rewritten", async () => {
  const shopId = await shop();
  const pa = await product("A");
  const pb = await product("B");
  const units = await catalog(shopId, [{ item: "1", model: null }, { item: "2", model: null, productId: pa }]);

  await syncer(fixtures([{ sn: `${TAG}H1`, lines: [{ item: 1 }, { item: 2 }] }])).service.sync(shopId);
  let ls = await lines(`${TAG}H1`, shopId);
  assert.deepEqual(ls.map((l) => l.internal_product_id), [null, pa], "snapshot copied from the current mapping");

  // Map unit 1 → backfills only its NULL line.
  assert.deepEqual(await mapChannelModelToProduct(db, { channelModelId: units.get("1|NO_MODEL")!, internalProductId: pb, mappedBy: userId }), { ok: true });
  ls = await lines(`${TAG}H1`, shopId);
  assert.deepEqual(ls.map((l) => l.internal_product_id), [pb, pa]);

  // Controlled remap of unit 2 (used by orders): old line keeps A; a NEW order gets B.
  const res = await changeChannelModelMappingControlled(db, { channelModelId: units.get("2|NO_MODEL")!, internalProductId: pb, reason: "ghép nhầm lúc đầu", changedBy: userId });
  assert.deepEqual(res, { ok: true });
  await syncer(fixtures([{ sn: `${TAG}H1`, lines: [{ item: 1 }, { item: 2 }] }, { sn: `${TAG}H2`, lines: [{ item: 2 }] }])).service.sync(shopId);
  assert.deepEqual((await lines(`${TAG}H1`, shopId)).map((l) => l.internal_product_id), [pb, pa], "re-sync does not rewrite history");
  assert.deepEqual((await lines(`${TAG}H2`, shopId)).map((l) => l.internal_product_id), [pb]);
});

test("25 + 26. unmap / direct remap blocked once orders use the mapping (spec messages)", async () => {
  const shopId = await shop();
  const pa = await product("A");
  const pb = await product("B");
  const units = await catalog(shopId, [{ item: "1", model: null, productId: pa }, { item: "9", model: null, productId: pa }]);
  await syncer(fixtures([{ sn: `${TAG}U1`, lines: [{ item: 1 }] }])).service.sync(shopId);

  const unmap = await unmapChannelModel(db, { channelModelId: units.get("1|NO_MODEL")! });
  assert.deepEqual(unmap, { ok: false, code: "used_by_orders_unmap", message: "Không thể bỏ ghép biến thể này vì đã có đơn hàng sử dụng mapping." });
  const remap = await mapChannelModelToProduct(db, { channelModelId: units.get("1|NO_MODEL")!, internalProductId: pb, mappedBy: userId });
  assert.equal(!remap.ok && remap.code, "used_by_orders_remap");
  assert.match(!remap.ok ? remap.message : "", /^Mapping đã được sử dụng trong đơn hàng lịch sử\. Không thể đổi trực tiếp/);
  assert.deepEqual(await unmapChannelModel(db, { channelModelId: units.get("9|NO_MODEL")! }), { ok: true }, "unit without orders can still be unmapped");
});

// ------------------------------------------------------------ money

test("27 + 28 + 29 + 30. exact NUMERIC item values; unknown price → NULL value; no COGS written", async () => {
  const shopId = await shop();
  await catalog(shopId, [{ item: "1", model: null }]);
  await syncer(
    fixtures([
      { sn: `${TAG}M1`, lines: [{ item: 1, qty: 3, orig: 19.99, disc: 9.95 }, { item: 1, oid: 5, qty: 2, orig: 100000, disc: 85000 }] },
      { sn: `${TAG}M2`, lines: [{ item: 1, disc: null }] },
    ]),
  ).service.sync(shopId);
  const by = Object.fromEntries((await summary(shopId)).map((r) => [r.external_order_sn, r]));
  assert.equal(by[`${TAG}M1`].item_gross_value, "170029.850000", "3 × 9.95 + 2 × 85000, exact");
  assert.equal(by[`${TAG}M1`].original_item_value, "200059.970000");
  assert.equal(by[`${TAG}M1`].total_item_quantity, "5.0000");
  assert.equal(by[`${TAG}M2`].item_gross_value, null, "a line without price makes the total unknown, not partial");
  const ls = await lines(`${TAG}M1`, shopId);
  assert.ok(ls.every((l) => l.cost_per_unit_snapshot === null && l.total_cogs === null && l.cost_method === null));
  const { count } = await db.from("order_financials").select("id", { count: "exact", head: true }).in("order_id", (await db.from("channel_orders").select("id").eq("shop_id", shopId)).data!.map((o) => o.id));
  assert.equal(count, 0, "no fake financial rows");
});

// ------------------------------------------------------------ sync robustness

test("31 + 33. partial detail failure (one malformed order) keeps the others; log counts", async () => {
  const shopId = await shop();
  await catalog(shopId, [{ item: "1", model: null }]);
  const fx = fixtures([{ sn: `${TAG}OK1`, lines: [{ item: 1 }] }, { sn: `${TAG}BAD`, lines: [{ item: 1 }] }, { sn: `${TAG}OK2`, lines: [{ item: 1 }] }]);
  ((fx.ordersBySn.get(`${TAG}BAD`) as { item_list: Array<Record<string, unknown>> }).item_list[0]).model_quantity_purchased = 0;
  const r = await syncer(fx).service.sync(shopId);
  assert.equal(r.status, "partial");
  assert.deepEqual(r.failures.map((f) => f.externalId), [`${TAG}BAD`]);
  assert.equal((await summary(shopId)).length, 2);
  const { data: log } = await db.from("channel_sync_logs").select("*").eq("id", r.logId).single();
  assert.deepEqual([log!.status, log!.records_fetched, log!.records_created, log!.records_updated, log!.records_failed], ["partial", 3, 2, 0, 1]);
  const meta = log!.metadata as Record<string, unknown>;
  assert.deepEqual([meta.windowsProcessed, meta.pagesFetched, meta.detailsFetched, meta.mappingUnmapped, meta.providerMode], [1, 1, 2, 2, "fixture"]);
  assert.ok(!JSON.stringify(log).match(/access_token|refresh_token|partner_key/i));
  const { data: state } = await db.from("channel_sync_states").select("last_success_at, last_error_code").eq("shop_id", shopId).eq("sync_type", "order").single();
  assert.equal(state!.last_success_at, null, "incomplete run does not advance the checkpoint");
  assert.equal(state!.last_error_code, "partial_failure");
});

test("32. retryable provider error on detail: run fails without losing anything, next run recovers", async () => {
  const shopId = await shop();
  await catalog(shopId, [{ item: "1", model: null }]);
  const fx = fixtures([{ sn: `${TAG}RT`, lines: [{ item: 1 }] }]);
  let first = true;
  const flaky = syncer(fx, {
    onCall: (c) => {
      if (c.apiName === "v2.order.get_order_detail" && first) {
        first = false;
        throw new ShopeeApiError({ apiPath: "/api/v2/order/get_order_detail", errorCode: "error_server", message: "busy", httpStatus: 503 });
      }
    },
  });
  const r1 = await flaky.service.sync(shopId);
  assert.equal(r1.status, "failed");
  assert.match(r1.failures[0].reason, /error_server/);
  const r2 = await flaky.service.sync(shopId);
  assert.equal(r2.status, "success");
  assert.equal((await summary(shopId)).length, 1);
});

test("34 + 35. snapshots: identical polling keeps ONE row; a status change adds a transition snapshot", async () => {
  const shopId = await shop();
  await catalog(shopId, [{ item: "1", model: null }]);
  const fx = fixtures([{ sn: `${TAG}SN`, lines: [{ item: 1 }] }]);
  for (let i = 0; i < 3; i++) await syncer(fx).service.sync(shopId);
  const count = async () => (await db.from("channel_api_snapshots").select("id, fingerprint, source_mode", { count: "exact" }).eq("shop_id", shopId).eq("entity_type", "order"));
  let snaps = await count();
  assert.equal(snaps.count, 1, "3 identical polls → 1 snapshot");
  assert.equal(snaps.data![0].source_mode, "fixture");
  await syncer(fixtures([{ sn: `${TAG}SN`, status: "SHIPPED", update: NOW - 30, lines: [{ item: 1 }] }])).service.sync(shopId);
  snaps = await count();
  assert.equal(snaps.count, 2, "status transition kept as history");
});

// ------------------------------------------------------------ permissions / guards

test("36 + 37 + 38. permissions matrix and fixture guard", async () => {
  assert.equal(hasPermission("viewer", "channel:view"), true);
  assert.equal(hasPermission("viewer", "channel:map"), false);
  assert.equal(hasPermission("staff", "channel:map"), true);
  assert.equal(hasPermission("staff", "channel:manage"), false, "staff cannot run order sync");
  assert.equal(hasPermission("admin", "channel:manage"), true);
  const liveShop = await shop("live");
  await assert.rejects(syncer(fixtures([])).service.sync(liveShop), (err: unknown) => err instanceof OrderSyncRefusedError && err.code === "source_mismatch");
});
