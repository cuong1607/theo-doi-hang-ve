// Run: node --test src/lib/channels/shopee/product-adapter.test.ts
// SHOPEE-2 adapter unit tests on the checked-in fixtures (no DB, no network).
import { test } from "node:test";
import assert from "node:assert/strict";

import { toDecimalString } from "../core/decimal.ts";
import { normalizeSku } from "../core/sku-mapping.ts";
import { deriveModelName, parseItemBaseInfo, parseItemListPage, parseModelList, ShopeePayloadError, syntheticModelFor } from "./product-adapter.ts";
import { loadProductFixtures } from "./product-provider.ts";
import { getShopeeProviderMode } from "./provider-mode.ts";

const fixtures = loadProductFixtures();

test("fixture files load: 2 item-list pages, base info, model lists", () => {
  assert.equal(fixtures.itemListPages.length, 2);
  assert.deepEqual(Object.keys(fixtures.modelLists).sort(), ["800000102", "800000105"]);
});

test("get_item_list page parsing: ids as strings, kit tag, paging fields", () => {
  const page1 = parseItemListPage(fixtures.itemListPages[0]);
  assert.deepEqual(page1.items.map((i) => i.externalItemId), ["800000101", "800000102", "800000103"]);
  assert.equal(page1.hasNextPage, true);
  assert.equal(page1.nextOffset, 3);
  assert.equal(page1.totalCount, 6);
  const page2 = parseItemListPage(fixtures.itemListPages[1]);
  assert.equal(page2.hasNextPage, false);
  assert.equal(page2.items.find((i) => i.externalItemId === "800000106")?.isKit, true);
  assert.equal(page2.items[0].updateTime, new Date(1760000300 * 1000).toISOString());
});

test("get_item_base_info mapping: price/stock as exact decimal strings, blank SKU → null", () => {
  const parsed = parseItemBaseInfo(fixtures.itemBaseInfo, { currency: "VND" });
  assert.equal(parsed.issues.length, 0);
  const a = parsed.products.find((p) => p.externalItemId === "800000101")!;
  assert.deepEqual(
    [a.itemName, a.itemSku, a.categoryId, a.itemStatus, a.hasModel, a.channelOriginalPrice, a.channelCurrentPrice, a.availableStock, a.reservedStock],
    ["Ga chống thấm 1m6x2m cao 10cm", "GA_CHONG_THAM_1M6X2MX10CM", "100636", "NORMAL", false, "59000", "45000", "120", "3"],
  );
  assert.equal(a.sourceUpdatedAt, new Date(1760000000 * 1000).toISOString());
  assert.equal(parsed.products.find((p) => p.externalItemId === "800000103")!.itemSku, null, "blank item_sku");
  const withModels = parsed.products.find((p) => p.externalItemId === "800000102")!;
  assert.equal(withModels.hasModel, true);
  assert.equal(withModels.channelCurrentPrice, null, "variation item: price lives on models");
});

test("synthetic NO_MODEL unit for a variation-less item carries item SKU/price/stock/dimensions", () => {
  const parsed = parseItemBaseInfo(fixtures.itemBaseInfo);
  const product = parsed.products.find((p) => p.externalItemId === "800000101")!;
  const unit = syntheticModelFor(product, parsed.rawByItemId.get("800000101"));
  assert.deepEqual(
    [unit.externalModelId, unit.isSynthetic, unit.modelSku, unit.channelCurrentPrice, unit.availableStock, unit.weight, unit.packageLength],
    ["NO_MODEL", true, "GA_CHONG_THAM_1M6X2MX10CM", "45000", "120", "0.350", "30"],
  );
});

test("get_model_list mapping: model ids, derived names, trimmed/blank SKUs", () => {
  const parsed = parseModelList(fixtures.modelLists["800000102"], { currency: "VND" });
  assert.equal(parsed.issues.length, 0);
  assert.deepEqual(parsed.models.map((m) => [m.externalModelId, m.modelName, m.modelSku, m.channelCurrentPrice, m.availableStock]), [
    ["9000001021", "1m6x2m", "bao_ve_dem_thuong_m6x2m", "90000", "40"],
    ["9000001022", "1m8x2m", "bao_ve_dem_thuong_m8x2m", "100000", "30"],
    ["9000001023", "2mx2m2", null, "115000", "20"],
  ]);
  assert.equal(parsed.models[0].isSynthetic, false);
  assert.equal(deriveModelName([0, 1], [{ name: "Màu", option_list: [{ option: "Xanh" }] }, { name: "Size", option_list: [{ option: "A" }, { option: "B" }] }]), "Xanh, B");
  assert.equal(deriveModelName([5], [{ name: "x", option_list: [] }]), null, "not derivable → null, never guessed");
});

test("malformed entries become issues; nothing without a valid identity is returned", () => {
  const page = parseItemListPage({ error: "", request_id: "r", response: { item: [{ item_id: "abc" }, { item_status: "NORMAL" }, { item_id: 0 }, { item_id: 42 }], has_next_page: false } });
  assert.deepEqual(page.items.map((i) => i.externalItemId), ["42"]);
  assert.equal(page.issues.length, 3);

  const base = parseItemBaseInfo({ error: "", response: { item_list: [{ item_id: 7, item_name: "ok", has_model: "yes" }, { item_id: 8 }, { item_id: 9, item_name: "fine" }] } });
  assert.deepEqual(base.products.map((p) => p.externalItemId), ["9"]);
  assert.deepEqual(base.issues.map((i) => i.externalId), ["7", "8"]);

  const models = parseModelList({ error: "", response: { model: [{ model_id: 1 }, { model_id: 1 }, { model_sku: "x" }] } });
  assert.equal(models.models.length, 1);
  assert.equal(models.issues.length, 2, "duplicate model_id + missing model_id");

  assert.throws(() => parseItemListPage({ error: "error_auth", message: "bad", response: null }), ShopeePayloadError);
  assert.throws(() => parseItemListPage("not an object"), ShopeePayloadError);
  assert.throws(() => parseItemListPage({ error: "", response: null }), ShopeePayloadError);
});

test("ids beyond JS safe-integer range are rejected, string ids preserved", () => {
  const page = parseItemListPage({ error: "", response: { item: [{ item_id: "123456789012345678" }, { item_id: "000123" }], has_next_page: false } });
  assert.deepEqual(page.items.map((i) => i.externalItemId), ["123"]);
  assert.equal(page.issues.length, 1);
});

test("decimal boundary: exact strings, no exponent / overflow / NaN", () => {
  assert.equal(toDecimalString(150000), "150000");
  assert.equal(toDecimalString(19.9), "19.9");
  assert.equal(toDecimalString("0.350"), "0.350");
  assert.equal(toDecimalString(1e21), null);
  assert.equal(toDecimalString(Number.NaN), null);
  assert.equal(toDecimalString("12abc"), null);
  assert.equal(toDecimalString(null), null);
});

test("SKU normalization is conservative: trim + case only", () => {
  assert.equal(normalizeSku("  ABC-1_x "), "abc-1_x");
  assert.equal(normalizeSku("A B"), "a b", "inner whitespace kept");
  assert.equal(normalizeSku("A-B"), "a-b", "symbols kept");
  assert.equal(normalizeSku("   "), null);
  assert.equal(normalizeSku(null), null);
});

test("provider mode: fixture by default outside production, live in production, no silent fixture in prod", () => {
  assert.deepEqual(getShopeeProviderMode({ NODE_ENV: "development" }), { mode: "fixture", fixtureAllowed: true, problem: null });
  assert.deepEqual(getShopeeProviderMode({ NODE_ENV: "production" }), { mode: "live", fixtureAllowed: false, problem: null });
  const blocked = getShopeeProviderMode({ NODE_ENV: "production", SHOPEE_PROVIDER_MODE: "fixture" });
  assert.equal(blocked.mode, "live");
  assert.ok(blocked.problem);
  assert.equal(getShopeeProviderMode({ NODE_ENV: "production", SHOPEE_PROVIDER_MODE: "fixture", ENABLE_SHOPEE_FIXTURE_MODE: "true" }).mode, "fixture");
  assert.equal(getShopeeProviderMode({ NODE_ENV: "development", SHOPEE_PROVIDER_MODE: "live" }).mode, "live");
  assert.ok(getShopeeProviderMode({ SHOPEE_PROVIDER_MODE: "mock" }).problem);
});
