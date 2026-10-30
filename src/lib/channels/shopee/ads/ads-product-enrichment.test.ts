// ============================================================
// SHOPEE-ADS-3A.2 — product enrichment, pure parts:
//
//   node --test src/lib/channels/shopee/ads/ads-product-enrichment.test.ts
//
// source verification against the sanitized PRODUCTION fixture
// (get_item_base_info), mapper field-by-field, image URL safety, request
// limits, read-only policy for the one product read, snapshot projection,
// priority / lane, search over product fields, placeholder.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { queryCampaigns } from "./filters.ts";
import { parseItemBaseInfo, safeShopeeImageUrl } from "./mapper.ts";
import { ADS_FIXTURE_DIR, ADS_ITEM_BATCH, assertVerifiedAdsRequest, FixtureShopeeAdsProvider, loadAdsFixtures } from "./provider.ts";
import { ADS_PRODUCT_READ_ENDPOINTS, ADS_READ_ENDPOINTS, AdsWriteForbiddenError, assertAdsReadOnlyRequest, isAdsReadJobType, isAdsReadOnlyPath, isAdsReadOnlyRequest } from "./read-only-policy.ts";
import { adsProductPlaceholder } from "./real-source.ts";
import { ADS_PRIORITY, adsLaneFor, adsProductStaleBefore, getAdsSyncConfig, projectItemBaseInfo } from "./sync.ts";
import type { AdsCampaignRow } from "./view-models.ts";

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(path.join(ADS_FIXTURE_DIR, "item-base-info.json"), "utf8")) as { _meta: Obj; response: { response: { item_list: Obj[] } } };
const items = fixture.response.response.item_list;
const ids = items.map((i) => String(i.item_id));
const ctx = { shopId: "s", externalShopId: "1" };

test("61. source: the fixture is a sanitized projection of real get_item_base_info answers (GET, production, verified field set)", () => {
  assert.equal(fixture._meta.endpoint, "/api/v2/product/get_item_base_info");
  assert.equal(fixture._meta.method, "GET");
  assert.equal(fixture._meta.environment, "production");
  // every field ADS-3A.2 persists was observed in the real payload
  for (const k of ["item_id", "item_name", "item_sku", "item_status", "image"]) assert.ok((fixture._meta.observed_item_keys as string[]).includes(k), k);
  assert.equal(items.length, 101, "one entry per Ads-referenced item of the ADS-1A shop");
  assert.deepEqual([...new Set(items.map((i) => i.item_status))].sort(), ["NORMAL", "SELLER_DELETE", "UNLIST"], "statuses as seen in production");
  for (const i of items) {
    assert.match(String(i.item_name), /^Item #\d+$/, "names are placeholders");
    const img = i.image as { image_url_list: string[]; image_id_list: string[] };
    assert.equal(img.image_url_list[0], `https://cf.shopee.vn/file/${img.image_id_list[0]}`, "verified stable URL shape: host + /file/<image_id>, no query");
  }
});

test("62. mapper: every canonical field mapped, unknown / missing → safe null, unrequested items ignored, absent ids reported (never as deletions)", () => {
  const requested = ids.slice(0, 50);
  const parsed = parseItemBaseInfo(fixture.response, requested);
  assert.equal(parsed.items.length, 50);
  assert.deepEqual(parsed.notReturned, []);
  const first = parsed.items[0];
  const raw = items[0] as Obj & { image: { image_url_list: string[] } };
  assert.deepEqual(first, { providerItemId: String(raw.item_id), productName: raw.item_name, imageUrl: raw.image.image_url_list[0], itemSku: raw.item_sku ? raw.item_sku : null, providerStatus: raw.item_status });
  assert.ok(parsed.items.some((i) => i.itemSku !== null) && parsed.items.some((i) => i.itemSku === null), "empty item_sku → null (never invented)");

  const odd = parseItemBaseInfo(
    { response: { item_list: [{ item_id: 1, item_name: "  ", item_sku: "", item_status: "SOMETHING_NEW", image: { image_url_list: ["https://evil.example/file/x"] } }, { item_id: 2 }, { item_id: 99 }, "junk", { item_id: "abc" }] } },
    ["1", "2", "3"],
  );
  assert.deepEqual(odd.items, [
    { providerItemId: "1", productName: null, imageUrl: null, itemSku: null, providerStatus: "SOMETHING_NEW" },
    { providerItemId: "2", productName: null, imageUrl: null, itemSku: null, providerStatus: null },
  ]);
  assert.deepEqual(odd.notReturned, ["3"], "requested but absent");
  assert.equal(odd.imagesRejected, 1, "a non-allowlisted image host is not stored");
  assert.equal(odd.failures.length, 2, "junk entries never fail the batch");
  assert.throws(() => parseItemBaseInfo({ error: "", response: null }, ["1"]), /không có response/);
  assert.deepEqual(parseItemBaseInfo({ error: "", response: {} }, ["1"]).notReturned, ["1"], "empty answer: nothing returned, nothing invented");
});

test("33 / 35. image URL safety: only https cf.shopee.vn/file/<id> without query or fragment is persisted", () => {
  assert.equal(safeShopeeImageUrl("https://cf.shopee.vn/file/vn-11134207-7r98o-abc_DEF"), "https://cf.shopee.vn/file/vn-11134207-7r98o-abc_DEF");
  for (const bad of [
    "http://cf.shopee.vn/file/abc",
    "https://cf.shopee.vn/file/abc?sig=1&exp=2",
    "https://cf.shopee.vn/file/abc#x",
    "https://cf.shopee.vn.evil.com/file/abc",
    "https://down-vn.img.susercontent.com/file/abc",
    "https://cf.shopee.vn/other/abc",
    "javascript:alert(1)",
    "",
    null,
    42,
  ]) assert.equal(safeShopeeImageUrl(bad), null, String(bad));
});

test("13. batching: ≤ 50 distinct numeric item ids per call, refused before any call otherwise", async () => {
  assert.equal(ADS_ITEM_BATCH, 50);
  assert.doesNotThrow(() => assertVerifiedAdsRequest("item_ids", { ids: ids.slice(0, 50) }));
  assert.throws(() => assertVerifiedAdsRequest("item_ids", { ids: ids.slice(0, 51) }), /1…50/);
  assert.throws(() => assertVerifiedAdsRequest("item_ids", { ids: [] }), /1…50/);
  assert.throws(() => assertVerifiedAdsRequest("item_ids", { ids: ["1", "1"] }), /khác nhau/);
  assert.throws(() => assertVerifiedAdsRequest("item_ids", { ids: ["1,2"] }), /item id không hợp lệ/);
  const p = new FixtureShopeeAdsProvider(loadAdsFixtures());
  await assert.rejects(() => p.getItemBaseInfo(ctx, { itemIds: ids.slice(0, 51) }), /1…50/);
  const r = await p.getItemBaseInfo(ctx, { itemIds: [ids[0], "123456"] });
  assert.equal(r.apiName, "/api/v2/product/get_item_base_info");
  assert.deepEqual(((r.raw as { response: { item_list: Obj[] } }).response.item_list).map((i) => String(i.item_id)), [ids[0]], "unknown ids are simply absent, like the real API");
});

test("0 / 3 / 14 / 60. read-only policy: exactly ONE product path is readable from Ads code — GET only; catalogue scans and every product write are refused", () => {
  assert.deepEqual(Object.values(ADS_PRODUCT_READ_ENDPOINTS), ["/api/v2/product/get_item_base_info"]);
  assert.ok(isAdsReadOnlyRequest("GET", "/api/v2/product/get_item_base_info"));
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(isAdsReadOnlyRequest(m, "/api/v2/product/get_item_base_info"), false, m);
  for (const p of [
    "/api/v2/product/get_item_list", // full catalogue scan — not allowed
    "/api/v2/product/get_model_list",
    "/api/v2/product/update_item",
    "/api/v2/product/add_item",
    "/api/v2/product/delete_item",
    "/api/v2/product/unlist_item",
    "/api/v2/product/update_price",
    "/api/v2/product/update_stock",
    "/api/v2/product/get_item_base_info?x=1",
    "/api/v2/product/GET_ITEM_BASE_INFO",
  ]) {
    assert.equal(isAdsReadOnlyPath(p), false, p);
    assert.throws(() => assertAdsReadOnlyRequest("GET", p), AdsWriteForbiddenError, p);
  }
  assert.ok(!(Object.values(ADS_READ_ENDPOINTS) as string[]).includes("/api/v2/product/get_item_base_info"), "not part of the Ads probe allowlist");
  assert.ok(isAdsReadJobType("ads_product_enrichment_read"));
});

test("32. snapshot = projection of the raw envelope (no description / attributes / logistics), envelope fields kept", () => {
  const raw = { request_id: "r", error: "", warning: "w", response: { item_list: [{ item_id: 1, item_name: "n", description: "long text", attribute_list: [1], logistic_info: [2], image: { image_url_list: ["u"] }, item_status: "NORMAL" }] } };
  assert.deepEqual(projectItemBaseInfo(raw), { request_id: "r", error: "", warning: "w", response: { item_list: [{ item_id: 1, item_name: "n", image: { image_url_list: ["u"] }, item_status: "NORMAL" }] } });
  assert.equal(projectItemBaseInfo("x"), "x");
  assert.deepEqual(projectItemBaseInfo({ error: "e" }), { error: "e" });
});

test("16 / 18. priority below every performance read, metadata lane, TTL default 24 h, flag default OFF", () => {
  const perf = [ADS_PRIORITY.manual, ADS_PRIORITY.hotShop, ADS_PRIORITY.hotCampaign, ADS_PRIORITY.hotShopHourly, ADS_PRIORITY.hotCampaignHourly, ADS_PRIORITY.warm, ADS_PRIORITY.metadata, ADS_PRIORITY.cold, ADS_PRIORITY.hourlyFinalize];
  for (const p of perf) assert.ok(ADS_PRIORITY.productEnrichment > p, `enrichment ${ADS_PRIORITY.productEnrichment} must rank after ${p}`);
  assert.ok(ADS_PRIORITY.productEnrichment < ADS_PRIORITY.backfill, "only the first backfill ranks lower");
  assert.equal(adsLaneFor("ads_product_enrichment_read", "enrichment"), "ads_meta");
  assert.equal(adsLaneFor("ads_product_enrichment_read", "manual"), "ads_meta", "never in the HOT lane, even from the refresh button");
  const cfg = getAdsSyncConfig({});
  assert.equal(cfg.productEnrichmentEnabled, false);
  assert.equal(cfg.productEnrichmentTtlHours, 24);
  assert.equal(getAdsSyncConfig({ ADS_PRODUCT_ENRICHMENT_TTL_HOURS: "72", ADS_PRODUCT_ENRICHMENT_ENABLED: "true" }).productEnrichmentTtlHours, 72);
  assert.equal(getAdsSyncConfig({ ADS_PRODUCT_ENRICHMENT_TTL_HOURS: "0" }).productEnrichmentTtlHours, 24, "invalid → default");
  assert.equal(adsProductStaleBefore(new Date("2026-10-29T12:00:00Z"), { productEnrichmentTtlHours: 24 }), "2026-10-28T12:00:00.000Z");
});

function row(over: Partial<AdsCampaignRow>): AdsCampaignRow {
  return {
    id: "c1",
    name: "Chăn ga cotton",
    shopId: "s1",
    shopName: "CTV",
    type: "auto",
    status: "active",
    dailyBudget: null,
    periodBudget: null,
    metrics: { spend: 1, revenue: 0, orders: 0, roas: null, acos: null, ctr: null, cpc: null, impressions: 1, clicks: 0, conversionRate: null, directRevenue: 0, directOrders: 0, directRoas: null } as unknown as AdsCampaignRow["metrics"],
    trend: [],
    topProducts: [],
    ...over,
  };
}

test("28 / 74. search: campaign name, product name, SKU and provider item id — accent-insensitive; existing campaign search unchanged", () => {
  const rows = [
    row({ id: "a", name: "Chiến dịch A", topProducts: [{ name: "Thảm lông cừu Đà Lạt", itemId: "22334455667", sku: "TL-01", spend: null, revenue: null, orders: null, enrichment: "enriched" }] }),
    row({ id: "b", name: "Chăn hè", topProducts: [{ name: adsProductPlaceholder("99887766"), itemId: "99887766", spend: null, revenue: null, orders: null, enrichment: "pending" }] }),
  ];
  const q = (text: string) => queryCampaigns(rows, { q: text, sort: "spend", desc: true, page: 1, size: 25 } as Parameters<typeof queryCampaigns>[1]).rows.map((r) => r.id);
  assert.deepEqual(q("tham long cuu da lat"), ["a"], "product name, accents folded");
  assert.deepEqual(q("tl-01"), ["a"], "SKU");
  assert.deepEqual(q("22334455667"), ["a"], "provider item id");
  assert.deepEqual(q("99887766"), ["b"], "item id of a not-yet-enriched product");
  assert.deepEqual(q("chan he"), ["b"], "campaign name search still works");
  assert.equal(q("ctv").length, 2, "shop name");
});

test("23 / 54. placeholder is neutral and never blank", () => {
  assert.equal(adsProductPlaceholder("123"), "Sản phẩm Shopee #123");
  assert.doesNotMatch(adsProductPlaceholder("123"), /lỗi|error/i);
});
