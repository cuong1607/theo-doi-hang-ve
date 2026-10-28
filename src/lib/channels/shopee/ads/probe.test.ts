// ============================================================
// SHOPEE-ADS-1A — production read-only Ads probe guards (pure, no network):
//   node --test src/lib/channels/shopee/ads/probe.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ADS_PROBE_ENDPOINTS,
  ADS_PROBE_MAX_REQUESTS,
  adsProbeDate,
  adsProbeFixtures,
  AdsProbeGuardError,
  assertAdsProbeRequest,
  classifyAdsProbeResponse,
  runAdsProbe,
  type AdsProbeTransport,
  type AdsProbeTransportRequest,
} from "./probe.ts";
import { createAdsFixtureSanitizer, findFixtureSecrets } from "./sanitize.ts";

const NOW = new Date("2026-10-28T07:30:00Z"); // 14:30 in Vietnam
const noSleep = async () => {};

let rq = 0;
function okJson(response: unknown) {
  return { httpStatus: 200, latencyMs: 120, text: JSON.stringify({ request_id: `rq-${++rq}`, error: "", message: "", response }) };
}

/** Transport stub: records every request, answers by endpoint. */
function stub(answer: (r: AdsProbeTransportRequest) => { httpStatus: number | null; latencyMs: number; text: string }) {
  const seen: AdsProbeTransportRequest[] = [];
  const transport: AdsProbeTransport = async (r) => {
    seen.push(r);
    return answer(r);
  };
  return { seen, transport };
}

const HAPPY: Record<string, unknown> = {
  shop_toggle_info: { data: { auto_top_up: false, campaign_surge: true } },
  total_balance: { data_timestamp: 1, total_balance: 123456.78 },
  campaign_id_list: { has_next_page: false, campaign_list: [{ ad_type: "manual", campaign_id: 111 }, { ad_type: "auto", campaign_id: 222 }] },
  campaign_setting_info: { campaign_list: [{ campaign_id: 111, common_info: { ad_name: "Ga chống thấm SALE", campaign_status: "ongoing" } }] },
  shop_daily_performance: [{ date: "27-10-2026", impression: 100, clicks: 5, expense: 1234.5, broad_gmv: 9000, broad_order: 2 }],
  campaign_daily_performance: { campaign_list: [{ campaign_id: 222, metrics_list: [{ date: "27-10-2026", expense: 10 }] }] },
  shop_hourly_performance: [{ hour: 0, expense: 1 }],
  campaign_hourly_performance: { campaign_list: [] },
  recommended_item_list: [{ item_id: 333, item_name: "Nệm topper" }],
};

test("guard: mutation methods are rejected (fail closed)", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "get"]) {
    assert.throws(() => assertAdsProbeRequest(m, ADS_PROBE_ENDPOINTS.total_balance), AdsProbeGuardError, m);
  }
  assert.doesNotThrow(() => assertAdsProbeRequest("GET", ADS_PROBE_ENDPOINTS.total_balance));
});

test("guard: non-Ads, mutation-named and non-allowlisted Ads paths are rejected", () => {
  for (const p of [
    "/api/v2/product/get_item_list",
    "/api/v2/shop/get_shop_info",
    "/api/v2/ads/create_manual_product_ads",
    "/api/v2/ads/edit_manual_product_ads",
    "/api/v2/ads/edit_manual_product_ad_keywords",
    "/api/v2/ads/get_some_other_report",
    "/api/v2/ads/get_total_balance?x=1",
    "/api/v2/ads/get_total_balance/",
  ]) {
    assert.throws(() => assertAdsProbeRequest("GET", p), AdsProbeGuardError, p);
  }
  // every allowlisted path is a read ("get_") endpoint
  for (const p of Object.values(ADS_PROBE_ENDPOINTS)) assert.match(p, /^\/api\/v2\/ads\/get_[a-z_]+$/);
});

test("production needs an explicit confirmation", async () => {
  const { seen, transport } = stub(() => okJson({}));
  await assert.rejects(runAdsProbe({ environment: "production", shopLabel: "s", transport, sleep: noSleep }), AdsProbeGuardError);
  await assert.rejects(runAdsProbe({ environment: "production", confirmProduction: false, shopLabel: "s", transport, sleep: noSleep }), AdsProbeGuardError);
  assert.equal(seen.length, 0, "no request before confirmation");
});

test("happy path: order, chaining real ids, only GET + allowlisted, stability + today", async () => {
  const { seen, transport } = stub((r) => okJson(HAPPY[r.endpoint]));
  const report = await runAdsProbe({ environment: "production", confirmProduction: true, shopLabel: "Pilot", transport, now: NOW, sleep: noSleep });
  assert.equal(report.stoppedReason, "completed");
  assert.equal(report.adsAccess, "AVAILABLE");
  assert.ok(report.requestsUsed <= ADS_PROBE_MAX_REQUESTS);
  assert.deepEqual(
    seen.map((r) => r.endpoint),
    [
      "shop_toggle_info",
      "total_balance",
      "campaign_id_list",
      "campaign_setting_info",
      "shop_daily_performance",
      "campaign_daily_performance",
      "shop_daily_performance",
      "shop_daily_performance",
      "shop_hourly_performance",
      "campaign_hourly_performance",
      "shop_daily_performance",
      "recommended_item_list",
    ],
  );
  for (const r of seen) {
    assert.equal(r.method, "GET");
    assert.equal(r.path, ADS_PROBE_ENDPOINTS[r.endpoint]);
  }
  // REAL ids went to the provider …
  assert.equal(seen[3].params.campaign_id_list, "111,222");
  // … masked ids in the report, consistent with the masked bodies
  const settingCall = report.calls[3];
  assert.equal(settingCall.params.campaign_id_list, `${report.calls[2].body && (report.calls[2].body as { response: { campaign_list: Array<{ campaign_id: number }> } }).response.campaign_list[0].campaign_id},${(report.calls[2].body as { response: { campaign_list: Array<{ campaign_id: number }> } }).response.campaign_list[1].campaign_id}`);
  assert.doesNotMatch(JSON.stringify(report), /"111"|\b111\b|Ga chống thấm|Nệm topper/);
  // dates: yesterday / 3 days ago / today in Vietnam
  assert.deepEqual(report.dates, { today: "28-10-2026", yesterday: "27-10-2026", threeDaysAgo: "25-10-2026" });
  assert.deepEqual(seen[4].params, { start_date: "27-10-2026", end_date: "27-10-2026" });
  // same completed day twice → stability evidence (request_id ignored)
  assert.equal(report.calls[7].identicalTo, 5);
  // shape evidence
  assert.equal(report.calls[2].paginationHints.has_next_page, false);
  assert.equal(report.calls[2].arrayLengths.campaign_list, 2);
  assert.deepEqual(report.calls[1].responseKeys, ["data_timestamp", "total_balance"]);
  // money untouched
  assert.equal((report.calls[1].body as { response: { total_balance: number } }).response.total_balance, 123456.78);
  // fixtures: one per successful call, unique names
  const fixtures = adsProbeFixtures(report);
  assert.equal(fixtures.length, 12);
  assert.equal(new Set(fixtures.map((f) => f.name)).size, 12);
  assert.ok(fixtures.some((f) => f.name === "shop-daily-performance-4"));
});

test("request budget is enforced (and can never exceed the hard ceiling)", async () => {
  const a = stub((r) => okJson(HAPPY[r.endpoint]));
  const small = await runAdsProbe({ environment: "sandbox", shopLabel: "s", transport: a.transport, sleep: noSleep, maxRequests: 3 });
  assert.equal(a.seen.length, 3);
  assert.equal(small.requestsUsed, 3);
  assert.equal(small.stoppedReason, "budget");
  const b = stub((r) => okJson(HAPPY[r.endpoint]));
  const big = await runAdsProbe({ environment: "sandbox", shopLabel: "s", transport: b.transport, sleep: noSleep, maxRequests: 10_000 });
  assert.equal(big.requestBudget, ADS_PROBE_MAX_REQUESTS);
  assert.ok(b.seen.length <= ADS_PROBE_MAX_REQUESTS);
});

test("circuit breaker: repeated 5xx / unavailable stops the survey early", async () => {
  const { seen, transport } = stub(() => ({ httpStatus: 503, latencyMs: 60, text: '"ERROR_SP_SERVICE_NOT_FOUND"' }));
  const report = await runAdsProbe({ environment: "sandbox", shopLabel: "s", transport, sleep: noSleep });
  assert.equal(seen.length, 3);
  assert.equal(report.stoppedReason, "circuit_breaker");
  assert.equal(report.adsAccess, "ENDPOINT_UNAVAILABLE");
});

test("auth errors twice stop the run (no hammering with a bad token)", async () => {
  const { seen, transport } = stub(() => ({ httpStatus: 403, latencyMs: 50, text: JSON.stringify({ error: "invalid_access_token", message: "Invalid access_token.", request_id: "x" }) }));
  const report = await runAdsProbe({ environment: "sandbox", shopLabel: "s", transport, sleep: noSleep });
  assert.equal(seen.length, 2);
  assert.equal(report.stoppedReason, "reauth_required");
  assert.equal(report.calls[0].classification, "REAUTH_REQUIRED");
});

test("permission denied on availability is recorded with the exact provider error, run continues to the account call", async () => {
  const { seen, transport } = stub(() => ({ httpStatus: 403, latencyMs: 50, text: JSON.stringify({ error: "error_permission", message: "No permission to access ads.", request_id: "x" }) }));
  const report = await runAdsProbe({ environment: "sandbox", shopLabel: "s", transport, sleep: noSleep });
  assert.equal(report.adsAccess, "PERMISSION_DENIED");
  assert.equal(report.calls[0].errorCode, "error_permission");
  assert.equal(report.calls[0].message, "No permission to access ads.");
  assert.equal(report.calls[0].httpStatus, 403);
  assert.ok(seen.length >= 2);
});

test("transport failures (token) are classified, never thrown past the runner", async () => {
  const transport: AdsProbeTransport = async () => ({ httpStatus: null, latencyMs: 0, text: "", transportError: { code: "reauth_required", message: "Shop cần kết nối lại.", reauth: true } });
  const report = await runAdsProbe({ environment: "sandbox", shopLabel: "s", transport, sleep: noSleep });
  assert.equal(report.calls[0].classification, "REAUTH_REQUIRED");
  assert.equal(report.stoppedReason, "reauth_required");
});

test("classification: every outcome is distinct (not collapsed)", () => {
  const c = (httpStatus: number | null, errorCode: string | null, message: string | null, rawText = "", json = true) => classifyAdsProbeResponse({ httpStatus, errorCode, message, rawText, json });
  assert.equal(c(200, null, null), "AVAILABLE");
  assert.equal(c(503, "http_503", null, '"ERROR_SP_SERVICE_NOT_FOUND"', false), "ENDPOINT_UNAVAILABLE");
  assert.equal(c(404, "error_not_found", null), "ENDPOINT_UNAVAILABLE");
  assert.equal(c(403, "error_auth", "Invalid access_token."), "REAUTH_REQUIRED");
  assert.equal(c(403, "error_permission", "no permission"), "PERMISSION_DENIED");
  assert.equal(c(200, "ads.shop_not_eligible", "shop is not in whitelist"), "SHOP_NOT_ELIGIBLE");
  assert.equal(c(400, "error_param", "start_date format invalid"), "PARAM_ERROR");
  assert.equal(c(500, "error_server", "busy"), "PROVIDER_ERROR");
  assert.equal(c(429, "http_429", null), "PROVIDER_ERROR");
  assert.equal(c(418, "something_new", "?"), "UNKNOWN");
});

test("sanitizer: credentials / headers / cookies / signature / shop ids removed; names + ids stably masked; metrics kept", () => {
  const s = createAdsFixtureSanitizer();
  const raw = {
    request_id: "rq-1",
    access_token: "AT-secret",
    headers: { authorization: "Bearer x", cookie: "c=1" },
    response: {
      shop_id: 227974291,
      partner_id: 1,
      sign: "abc",
      set_cookie: "z",
      campaign_list: [
        { campaign_id: 555, campaign_name: "Siêu sale ga", item_id_list: [7, 8], expense: 1.5, status: "ongoing" },
        { campaign_id: "556", campaign_name: "Siêu sale ga", refresh_token: "RT-secret" },
      ],
    },
  };
  const out = s.sanitize(raw) as { request_id: string; response: { campaign_list: Array<Record<string, unknown>> } };
  const text = JSON.stringify(out);
  for (const bad of ["AT-secret", "RT-secret", "Bearer", "c=1", "227974291", "abc", "Siêu sale", '"sign"', "partner_id", "headers"]) assert.equal(text.includes(bad), false, bad);
  assert.equal(out.request_id, "rq-1");
  const [a, b] = out.response.campaign_list;
  assert.equal(typeof a.campaign_id, "number");
  assert.equal(typeof b.campaign_id, "string");
  assert.notEqual(a.campaign_id, 555);
  assert.equal(a.campaign_name, "Campaign #1");
  assert.equal(b.campaign_name, "Campaign #1", "same real name → same placeholder");
  assert.equal(a.expense, 1.5);
  assert.equal(a.status, "ongoing");
  assert.equal((a.item_id_list as number[]).length, 2);
  // same id seen later (params) maps to the same placeholder → relationships survive
  assert.equal(s.sanitizeParams({ campaign_id_list: "555,556", start_date: "27-10-2026" }).campaign_id_list, `${a.campaign_id},${b.campaign_id}`);
  assert.equal(s.sanitizeParams({ start_date: "27-10-2026" }).start_date, "27-10-2026");
});

test("dates are computed in the shop timezone (DD-MM-YYYY candidate format)", () => {
  assert.equal(adsProbeDate(new Date("2026-10-27T17:30:00Z"), "Asia/Ho_Chi_Minh"), "28-10-2026");
  assert.equal(adsProbeDate(new Date("2026-10-27T16:59:00Z"), "Asia/Ho_Chi_Minh"), "27-10-2026");
});

test("static: probe core has no network / DB / token access; server transport never logs bodies or URLs", () => {
  const root = process.cwd();
  const core = readFileSync(path.join(root, "src/lib/channels/shopee/ads/probe.ts"), "utf8");
  assert.doesNotMatch(core, /\bfetch\(|supabase|getValidAccessToken|from "@\//);
  const server = readFileSync(path.join(root, "src/lib/channels/shopee/ads/probe-server.ts"), "utf8");
  assert.match(server, /import "server-only"/);
  assert.doesNotMatch(server, /console\.\w+\([^)]*\b(url|text|body|accessToken)\b/);
  assert.doesNotMatch(server, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
});

test("fixture review: secret scan flags leftovers, passes a sanitized report", async () => {
  assert.deepEqual(findFixtureSecrets({ request_id: "e3e3e7f35ee107970ac9b3095bcc4900", response: { expense: 1, date: "27-10-2026" } }), []);
  const dirty = findFixtureSecrets({ access_token: "x", r: { shop_id: 1, v: "Bearer abc", j: "eyJa.eyJb.sig", h: "a".repeat(40) } });
  assert.equal(dirty.length, 5, dirty.join(" | "));
  assert.equal(findFixtureSecrets({ note: "has s3cr3t inside" }, ["s3cr3t"]).length, 1);
  const { transport } = stub((r) => okJson(HAPPY[r.endpoint]));
  const report = await runAdsProbe({ environment: "sandbox", shopLabel: "s", transport, now: NOW, sleep: noSleep });
  assert.deepEqual(findFixtureSecrets(report), []);
});
