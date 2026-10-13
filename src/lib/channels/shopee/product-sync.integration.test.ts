// ============================================================
// SHOPEE-2 — product sync + SKU mapping against the REAL database in
// .env.local (local Docker Supabase in dev) with the FIXTURE provider:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/product-sync.integration.test.ts
//
// Every test builds its own fixture set with TAG-unique SKUs and its own
// fixture shop(s) (data_source = 'fixture', external_shop_id FIXTURE_SHOP_…);
// everything is deleted in `after` (shops cascade; test products deleted).
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { hasPermission } from "../../auth/permissions.ts";
import { autoMapChannelModels, mapChannelModelToProduct, unmapChannelModel } from "../core/sku-mapping.ts";
import { FixtureShopeeProductProvider, type ListItemsInput, type ProductFixtureSet } from "./product-provider.ts";
import { ProductSyncRefusedError, ShopeeProductSyncService } from "./product-sync.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `s2${Date.now()}`;
const shopIds: string[] = [];
const productIds: string[] = [];
let supplierId = "";
let shopCounter = 0;

before(async () => {
  const { data } = await db.from("suppliers").select("id").limit(1).single();
  supplierId = data!.id;
});

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
  if (productIds.length) await db.from("products").delete().in("id", productIds);
});

async function makeShop(dataSource: "fixture" | "live" = "fixture"): Promise<string> {
  const { data, error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++shopCounter}`, shop_name: `Fixture ${shopCounter}`, currency: "VND", data_source: dataSource })
    .select("id")
    .single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

async function makeProduct(sku: string, extra: { is_active?: boolean } = {}): Promise<string> {
  const { data, error } = await db
    .from("products")
    .insert({ sku, name: `Test ${sku}`, unit: "chiec", current_price: 12345, supplier_id: supplierId, ...extra })
    .select("id")
    .single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id;
}

const env = (response: Record<string, unknown>) => ({ error: "", message: "", warning: "", request_id: `fx-${Math.random()}`, response });

type ItemSpec = {
  id: number;
  status?: string;
  name?: string;
  sku?: string;
  hasModel?: boolean;
  price?: number;
  stock?: number;
  kit?: boolean;
  models?: Array<{ id: number; sku?: string; price?: number; stock?: number; tier?: number }>;
};

/** Programmatic fixture set shaped like the checked-in fixtures, paged by `pageSize`. */
function buildFixtures(items: ItemSpec[], pageSize = 3): ProductFixtureSet {
  const pages: unknown[] = [];
  for (let i = 0; i < items.length || i === 0; i += pageSize) {
    const slice = items.slice(i, i + pageSize);
    const next = Math.min(i + pageSize, items.length);
    pages.push(
      env({
        item: slice.map((it) => ({ item_id: it.id, item_status: it.status ?? "NORMAL", update_time: 1760000000 + it.id % 1000, tag: { kit: it.kit ?? false } })),
        total_count: items.length,
        has_next_page: next < items.length,
        next_offset: next,
      }),
    );
    if (items.length === 0) break;
  }
  const itemBaseInfo = env({
    item_list: items.map((it) => ({
      item_id: it.id,
      category_id: 100636,
      item_name: it.name ?? `Item ${it.id}`,
      item_sku: it.sku ?? "",
      create_time: 1700000000,
      update_time: 1760000000 + (it.id % 1000),
      item_status: it.status ?? "NORMAL",
      has_model: it.hasModel ?? false,
      ...(it.hasModel ? {} : { price_info: [{ currency: "VND", original_price: (it.price ?? 100000) + 9000, current_price: it.price ?? 100000 }] }),
      stock_info_v2: { summary_info: { total_reserved_stock: 1, total_available_stock: it.stock ?? 10 } },
    })),
  });
  const modelLists: Record<string, unknown> = {};
  for (const it of items.filter((x) => x.hasModel)) {
    modelLists[String(it.id)] = env({
      tier_variation: [{ name: "Size", option_list: (it.models ?? []).map((m, i) => ({ option: `Size ${m.tier ?? i}` })) }],
      model: (it.models ?? []).map((m, i) => ({
        model_id: m.id,
        tier_index: [i],
        model_sku: m.sku ?? "",
        model_status: "MODEL_NORMAL",
        price_info: [{ currency: "VND", original_price: (m.price ?? 50000) + 1000, current_price: m.price ?? 50000 }],
        stock_info_v2: { summary_info: { total_reserved_stock: 0, total_available_stock: m.stock ?? 5 } },
      })),
    });
  }
  return { itemListPages: pages, itemBaseInfo, modelLists };
}

function syncer(fixtures: ProductFixtureSet, onCall?: ConstructorParameters<typeof FixtureShopeeProductProvider>[1]["onCall"]) {
  const calls: Array<{ apiName: string; input: unknown }> = [];
  const provider = new FixtureShopeeProductProvider(fixtures, {
    onCall: async (call) => {
      calls.push(call);
      await onCall?.(call);
    },
  });
  return { service: new ShopeeProductSyncService({ db, provider, logger: () => {} }), calls };
}

async function listing(shopId: string) {
  const { data } = await db.from("v_channel_model_listing").select("*").eq("shop_id", shopId).order("external_item_id").order("external_model_id");
  return (data ?? []) as Array<Record<string, string | boolean | null>>;
}

const sku = (s: string) => `${TAG}_${s}`;

// ------------------------------------------------------------------ paging

test("1 + 2 + 3. discovery pages through get_item_list until has_next_page=false (all statuses requested)", async () => {
  const shopId = await makeShop();
  const items: ItemSpec[] = Array.from({ length: 7 }, (_, i) => ({ id: 810000 + i, sku: sku(`p${i}`) }));
  const { service, calls } = syncer(buildFixtures(items, 3));
  const result = await service.sync(shopId);
  assert.equal(result.status, "success", JSON.stringify(result.failures));
  assert.equal(result.pagesFetched, 3);
  assert.equal(result.itemsDiscovered, 7);
  const listCalls = calls.filter((c) => c.apiName === "v2.product.get_item_list").map((c) => c.input as ListItemsInput);
  assert.deepEqual(listCalls.map((c) => c.offset), [0, 3, 6], "offset follows next_offset; stops after last page");
  assert.equal(listCalls[0].pageSize, 100);
  assert.deepEqual([...listCalls[0].itemStatus], ["NORMAL", "UNLIST", "REVIEWING", "BANNED", "SELLER_DELETE", "SHOPEE_DELETE"]);
  assert.equal(listCalls[0].updateTimeFrom, undefined, "initial sync: no time filter");
});

// --------------------------------------------------------------- mapping

test("4 + 5 + 10 + 11 + 12. items, models, synthetic NO_MODEL unit, blank SKUs mapped correctly", async () => {
  const shopId = await makeShop();
  const fx = buildFixtures([
    { id: 820001, name: "No model", sku: sku("nm"), price: 45000, stock: 120 },
    { id: 820002, name: "Has models", sku: "PARENT", hasModel: true, models: [{ id: 9820021, sku: sku("m1"), price: 90000, stock: 40 }, { id: 9820022, sku: "", price: 99000 }] },
    { id: 820003, name: "Blank SKU", sku: "" },
  ]);
  const result = await syncer(fx).service.sync(shopId);
  assert.equal(result.status, "success");

  const { data: products } = await db.from("channel_products").select("external_item_id, item_name, item_sku, has_model, channel_current_price::text, available_stock::text, item_status").eq("shop_id", shopId).order("external_item_id");
  assert.deepEqual(products!.map((p) => [p.external_item_id, p.item_sku, p.has_model, p.channel_current_price, p.available_stock]), [
    ["820001", sku("nm"), false, "45000.00", "120.0000"],
    ["820002", "PARENT", true, null, "10.0000"],
    ["820003", null, false, "100000.00", "10.0000"],
  ]);

  const rows = await listing(shopId);
  assert.deepEqual(rows.map((r) => [r.external_item_id, r.external_model_id, r.is_synthetic, r.channel_sku, r.model_name]), [
    ["820001", "NO_MODEL", true, sku("nm"), null],
    ["820002", "9820021", false, sku("m1"), "Size 0"],
    ["820002", "9820022", false, null, "Size 1"],
    ["820003", "NO_MODEL", true, null, null],
  ]);
  const model = rows.find((r) => r.external_model_id === "9820021")!;
  assert.equal(model.channel_current_price, "90000.00");
  assert.equal(model.available_stock, "40.0000");
  assert.ok(rows.every((r) => r.mapping_status === "unmapped"), "no internal SKU exists → unmapped");
});

test("6. repeated sync is idempotent (no duplicates, second run creates nothing)", async () => {
  const shopId = await makeShop();
  const fx = buildFixtures([{ id: 830001, sku: sku("i1") }, { id: 830002, hasModel: true, models: [{ id: 9830021 }, { id: 9830022 }] }]);
  const first = await syncer(fx).service.sync(shopId);
  const second = await syncer(fx).service.sync(shopId);
  assert.equal(first.counts.created, 2 + 3);
  assert.equal(second.counts.created, 0);
  assert.equal(second.counts.updated, 2 + 3);
  assert.equal((await listing(shopId)).length, 3);
});

test("7 + 8 + 9. changed price / stock / status update the existing rows", async () => {
  const shopId = await makeShop();
  await syncer(buildFixtures([{ id: 840001, sku: sku("c1"), price: 100000, stock: 10 }, { id: 840002, hasModel: true, models: [{ id: 9840021, price: 50000, stock: 5 }] }])).service.sync(shopId);
  await syncer(buildFixtures([{ id: 840001, sku: sku("c1"), price: 88000, stock: 3, status: "UNLIST" }, { id: 840002, hasModel: true, models: [{ id: 9840021, price: 42000, stock: 0 }] }])).service.sync(shopId);
  const rows = await listing(shopId);
  const unit = rows.find((r) => r.external_item_id === "840001")!;
  assert.deepEqual([unit.channel_current_price, unit.available_stock, unit.item_status, unit.is_active], ["88000.00", "3.0000", "UNLIST", false]);
  const model = rows.find((r) => r.external_model_id === "9840021")!;
  assert.deepEqual([model.channel_current_price, model.available_stock], ["42000.00", "0.0000"]);
  assert.equal(rows.length, 2);
});

test("removed model / item gaining variations: old unit marked removed (kept with mapping), not deleted", async () => {
  const shopId = await makeShop();
  const productId = await makeProduct(sku("rm"));
  await syncer(buildFixtures([{ id: 845001, sku: sku("rm") }])).service.sync(shopId);
  assert.equal((await listing(shopId))[0].mapping_status, "auto_mapped");
  await syncer(buildFixtures([{ id: 845001, hasModel: true, models: [{ id: 9845011, sku: sku("new") }] }])).service.sync(shopId);
  const rows = await listing(shopId);
  const synthetic = rows.find((r) => r.external_model_id === "NO_MODEL")!;
  assert.ok(synthetic.removed_at, "synthetic unit removed");
  assert.equal(synthetic.internal_product_id, productId, "mapping history kept");
  assert.equal(rows.find((r) => r.external_model_id === "9845011")!.removed_at, null);
});

// ------------------------------------------------------------ SKU mapping

test("13 + 14 + 15. auto-map: exact (trim + case) match, no match → unmapped, duplicate SKU → conflict", async () => {
  const shopId = await makeShop();
  const exact = await makeProduct(sku("exact"));
  const cased = await makeProduct(sku("cased"));
  await makeProduct(sku("dup"));
  await makeProduct(sku("DUP"));
  await makeProduct(sku("inactive"), { is_active: false });
  const result = await syncer(
    buildFixtures([
      { id: 850001, sku: sku("exact") },
      { id: 850002, sku: `  ${sku("CASED")}  ` },
      { id: 850003, sku: sku("dup") },
      { id: 850004, sku: sku("nothing") },
      { id: 850005, sku: sku("inactive") },
      { id: 850006, sku: `${sku("exact")}-X` },
    ]),
  ).service.sync(shopId);
  assert.deepEqual(result.autoMap, { scanned: 6, mapped: 2, unmapped: 3, conflicts: 1 });
  const byItem = Object.fromEntries((await listing(shopId)).map((r) => [r.external_item_id, r]));
  assert.deepEqual([byItem["850001"].mapping_status, byItem["850001"].internal_product_id], ["auto_mapped", exact]);
  assert.deepEqual([byItem["850002"].mapping_status, byItem["850002"].internal_product_id], ["auto_mapped", cased]);
  assert.deepEqual([byItem["850003"].mapping_status, byItem["850003"].internal_product_id], ["mapping_conflict", null], "never picks one");
  assert.equal(byItem["850004"].mapping_status, "unmapped");
  assert.equal(byItem["850005"].mapping_status, "unmapped", "inactive internal products are not auto-mapped");
  assert.equal(byItem["850006"].mapping_status, "unmapped", "no fuzzy / prefix match");
  assert.ok(byItem["850001"].mapped_at);
});

test("16 + 17 + 19. manual mapping is kept by re-sync and never overwritten by auto-map", async () => {
  const shopId = await makeShop();
  const autoTarget = await makeProduct(sku("auto"));
  const manualTarget = await makeProduct(sku("manual"));
  const fx = buildFixtures([{ id: 860001, sku: sku("auto") }]);
  await syncer(fx).service.sync(shopId);
  const [row] = await listing(shopId);
  assert.equal(row.internal_product_id, autoTarget);

  const userId = (await db.from("profiles").select("id").limit(1).single()).data!.id;
  const res = await mapChannelModelToProduct(db, { channelModelId: row.channel_model_id as string, internalProductId: manualTarget, mappedBy: userId });
  assert.deepEqual(res, { ok: true });
  await syncer(fx).service.sync(shopId);
  await autoMapChannelModels(db, shopId);
  const [after] = await listing(shopId);
  assert.deepEqual([after.mapping_status, after.internal_product_id, after.mapped_by], ["manual_mapped", manualTarget, userId]);
  assert.equal(after.mapping_review_required, false, "manual mappings are never flagged");

  const bad = await mapChannelModelToProduct(db, { channelModelId: row.channel_model_id as string, internalProductId: "00000000-0000-0000-0000-000000000000", mappedBy: userId });
  assert.equal(bad.ok, false, "unknown product rejected");
});

test("18. unmap clears the mapping; auto-map may map it again later", async () => {
  const shopId = await makeShop();
  await makeProduct(sku("un"));
  await syncer(buildFixtures([{ id: 870001, sku: sku("un") }])).service.sync(shopId);
  const [row] = await listing(shopId);
  assert.deepEqual(await unmapChannelModel(db, { channelModelId: row.channel_model_id as string }), { ok: true });
  const [after] = await listing(shopId);
  assert.deepEqual([after.mapping_status, after.internal_product_id, after.mapped_at, after.mapped_by], ["unmapped", null, null, null]);
});

test("13. stability: auto-mapped unit whose Shopee SKU changes keeps its mapping and is flagged for review", async () => {
  const shopId = await makeShop();
  const target = await makeProduct(sku("stable"));
  await syncer(buildFixtures([{ id: 875001, sku: sku("stable") }])).service.sync(shopId);
  await syncer(buildFixtures([{ id: 875001, sku: sku("renamed_on_shopee") }])).service.sync(shopId);
  const [row] = await listing(shopId);
  assert.deepEqual([row.mapping_status, row.internal_product_id, row.mapping_review_required], ["auto_mapped", target, true]);
});

// ------------------------------------------------------------ multi-shop

test("20 + 21. same item/model ids in two shops; mapping and sync stay shop-scoped", async () => {
  const shopA = await makeShop();
  const shopB = await makeShop();
  await makeProduct(sku("shared"));
  const fx = buildFixtures([{ id: 880001, hasModel: true, models: [{ id: 9880011, sku: sku("shared") }] }]);
  await syncer(fx).service.sync(shopA);
  const rowsA = await listing(shopA);
  assert.equal(rowsA[0].mapping_status, "auto_mapped");

  // Shop B has the same ids but was never synced → nothing there; then sync B.
  assert.equal((await listing(shopB)).length, 0);
  await syncer(fx).service.sync(shopB);
  const rowsB = await listing(shopB);
  assert.equal(rowsB.length, 1);
  assert.notEqual(rowsB[0].channel_model_id, rowsA[0].channel_model_id, "separate rows per shop");
  assert.equal(rowsB[0].internal_product_id, rowsA[0].internal_product_id, "one internal SKU sold in two shops");

  await unmapChannelModel(db, { channelModelId: rowsB[0].channel_model_id as string });
  assert.equal((await listing(shopA))[0].mapping_status, "auto_mapped", "unmapping in B does not touch A");
});

// ------------------------------------------------------- failure handling

test("22. partial API failure: one item's model list fails → status partial, others synced, checkpoint not advanced", async () => {
  const shopId = await makeShop();
  const fx = buildFixtures([
    { id: 890001, sku: sku("ok1") },
    { id: 890002, hasModel: true, models: [{ id: 9890021 }] },
    { id: 890003, hasModel: true, models: [{ id: 9890031 }] },
  ]);
  const { service } = syncer(fx, (call) => {
    if (call.apiName === "v2.product.get_model_list" && (call.input as { itemId: string }).itemId === "890002") {
      throw Object.assign(new Error("simulated provider outage"), { name: "Error" });
    }
  });
  const result = await service.sync(shopId);
  assert.equal(result.status, "partial");
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(result.failures.map((f) => f.externalId), ["890002"]);
  const rows = await listing(shopId);
  assert.deepEqual(rows.map((r) => r.external_model_id).sort(), ["9890031", "NO_MODEL"]);

  const { data: state } = await db.from("channel_sync_states").select("last_success_at, last_failure_at, last_error_code").eq("shop_id", shopId).single();
  assert.equal(state!.last_success_at, null, "partial run does not advance the incremental checkpoint");
  assert.ok(state!.last_failure_at);
  assert.equal(state!.last_error_code, "partial_failure");
});

test("23. malformed payload entries are logged and never inserted", async () => {
  const shopId = await makeShop();
  const fx = buildFixtures([{ id: 895001, sku: sku("good") }, { id: 895002 }]);
  (fx.itemListPages[0] as { response: { item: unknown[] } }).response.item.push({ item_id: "not-a-number", item_status: "NORMAL" });
  const base = fx.itemBaseInfo as { response: { item_list: Array<Record<string, unknown>> } };
  base.response.item_list[1].has_model = "yes"; // wrong type
  const result = await syncer(fx).service.sync(shopId);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.failures.map((f) => f.externalId).sort(), ["895002", "not-a-number"]);
  assert.deepEqual((await listing(shopId)).map((r) => r.external_item_id), ["895001"]);
});

test("discovery failure → failed run, nothing advanced", async () => {
  const shopId = await makeShop();
  const { service } = syncer(buildFixtures([{ id: 896001 }]), (call) => {
    if (call.apiName === "v2.product.get_item_list") throw new Error("down");
  });
  const result = await service.sync(shopId);
  assert.equal(result.status, "failed");
  assert.equal((await listing(shopId)).length, 0);
});

test("guards: fixture provider refuses a LIVE shop; unknown shop refused", async () => {
  const liveShop = await makeShop("live");
  await assert.rejects(syncer(buildFixtures([{ id: 897001 }])).service.sync(liveShop), (err: unknown) => err instanceof ProductSyncRefusedError && err.code === "source_mismatch");
  await assert.rejects(syncer(buildFixtures([])).service.sync("00000000-0000-0000-0000-000000000000"), ProductSyncRefusedError);
  const { count } = await db.from("channel_sync_logs").select("id", { count: "exact", head: true }).eq("shop_id", liveShop);
  assert.equal(count, 0, "refused run writes nothing");
});

test("incremental sync uses last success time minus the overlap window", async () => {
  const shopId = await makeShop();
  const fx = buildFixtures([{ id: 898001 }]);
  await syncer(fx).service.sync(shopId);
  const { data: state } = await db.from("channel_sync_states").select("last_success_at").eq("shop_id", shopId).single();
  const { service, calls } = syncer(fx);
  await service.sync(shopId, { mode: "incremental" });
  const input = calls.find((c) => c.apiName === "v2.product.get_item_list")!.input as ListItemsInput;
  assert.equal(input.updateTimeFrom, Math.floor((new Date(state!.last_success_at).getTime() - 300_000) / 1000));
  assert.ok(input.updateTimeTo! >= input.updateTimeFrom! + 300);
});

// ------------------------------------------------------------- snapshots

test("24. snapshots: latest-only per (item, api), source_mode=fixture, changed payload replaces old", async () => {
  const shopId = await makeShop();
  await syncer(buildFixtures([{ id: 899001, price: 100000 }, { id: 899002, hasModel: true, models: [{ id: 9899021 }] }])).service.sync(shopId);
  await syncer(buildFixtures([{ id: 899001, price: 100000 }, { id: 899002, hasModel: true, models: [{ id: 9899021 }] }])).service.sync(shopId);
  await syncer(buildFixtures([{ id: 899001, price: 77000 }, { id: 899002, hasModel: true, models: [{ id: 9899021 }] }])).service.sync(shopId);
  const { data } = await db.from("channel_api_snapshots").select("entity_type, entity_external_id, api_name, source_mode, payload").eq("shop_id", shopId);
  assert.equal(data!.length, 3, "1 base-info per item + 1 model list");
  assert.ok(data!.every((s) => s.source_mode === "fixture"));
  const item = data!.find((s) => s.entity_external_id === "899001")!;
  assert.equal((item.payload as { price_info: Array<{ current_price: number }> }).price_info[0].current_price, 77000, "latest payload kept");
});

// ------------------------------------------------- isolation from internals

test("26 + 27. sync never writes Shopee prices into internal products or touches internal inventory", async () => {
  const shopId = await makeShop();
  const productId = await makeProduct(sku("iso"));
  const before = await db.from("products").select("sku, name, current_price::text, is_active, updated_at").eq("id", productId).single();
  const counts = async () =>
    Promise.all(["receipts", "receipt_items", "invoices", "invoice_items", "payments"].map(async (t) => (await db.from(t).select("id", { count: "exact", head: true })).count));
  const countsBefore = await counts();
  await syncer(buildFixtures([{ id: 899501, sku: sku("iso"), price: 999000, stock: 777 }])).service.sync(shopId);
  const afterRow = await db.from("products").select("sku, name, current_price::text, is_active, updated_at").eq("id", productId).single();
  assert.deepEqual(afterRow.data, before.data, "internal product row untouched (incl. current_price = 12345.00)");
  assert.deepEqual(await counts(), countsBefore, "no receipts/invoices/payments written");
});

// ------------------------------------------------------------- logging

test("28. sync log + state carry correct counts and safe metadata", async () => {
  const shopId = await makeShop();
  await makeProduct(sku("log1"));
  const result = await syncer(buildFixtures([{ id: 899701, sku: sku("log1") }, { id: 899702, hasModel: true, models: [{ id: 9897021 }, { id: 9897022 }] }])).service.sync(shopId);
  const { data: log } = await db.from("channel_sync_logs").select("*").eq("id", result.logId!).single();
  assert.equal(log!.status, "success");
  assert.equal(log!.sync_type, "product");
  assert.deepEqual([log!.records_fetched, log!.records_created, log!.records_updated, log!.records_failed], [2, 2 + 3, 0, 0]);
  assert.ok(log!.completed_at);
  const meta = log!.metadata as Record<string, unknown>;
  assert.deepEqual([meta.pagesFetched, meta.modelsFetched, meta.autoMapped, meta.unmapped, meta.conflicts, meta.sourceMode], [1, 2, 1, 2, 0, "fixture"]);
  assert.ok(!JSON.stringify(log).match(/access_token|refresh_token|partner_key/i));
  const { data: state } = await db.from("channel_sync_states").select("last_success_at, last_offset, last_error_code").eq("shop_id", shopId).eq("sync_type", "product").single();
  assert.ok(state!.last_success_at);
  assert.equal(state!.last_offset, 0);
  assert.equal(state!.last_error_code, null);
});

// ----------------------------------------------------------- permissions

test("25. permission matrix: admin syncs/auto-maps, staff maps, viewer read-only", () => {
  assert.equal(hasPermission("admin", "channel:manage"), true);
  assert.equal(hasPermission("staff", "channel:manage"), false);
  assert.equal(hasPermission("admin", "channel:map"), true);
  assert.equal(hasPermission("staff", "channel:map"), true);
  assert.equal(hasPermission("viewer", "channel:map"), false);
  assert.equal(hasPermission("viewer", "channel:view"), true);
});
