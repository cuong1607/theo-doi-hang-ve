// SHOPEE-PRODUCT-ANALYTICS-1 — discovery: read-only allowlist, no mutation,
// request budget, sanitizer, field inventory, cross-source comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  assertProductAnalyticsReadRequest,
  isProductAnalyticsReadRequest,
  PRODUCT_ANALYTICS_APPROVED_POST_READS,
  PRODUCT_ANALYTICS_CONTROL_PATH,
  PRODUCT_ANALYTICS_DISCOVERY_CANDIDATES,
  PRODUCT_ANALYTICS_DISCOVERY_MAX_REQUESTS,
  PRODUCT_ANALYTICS_READ_ENDPOINTS,
  ProductAnalyticsWriteForbiddenError,
} from "./read-only-policy.ts";
import { buildItemComparisons, classifyDiscoveryResponse, DiscoveryGuardError, inventoryFields, runProductAnalyticsDiscovery, sanitizeDiscoveryReport, type DiscoveryTransportRequest } from "./discovery.ts";

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const okBody = (ids: number[]) => JSON.stringify({ error: "", message: "", warning: "", request_id: "r1", response: { item_list: ids.map((id) => ({ item_id: id, sale: 120, views: 5400, likes: 33, rating_star: 4.8, comment_count: 41 })) } });

test("PA-1 / 60: allowlist = GET only, exact verified paths, mutation endpoints refused", () => {
  assert.deepEqual(Object.values(PRODUCT_ANALYTICS_READ_ENDPOINTS), ["/api/v2/product/get_item_extra_info"]);
  for (const c of PRODUCT_ANALYTICS_DISCOVERY_CANDIDATES) {
    assert.equal(c.method, "GET");
    assert.ok(c.evidence.length > 10, "every candidate carries its evidence");
    assert.equal(isProductAnalyticsReadRequest("GET", c.path), true);
    assert.equal(isProductAnalyticsReadRequest("POST", c.path), false, "POST read needs a separate review");
  }
  assert.deepEqual(PRODUCT_ANALYTICS_APPROVED_POST_READS, [], "no POST read approved");
  for (const p of [
    "/api/v2/product/update_item", "/api/v2/product/update_price", "/api/v2/product/update_stock", "/api/v2/product/unlist_item",
    "/api/v2/product/delete_item", "/api/v2/product/add_item", "/api/v2/product/get_item_list", "/api/v2/product/get_model_list",
    "/api/v2/ads/edit_manual_product_ads", "/api/v2/product/get_item_extra_info/", "/api/v2/product/get_item_extra_info?x=1",
    "/api/v2/product/get_some_guessed_report",
  ]) {
    assert.equal(isProductAnalyticsReadRequest("GET", p), false, p);
    assert.throws(() => assertProductAnalyticsReadRequest("GET", p), ProductAnalyticsWriteForbiddenError);
  }
});

test("PA-1 / 60: plan limits — ≤ 10 items, numeric ids, ≤ 12 requests", async () => {
  const transport = async () => ({ httpStatus: 200, latencyMs: 1, text: okBody([1]) });
  const many = Array.from({ length: 11 }, (_, i) => String(1000 + i));
  await assert.rejects(runProductAnalyticsDiscovery({ plan: [{ shopKey: "s", shopLabel: "S", itemIds: many }], transport, sleep: async () => {} }), DiscoveryGuardError);
  await assert.rejects(runProductAnalyticsDiscovery({ plan: [{ shopKey: "s", shopLabel: "S", itemIds: ["12a"] }], transport, sleep: async () => {} }), DiscoveryGuardError);
  await assert.rejects(runProductAnalyticsDiscovery({ plan: [{ shopKey: "s", shopLabel: "S", itemIds: [] }], transport, sleep: async () => {} }), DiscoveryGuardError);
  const tooManyShops = Array.from({ length: 12 }, (_, i) => ({ shopKey: `s${i}`, shopLabel: `S${i}`, itemIds: [] as string[] }));
  tooManyShops[0].itemIds.push("1");
  await assert.rejects(runProductAnalyticsDiscovery({ plan: tooManyShops, transport, sleep: async () => {} }), /ngân sách/);
  assert.equal(PRODUCT_ANALYTICS_DISCOVERY_MAX_REQUESTS, 12);
});

test("PA-1: runner — control first, GET only, 1 call per shop, gap between calls, item ids comma-joined", async () => {
  const calls: DiscoveryTransportRequest[] = [];
  const sleeps: number[] = [];
  const report = await runProductAnalyticsDiscovery({
    plan: [
      { shopKey: "a", shopLabel: "A", itemIds: ["11", "12"] },
      { shopKey: "b", shopLabel: "B", itemIds: ["21"] },
    ],
    transport: async (req) => {
      calls.push(req);
      if (req.path === PRODUCT_ANALYTICS_CONTROL_PATH) return { httpStatus: 404, latencyMs: 1, text: JSON.stringify({ error: "error_not_found", message: "not found" }) };
      return { httpStatus: 200, latencyMs: 2, text: okBody(req.params.item_id_list.toString().split(",").map(Number)) };
    },
    sleep: async (ms) => void sleeps.push(ms),
  });
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.shopKey]), [
    ["GET", PRODUCT_ANALYTICS_CONTROL_PATH, "a"],
    ["GET", "/api/v2/product/get_item_extra_info", "a"],
    ["GET", "/api/v2/product/get_item_extra_info", "b"],
  ]);
  assert.equal(calls[1].params.item_id_list, "11,12");
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.equal(report.requestsUsed, 3);
  assert.deepEqual(report.calls.map((c) => c.classification), ["ENDPOINT_NOT_FOUND", "OK", "OK"]);
  assert.deepEqual(report.calls[1].returnedItemIds, ["11", "12"]);
});

test("PA-1: classification of provider answers", () => {
  assert.equal(classifyDiscoveryResponse({ httpStatus: 404, latencyMs: 1, text: '{"error":"error_not_found"}' }).classification, "ENDPOINT_NOT_FOUND");
  assert.equal(classifyDiscoveryResponse({ httpStatus: 403, latencyMs: 1, text: '{"error":"error_permission","message":"no"}' }).classification, "PERMISSION_DENIED");
  assert.equal(classifyDiscoveryResponse({ httpStatus: 200, latencyMs: 1, text: '{"error":"error_param","message":"item_id_list"}' }).classification, "PARAM_ERROR");
  assert.equal(classifyDiscoveryResponse({ httpStatus: 500, latencyMs: 1, text: "oops" }).classification, "PROVIDER_ERROR");
  assert.equal(classifyDiscoveryResponse({ httpStatus: null, latencyMs: 1, text: "", transportError: { code: "network_error", message: "x" } }).classification, "TRANSPORT_ERROR");
  assert.equal(classifyDiscoveryResponse({ httpStatus: 200, latencyMs: 1, text: okBody([1]) }).classification, "OK");
});

test("PA-1 / 13 / 25: field inventory + sanitizer (ids → stable placeholders, metrics kept, no secrets)", async () => {
  const report = await runProductAnalyticsDiscovery({
    plan: [{ shopKey: "a", shopLabel: "A", itemIds: ["24740290518", "41630539392"] }],
    includeControl: false,
    transport: async () => ({ httpStatus: 200, latencyMs: 1, text: okBody([24740290518, 41630539392]) }),
    sleep: async () => {},
  });
  const comparisons = buildItemComparisons(["24740290518", "41630539392", "999"], report.calls[0].body, new Map([["24740290518", { ordersInDb: 3, unitsInDb: 4, firstOrderAt: "2026-10-16T00:00:00Z", units7d: 2, orders7d: 2 }]]), new Map());
  assert.equal(comparisons[2].returned, false, "a requested item the provider omits is visible");
  assert.equal(comparisons[0].provider?.views, 5400);
  const { fixtures, secretFindings } = sanitizeDiscoveryReport(report, ["partner-key-xyz"], { comparisons, suffix: "t" });
  assert.deepEqual(secretFindings, []);
  const text = JSON.stringify(fixtures);
  assert.ok(!text.includes("24740290518") && !text.includes("41630539392"), "real item ids never reach a fixture");
  const body = (fixtures[0].content as { body: { response: { item_list: Array<{ item_id: number; views: number }> } } }).body;
  const cmp = (fixtures[1].content as { rows: Array<{ item_id: string }> }).rows;
  assert.equal(String(body.response.item_list[0].item_id), cmp[0].item_id, "same placeholder in payload and comparison");
  assert.equal(body.response.item_list[0].views, 5400, "metrics untouched");

  const fields = inventoryFields([report.calls[0].body], [body]);
  const views = fields.find((f) => f.path === "response.item_list[].views")!;
  assert.deepEqual(views.types, ["number"]);
  assert.equal(views.nullable, false);
  assert.equal(fields.find((f) => f.path === "response.item_list[].item_id")!.example, body.response.item_list[0].item_id, "examples come from the sanitized copy");
});

test("PA-1 / 25: saved fixtures — own namespace, sanitized shape, secret-free", () => {
  const dir = path.join(DIR, "__fixtures__", "provider");
  const files = readdirSync(dir);
  assert.ok(files.includes("sandbox-item-extra-info.json"));
  for (const f of files) {
    const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    assert.ok(j._meta?.note, `${f} carries a _meta note`);
    assert.ok(!/access_token|partner_key|"sign"/.test(JSON.stringify(j)), `${f} has no credential`);
  }
  const extra = JSON.parse(readFileSync(path.join(dir, "sandbox-item-extra-info.json"), "utf8"));
  assert.equal(extra._meta.classification, "OK");
  const item = extra.body.response.item_list[0];
  assert.deepEqual(Object.keys(item).sort(), ["comment_count", "item_id", "likes", "rating_star", "sale", "views"]);
});

test("PA-1 / 60: static guard — product-analytics code references no write endpoint and no other product path", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const f of files) {
    const src = readFileSync(path.join(DIR, f), "utf8");
    const paths = src.match(/\/api\/v2\/[a-z_]+\/[a-z_]+/g) ?? [];
    // PA-2: + exactly the two verified order READS of the isolated product sales reader (PRODUCT_SALES_READ_ENDPOINTS)
    const allowed = new Set(["/api/v2/product/get_item_extra_info", PRODUCT_ANALYTICS_CONTROL_PATH, "/api/v2/order/get_order_list", "/api/v2/order/get_order_detail"]);
    for (const p of paths) assert.ok(allowed.has(p), `${f}: ${p}`);
    assert.doesNotMatch(src, /method:\s*"POST"/, `${f} never POSTs`);
  }
});
