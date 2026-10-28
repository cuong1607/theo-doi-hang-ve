// ============================================================
// DEV TOOL — SHOPEE-ADS-1: discover the REAL Shopee Ads API, READ-ONLY.
//
//   npm run shopee:ads -- shops [--prod]
//   npm run shopee:ads -- probe <apiPath> ['{"param":"value"}'] [--save name] [--shop <id>] [--prod]
//       one signed GET; prints HTTP status, latency, request id, provider
//       error and the sanitized payload; --save writes a fixture to
//       src/lib/channels/shopee/ads/__fixtures__/provider/<name>.json
//   npm run shopee:ads -- survey [--save] [--days 7] [--shop <id>] [--prod]
//       probes the candidate read endpoints with the smallest safe params,
//       chaining REAL campaign ids from the campaign list into the
//       setting / performance calls; prints a summary table. --save stores
//       every SUCCESSFUL answer as a fixture (errors are printed only).
//
// (Git Bash: prefix MSYS_NO_PATHCONV=1 so "/api/v2/..." is not rewritten.)
//
// Modes:
//   default  LOCAL connection (sandbox/test partner in .env.local). Token
//            refresh only ever touches the local connection row.
//   --prod   PRODUCTION shops, read-only exactly like `npm run shopee:live`:
//            tokens read from the cloud DB (.env.cloud.local), NEVER
//            refreshed, nothing written. Needs the LIVE partner credentials
//            and the production APP_ENCRYPTION_KEY in the environment of
//            THIS run, e.g.
//              node --env-file=.env.local --env-file=.env.shopee-live.local \
//                scripts/shopee/ads-discovery.ts survey --prod --save
//            (.env.shopee-live.local: SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY /
//            APP_ENCRYPTION_KEY of production, SHOPEE_API_BASE_URL unset or
//            https://partner.shopeemobile.com — the file is git-ignored by the
//            repo's .env* rule; never commit it.)
//
// Safety (refuses to run otherwise):
//   * GET only, and only /api/v2/ads/get_* paths — no create / edit /
//     status / bid / budget / delete endpoint can be called.
//   * default mode: NEXT_PUBLIC_SUPABASE_URL must be the LOCAL database.
//     --prod: the API host must NOT be a sandbox host.
//   * Output never contains partner key, access/refresh token or signature:
//     the signed URL is never printed, response text is scrubbed of the
//     token / key, and payload keys that look like secrets are dropped.
//   * At most one call per second.
// ============================================================
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { ShopeeClient } from "../../src/lib/channels/shopee/client.ts";
import { getShopeeConfig } from "../../src/lib/channels/shopee/config.ts";
import { ShopeeConnectionService, type ShopeeTokenSource } from "../../src/lib/channels/shopee/token.ts";
import { sanitizeAdsPayload } from "../../src/lib/channels/shopee/ads/sanitize.ts";
import { cloudDb, fail, ReadOnlyTokenSource } from "./cloud-readonly.ts";

const FIXTURE_DIR = path.join(process.cwd(), "src/lib/channels/shopee/ads/__fixtures__/provider");
const CALL_GAP_MS = 1000;

const argv = process.argv.slice(2);
const PROD = argv.includes("--prod");

const config = getShopeeConfig({ ...process.env, SHOPEE_REDIRECT_URL: process.env.SHOPEE_REDIRECT_URL || "https://localhost/readonly" });
const isSandboxHost = /sandbox|test-stable/i.test(config.apiBaseUrl);
let db: SupabaseClient;
let tokens: ShopeeTokenSource;
// No retries: discovery must show the provider's first answer, and never hammer it.
const client = new ShopeeClient({ partnerId: config.partnerId, partnerKey: config.partnerKey, apiBaseUrl: config.apiBaseUrl, maxRetries: 0, logger: () => {} });
if (PROD) {
  if (isSandboxHost) fail(`--prod nhưng SHOPEE_API_BASE_URL (${config.apiBaseUrl}) là host Sandbox — đặt credentials LIVE cho lần chạy này.`);
  db = cloudDb();
  tokens = new ReadOnlyTokenSource(db, config.encryptionKey);
} else {
  const dbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) fail("NEXT_PUBLIC_SUPABASE_URL không phải DB local (muốn dùng shop production thì thêm --prod).");
  db = createClient(dbUrl, process.env.SUPABASE_SERVICE_ROLE_KEY ?? fail("thiếu SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
  tokens = new ShopeeConnectionService({ db, client, encryptionKey: config.encryptionKey, logger: () => {} });
}

/** Read-only guard: only /api/v2/ads/get_* (GET). */
function assertReadOnlyAdsPath(apiPath: string): void {
  if (!/^\/api\/v2\/ads\/get_[a-z0-9_]+$/.test(apiPath)) fail(`Từ chối "${apiPath}": chỉ cho phép GET /api/v2/ads/get_* (read-only).`);
}

type Shop = { id: string; external_shop_id: string; shop_name: string };

async function liveShops(): Promise<Shop[]> {
  const { data, error } = await db.from("shops").select("id, external_shop_id, shop_name").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true);
  if (error) fail(error.message);
  return (data ?? []) as Shop[];
}

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function pickShop(): Promise<Shop> {
  const shops = await liveShops();
  const wanted = flag("shop");
  const shop = wanted ? shops.find((s) => s.id === wanted || s.external_shop_id === wanted) : shops.length === 1 ? shops[0] : undefined;
  if (!shop) fail(wanted ? `Không có shop live ${wanted}.` : `Chọn shop bằng --shop <id> (có ${shops.length} shop live; xem lệnh "shops").`);
  return shop;
}

type Params = Record<string, string | number>;
type ProbeResult =
  | { ok: true; httpStatus: number; latencyMs: number; requestId: string | null; data: unknown }
  | { ok: false; httpStatus: number | null; latencyMs: number; requestId: string | null; errorCode: string; message: string; rawBody?: string; contentType?: string | null };

/**
 * One signed GET with plain fetch (not ShopeeClient.request) so a non-JSON
 * answer (gateway page, "ERROR_SP_SERVICE_NOT_FOUND" …) is shown as-is.
 * Same signing code as production (client.signedUrl); the URL is never printed.
 */
async function probe(shop: Shop, apiPath: string, params: Params): Promise<ProbeResult> {
  assertReadOnlyAdsPath(apiPath);
  const accessToken = await tokens.getValidAccessToken(shop.id);
  const url = client.signedUrl(apiPath, params, { externalShopId: shop.external_shop_id, accessToken });
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { ok: false, httpStatus: null, latencyMs: Date.now() - started, requestId: null, errorCode: "network_error", message: err instanceof Error ? err.name : "fetch failed" };
  }
  const latencyMs = Date.now() - started;
  const text = (await res.text()).split(accessToken).join("[redacted]").split(config.partnerKey).join("[redacted]");
  let data: { error?: string; message?: string; request_id?: string } | null = null;
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON answer
  }
  if (!data || typeof data !== "object") {
    return { ok: false, httpStatus: res.status, latencyMs, requestId: null, errorCode: "non_json", message: `HTTP ${res.status}`, rawBody: text.slice(0, 400), contentType: res.headers.get("content-type") };
  }
  const requestId = typeof data.request_id === "string" && data.request_id ? data.request_id : null;
  if (data.error || !res.ok) {
    return { ok: false, httpStatus: res.status, latencyMs, requestId, errorCode: data.error || `http_${res.status}`, message: data.message ?? "" };
  }
  return { ok: true, httpStatus: res.status, latencyMs, requestId, data };
}

function ddmmyyyy(date: Date): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(date);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("day")}-${v("month")}-${v("year")}`;
}

function printResult(apiPath: string, params: Params, r: ProbeResult): void {
  console.log(`\n▶ GET ${apiPath}  params=${JSON.stringify(params)}`);
  if (r.ok) {
    console.log(`  ✓ HTTP ${r.httpStatus}  ${r.latencyMs} ms  request_id=${r.requestId ?? "-"}`);
    console.log(JSON.stringify(sanitizeAdsPayload(r.data), null, 2).split("\n").map((l) => `  ${l}`).join("\n"));
  } else {
    console.log(`  ✗ ${r.errorCode}  HTTP ${r.httpStatus ?? "-"}  ${r.latencyMs} ms  request_id=${r.requestId ?? "-"}`);
    if (r.message) console.log(`    ${r.message}`);
    if (r.rawBody !== undefined) console.log(`    content-type=${r.contentType ?? "-"} body=${JSON.stringify(r.rawBody.replace(/\s+/g, " "))}`);
  }
}

function saveFixture(name: string, apiPath: string, params: Params, r: ProbeResult): void {
  if (!/^[a-z0-9-]+$/.test(name)) fail("tên fixture chỉ nhận a-z 0-9 -");
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const fixture = {
    _meta: {
      endpoint: apiPath,
      method: "GET",
      params,
      environment: PROD ? "production" : isSandboxHost ? "sandbox" : "live",
      captured_at: new Date().toISOString(),
      http_status: r.httpStatus,
      latency_ms: r.latencyMs,
      note: "Sanitized real response: credentials and shop/partner identifiers removed, structure preserved.",
    },
    response: r.ok
      ? sanitizeAdsPayload(r.data, { dropIdentity: true })
      : { error: r.errorCode, message: r.message, ...(r.rawBody !== undefined ? { raw_body: r.rawBody, content_type: r.contentType } : {}) },
  };
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`  → saved ${path.relative(process.cwd(), file)}`);
}

/** Finds the first array of numbers/strings under a key that looks like campaign ids (shape unknown until verified). */
function findCampaignIds(data: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (found.length >= 20) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, key);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, k);
      return;
    }
    if (/campaign_id/i.test(key) && (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)))) found.push(String(v));
  };
  walk(data, "");
  return [...new Set(found)];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Candidate read endpoints to VERIFY. The names come from the Shopee Open
 * Platform v2 "ads" module listing; a candidate only counts as verified when
 * the provider answers it with a success envelope or a business / parameter
 * error — never because it is listed here. A control path that cannot exist
 * shows what "unknown endpoint" looks like on the same host.
 */
async function survey(shop: Shop, save: boolean, days: number): Promise<void> {
  const today = ddmmyyyy(new Date());
  const from = ddmmyyyy(new Date(Date.now() - (days - 1) * 86_400_000));
  const rows: string[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const run = async (name: string, apiPath: string, params: Params): Promise<ProbeResult> => {
    const r = await probe(shop, apiPath, params);
    printResult(apiPath, params, r);
    if (save && r.ok) saveFixture(name, apiPath, params, r);
    outcomes.push(
      r.ok
        ? { endpoint: apiPath, params, ok: true, http_status: r.httpStatus, latency_ms: r.latencyMs, fixture: `${name}.json` }
        : { endpoint: apiPath, params, ok: false, http_status: r.httpStatus, latency_ms: r.latencyMs, error: r.errorCode, message: r.message, raw_body: r.rawBody?.slice(0, 200) },
    );
    rows.push(`${apiPath.padEnd(58)} ${r.ok ? `ok (HTTP ${r.httpStatus})` : `${r.errorCode} (HTTP ${r.httpStatus ?? "-"})${r.rawBody ? ` ${r.rawBody.slice(0, 40)}` : ""}`}  ${r.latencyMs} ms`);
    await sleep(CALL_GAP_MS);
    return r;
  };

  await run("control-unknown-endpoint", "/api/v2/ads/get_this_endpoint_does_not_exist", {});
  await run("total-balance", "/api/v2/ads/get_total_balance", {});
  await run("shop-toggle-info", "/api/v2/ads/get_shop_toggle_info", {});
  await run("shop-daily-performance", "/api/v2/ads/get_all_cpc_ads_daily_performance", { start_date: from, end_date: today });
  await run("shop-hourly-performance", "/api/v2/ads/get_all_cpc_ads_hourly_performance", { performance_date: today });
  const list = await run("campaign-id-list", "/api/v2/ads/get_product_level_campaign_id_list", { ad_type: "all", offset: 0, limit: 50 });
  const ids = list.ok ? findCampaignIds(list.data).slice(0, 5) : [];
  console.log(`\n  campaign ids found in list: ${ids.length ? ids.join(", ") : "(none)"}`);
  if (ids.length) {
    const idList = ids.join(",");
    await run("campaign-setting-info", "/api/v2/ads/get_product_level_campaign_setting_info", { info_type_list: "1,2,3,4", campaign_id_list: idList });
    await run("campaign-daily-performance", "/api/v2/ads/get_product_campaign_daily_performance", { start_date: from, end_date: today, campaign_id_list: idList });
    await run("campaign-hourly-performance", "/api/v2/ads/get_product_campaign_hourly_performance", { performance_date: today, campaign_id_list: idList });
  }
  console.log(`\nSUMMARY  (${PROD ? "production" : isSandboxHost ? "sandbox" : "live"} · ${new URL(config.apiBaseUrl).host})`);
  for (const row of rows) console.log(`  ${row}`);
  if (save) {
    // Always leave evidence, even when every call failed (no per-endpoint fixture is written then).
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const file = path.join(FIXTURE_DIR, "_survey.json");
    const environment = PROD ? "production" : isSandboxHost ? "sandbox" : "live";
    writeFileSync(file, `${JSON.stringify({ environment, captured_at: new Date().toISOString(), days, results: outcomes }, null, 2)}\n`);
    console.log(`  → saved ${path.relative(process.cwd(), file)}`);
  }
}

async function main() {
  const cmd = argv[0];
  if (cmd === "shops") {
    for (const s of await liveShops()) console.log(`${s.id}  ${s.external_shop_id}  ${s.shop_name}`);
    return;
  }
  if (cmd === "probe") {
    const apiPath = argv[1] ?? fail("thiếu apiPath");
    const rawParams = argv[2] && !argv[2].startsWith("--") ? argv[2] : "{}";
    let params: Params;
    try {
      params = JSON.parse(rawParams);
    } catch {
      fail(`params không phải JSON: ${rawParams}`);
    }
    const shop = await pickShop();
    console.log(`shop ${shop.shop_name} (${shop.external_shop_id}) · ${PROD ? "production" : "local"} · host ${new URL(config.apiBaseUrl).host}`);
    const r = await probe(shop, apiPath, params);
    printResult(apiPath, params, r);
    const name = flag("save");
    if (name) saveFixture(name, apiPath, params, r);
    return;
  }
  if (cmd === "survey") {
    const shop = await pickShop();
    console.log(`shop ${shop.shop_name} (${shop.external_shop_id}) · ${PROD ? "production" : "local"} · host ${new URL(config.apiBaseUrl).host}`);
    const days = Math.min(Math.max(Number(flag("days") ?? 7) || 7, 1), 30);
    await survey(shop, argv.includes("--save"), days);
    return;
  }
  fail("Lệnh: shops | probe <apiPath> [json] [--save name] | survey [--save] [--days N]   (tuỳ chọn --shop <id> --prod)");
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
