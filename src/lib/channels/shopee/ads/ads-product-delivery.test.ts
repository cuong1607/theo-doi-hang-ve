// ============================================================
// SHOPEE-ADS-3A.2.1 — product delivery optimisation, pure parts:
//
//   node --test src/lib/channels/shopee/ads/ads-product-delivery.test.ts
//
// 1. get_item_base_info snapshot fingerprint: request_id, item order and the
//    shipping-fee warning lines (all verified volatile on production) never
//    change the hash; every real product change does; the stored payload is
//    not touched.
// 2. display thumbnail: `_tn` derived only from the exact verified CDN shape;
//    load order thumbnail → original → icon, each tried once.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { payloadHash } from "../../core/snapshots.ts";
import { adsProductThumbnailUrl, adsThumbnailSources } from "./mapper.ts";
import { getAdsSyncConfig, normalizeShopeeProductSnapshotForHash } from "./sync.ts";

type Obj = Record<string, unknown>;
const item = (id: number, over: Obj = {}): Obj => ({
  item_id: id,
  item_name: `Item #${id}`,
  item_sku: id % 2 ? "" : `SKU-${id}`,
  item_status: "NORMAL",
  has_model: true,
  update_time: 1761700000 + id,
  image: { image_ratio: "1:1", image_id_list: [`vn-11134207-fixture-${id}`], image_url_list: [`https://cf.shopee.vn/file/vn-11134207-fixture-${id}`] },
  ...over,
});
const shipWarn = (channels: number[]) => channels.map((c) => `fail to get channel estimated_shipping_fee for channel [${c}];`).join("\n");
// production shape (request_id / warning / error / message / debug_message / response.item_list)
const envelope = (items: Obj[], over: Obj = {}): Obj => ({ request_id: "e3e3e7f35f044ace4deb37af5d2b0200", error: "", message: "", debug_message: "", warning: shipWarn([5000, 5001, 50012]), response: { item_list: items }, ...over });
const fp = (raw: unknown) => payloadHash(normalizeShopeeProductSnapshotForHash(raw));
const base = () => envelope([item(101), item(202), item(303)]);

test("7A. same payload, different request_id → same hash", () => {
  assert.equal(fp(base()), fp({ ...base(), request_id: "e3e3e7f35f044fe764a1a8326d1dfc00" }));
  assert.notEqual(payloadHash(base()), payloadHash({ ...base(), request_id: "x" }), "the raw hash (before 3A.2.1) did change — the bug");
});

test("6. same items in another order (verified on production) → same hash", () => {
  assert.equal(fp(base()), fp(envelope([item(303), item(101), item(202)])));
});

test("3. shipping-fee warning lines that vary between identical reads (verified) → same hash; any other warning line still counts", () => {
  assert.equal(fp(base()), fp({ ...base(), warning: shipWarn([5004, 50039, 5000]) }));
  assert.equal(fp(base()), fp({ ...base(), warning: "" }));
  assert.notEqual(fp(base()), fp({ ...base(), warning: `${shipWarn([5000])}\nitem 101 is banned` }), "an unknown warning is provider content");
});

test("7B–F + 5. every material product change → different hash", () => {
  const h = fp(base());
  const variant = (i: number, over: Obj) => envelope([item(101), item(202), item(303)].map((x, k) => (k === i ? { ...x, ...over } : x)));
  assert.notEqual(h, fp(variant(0, { item_name: "Item #101 (đổi tên)" })), "B. name");
  assert.notEqual(h, fp(variant(1, { item_sku: "SKU-NEW" })), "C. SKU");
  assert.notEqual(h, fp(variant(2, { item_status: "UNLIST" })), "D. status");
  assert.notEqual(h, fp(variant(0, { image: { image_ratio: "1:1", image_id_list: ["vn-x"], image_url_list: ["https://cf.shopee.vn/file/vn-x"] } })), "E. image");
  assert.notEqual(h, fp(envelope([item(101), item(303)])), "F. one item missing (returned item set)");
  assert.notEqual(h, fp(variant(0, { update_time: 1 })), "other provider content");
  assert.notEqual(h, fp({ ...base(), error: "error_param" }), "error envelope");
});

test("2. hash input only: the stored payload keeps request_id, warning and the provider order (normalisation never mutates its input)", () => {
  const raw = envelope([item(303), item(101)]);
  const copy = JSON.parse(JSON.stringify(raw));
  const n = normalizeShopeeProductSnapshotForHash(raw) as Obj;
  assert.deepEqual(raw, copy, "input untouched");
  assert.equal("request_id" in n, false);
  assert.deepEqual(((n.response as Obj).item_list as Obj[]).map((i) => i.item_id), [101, 303], "sorted by numeric item id");
  // ids of different length sort numerically, not lexicographically
  const m = normalizeShopeeProductSnapshotForHash(envelope([item(1009440430), item(458043512)])) as Obj;
  assert.deepEqual(((m.response as Obj).item_list as Obj[]).map((i) => i.item_id), [458043512, 1009440430]);
  assert.equal(normalizeShopeeProductSnapshotForHash(null), null);
  assert.deepEqual(normalizeShopeeProductSnapshotForHash([1]), [1]);
});

test("31. thumbnail URL: only the exact verified Shopee CDN shape gets `_tn`; everything else → null (= original)", () => {
  assert.equal(adsProductThumbnailUrl("https://cf.shopee.vn/file/vn-11134207-7ra0g-makrev953q9ted"), "https://cf.shopee.vn/file/vn-11134207-7ra0g-makrev953q9ted_tn");
  for (const bad of [
    "https://evil.example/file/vn-11134207-abc", // unknown host
    "https://cf.shopee.vn.evil.example/file/abc",
    "http://cf.shopee.vn/file/abc", // not https
    "https://cf.shopee.vn/file/abc?x=1", // query string
    "https://cf.shopee.vn/file/abc?Signature=s&Expires=1",
    "https://user:pw@cf.shopee.vn/file/abc", // credentials
    "https://cf.shopee.vn/other/abc", // unexpected path
    "https://cf.shopee.vn/file/abc/def",
    "https://cf.shopee.vn/file/abc_tn", // already a variant
    "https://cf.shopee.vn/file/",
    " https://cf.shopee.vn/file/abc",
    "not a url",
    "",
    null,
    undefined,
    42,
  ])
    assert.equal(adsProductThumbnailUrl(bad), null, String(bad));
});

test("18 / 31. load order: thumbnail → original → icon; each source once (no retry loop)", () => {
  const o = "https://cf.shopee.vn/file/abc";
  assert.deepEqual(adsThumbnailSources(`${o}_tn`, o), [`${o}_tn`, o], "thumbnail fails → original");
  assert.deepEqual(adsThumbnailSources(null, o), [o], "no thumbnail → original only");
  assert.deepEqual(adsThumbnailSources(o, o), [o], "never the same URL twice");
  assert.deepEqual(adsThumbnailSources(null, null), [], "original fails / missing → icon");
  assert.deepEqual(adsThumbnailSources("", "  "), []);
});

test("34. rollout flag ADS_PRODUCT_THUMBNAIL_TN_ENABLED defaults OFF", () => {
  assert.equal(getAdsSyncConfig({}).productThumbnailTnEnabled, false);
  assert.equal(getAdsSyncConfig({ ADS_PRODUCT_THUMBNAIL_TN_ENABLED: "true" }).productThumbnailTnEnabled, true);
});
