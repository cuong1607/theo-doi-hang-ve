// ============================================================
// DEV TOOL — SHOPEE-ADS-1 / 1A: discover the REAL Shopee Ads API, READ-ONLY.
//
//   npm run shopee:ads -- shops [--prod]
//   npm run shopee:ads -- survey [--save] [--shop <id>] [--prod]
//       the SAME probe sequence as the admin page /shopee/ads/probe
//       (src/lib/channels/shopee/ads/probe.ts: allowlist, ≤25 requests,
//       1 s gap, circuit breaker, sanitizer). --save imports the result like
//       the "import" command below.
//   npm run shopee:ads -- probe <apiPath> ['{"param":"value"}'] [--shop <id>]
//       one signed GET (LOCAL mode only for free-form /api/v2/ads/get_*;
//       with --prod only allowlisted paths).
//   npm run shopee:ads -- import <ads-probe-report.json>
//       report downloaded from /shopee/ads/probe → secret scan (refuses on
//       any finding) → src/lib/channels/shopee/ads/__fixtures__/provider/
//       _probe-report.json + one <endpoint>.json per successful call.
//       Review the files before committing them.
//
// (Git Bash: prefix MSYS_NO_PATHCONV=1 so "/api/v2/..." is not rewritten.)
//
// Modes:
//   default  LOCAL connection (sandbox/test partner in .env.local). Token
//            refresh only ever touches the local connection row.
//   --prod   PRODUCTION shops, read-only exactly like `npm run shopee:live`:
//            tokens read from the cloud DB (.env.cloud.local), NEVER
//            refreshed, nothing written; needs the LIVE partner credentials +
//            production APP_ENCRYPTION_KEY in this run's env
//            (--env-file=.env.shopee-live.local, git-ignored). The production
//            secrets normally live only on Vercel → prefer the admin page.
// ============================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { ShopeeClient } from "../../src/lib/channels/shopee/client.ts";
import { getShopeeConfig, type ShopeeConfig } from "../../src/lib/channels/shopee/config.ts";
import { ShopeeConnectionService, type ShopeeTokenSource } from "../../src/lib/channels/shopee/token.ts";
import { adsProbeFixtures, isAllowlistedAdsPath, runAdsProbe, type AdsProbeReport, type AdsProbeTransport } from "../../src/lib/channels/shopee/ads/probe.ts";
import { findFixtureSecrets, sanitizeAdsPayload } from "../../src/lib/channels/shopee/ads/sanitize.ts";
import { assertAdsReadOnlyRequest, isAdsReadOnlyPath } from "../../src/lib/channels/shopee/ads/read-only-policy.ts";
import { cloudDb, fail, ReadOnlyTokenSource } from "./cloud-readonly.ts";

const FIXTURE_DIR = path.join(process.cwd(), "src/lib/channels/shopee/ads/__fixtures__/provider");

const argv = process.argv.slice(2);
const PROD = argv.includes("--prod");

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

type Shop = { id: string; external_shop_id: string; shop_name: string; timezone: string | null };

interface Ctx {
  config: ShopeeConfig;
  isSandboxHost: boolean;
  db: SupabaseClient;
  tokens: ShopeeTokenSource;
  client: ShopeeClient;
}

function connect(): Ctx {
  const config = getShopeeConfig({ ...process.env, SHOPEE_REDIRECT_URL: process.env.SHOPEE_REDIRECT_URL || "https://localhost/readonly" });
  const isSandboxHost = /sandbox|test-stable/i.test(config.apiBaseUrl);
  const client = new ShopeeClient({ partnerId: config.partnerId, partnerKey: config.partnerKey, apiBaseUrl: config.apiBaseUrl, maxRetries: 0, logger: () => {} });
  if (PROD) {
    if (isSandboxHost) fail(`--prod nhưng SHOPEE_API_BASE_URL (${config.apiBaseUrl}) là host Sandbox — đặt credentials LIVE cho lần chạy này.`);
    const db = cloudDb();
    return { config, isSandboxHost, db, client, tokens: new ReadOnlyTokenSource(db, config.encryptionKey) };
  }
  const dbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) fail("NEXT_PUBLIC_SUPABASE_URL không phải DB local (shop production: thêm --prod, hoặc dùng trang /shopee/ads/probe).");
  const db = createClient(dbUrl, process.env.SUPABASE_SERVICE_ROLE_KEY ?? fail("thiếu SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
  return { config, isSandboxHost, db, client, tokens: new ShopeeConnectionService({ db, client, encryptionKey: config.encryptionKey, logger: () => {} }) };
}

async function liveShops(ctx: Ctx): Promise<Shop[]> {
  const { data, error } = await ctx.db.from("shops").select("id, external_shop_id, shop_name, timezone").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true);
  if (error) fail(error.message);
  return (data ?? []) as Shop[];
}

async function pickShop(ctx: Ctx): Promise<Shop> {
  const shops = await liveShops(ctx);
  const wanted = flag("shop");
  // Internal shops.id (or the external id of a CONNECTED shop record) — never an unknown provider id.
  const shop = wanted ? shops.find((s) => s.id === wanted || s.external_shop_id === wanted) : shops.length === 1 ? shops[0] : undefined;
  if (!shop) fail(wanted ? `Không có shop live ${wanted}.` : `Chọn shop bằng --shop <id> (có ${shops.length} shop live; xem lệnh "shops").`);
  return shop;
}

/** Same transport contract as the server one: plain fetch (non-JSON answers kept), URL never printed, secrets scrubbed. */
function cliTransport(ctx: Ctx, shop: Shop): AdsProbeTransport {
  return async (req) => {
    assertAdsReadOnlyRequest(req.method, req.path); // read-only policy: GET + read path, always
    let accessToken: string;
    try {
      accessToken = await ctx.tokens.getValidAccessToken(shop.id);
    } catch (err) {
      return { httpStatus: null, latencyMs: 0, text: "", transportError: { code: "token_unavailable", message: err instanceof Error ? err.message : "token", reauth: true } };
    }
    const url = ctx.client.signedUrl(req.path, req.params, { externalShopId: shop.external_shop_id, accessToken });
    const started = Date.now();
    try {
      const res = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const text = (await res.text()).split(accessToken).join("[redacted]").split(ctx.config.partnerKey).join("[redacted]");
      return { httpStatus: res.status, latencyMs: Date.now() - started, text };
    } catch (err) {
      return { httpStatus: null, latencyMs: Date.now() - started, text: "", transportError: { code: "network_error", message: err instanceof Error ? err.name : "fetch failed" } };
    }
  };
}

function printReport(report: AdsProbeReport): void {
  console.log(`\nENVIRONMENT: ${report.environment.toUpperCase()}   MODE: ${report.mode}   SHOP: ${report.shopLabel}`);
  console.log(`requests ${report.requestsUsed}/${report.requestBudget} · stop: ${report.stoppedReason} · Ads access: ${report.adsAccess ?? "-"}`);
  for (const c of report.calls) {
    const records = Object.entries(c.arrayLengths).map(([k, n]) => `${k}=${n}`).join(" ");
    console.log(
      `  #${String(c.step).padStart(2)} ${c.endpoint.padEnd(28)} HTTP ${String(c.httpStatus ?? "-").padEnd(4)} ${c.classification.padEnd(20)} ${String(c.latencyMs).padStart(5)} ms  ${c.errorCode ?? ""} ${c.message ?? ""} ${records}`,
    );
  }
}

function importReport(report: AdsProbeReport): void {
  if (!report || report.mode !== "READ_ONLY" || !Array.isArray(report.calls)) fail("File không phải báo cáo probe Ads.");
  const findings = findFixtureSecrets(report);
  if (findings.length) {
    console.error("✖ Báo cáo còn dữ liệu nhạy cảm — KHÔNG ghi fixture:");
    for (const f of findings.slice(0, 30)) console.error(`  - ${f}`);
    process.exit(1);
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const write = (name: string, content: unknown) => {
    const file = path.join(FIXTURE_DIR, `${name}.json`);
    writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
    console.log(`  → ${path.relative(process.cwd(), file)}`);
  };
  write("_probe-report", { ...report, calls: report.calls.map(({ body, ...c }) => ({ ...c, body: c.classification === "AVAILABLE" ? `see ${c.endpoint.replace(/_/g, "-")}*.json` : body })) });
  for (const f of adsProbeFixtures(report)) write(f.name, f.content);
  console.log("Xem lại các file trước khi commit (tên / ID đã được che, metric giữ nguyên).");
}

async function main() {
  const cmd = argv[0];
  if (cmd === "import") {
    const file = argv[1] ?? fail("thiếu đường dẫn file báo cáo");
    let report: AdsProbeReport;
    try {
      report = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      fail(`Không đọc được JSON: ${file}`);
    }
    importReport(report);
    return;
  }
  const ctx = connect();
  if (cmd === "shops") {
    for (const s of await liveShops(ctx)) console.log(`${s.id}  ${s.external_shop_id}  ${s.shop_name}`);
    return;
  }
  if (cmd === "survey") {
    const shop = await pickShop(ctx);
    const report = await runAdsProbe({
      environment: ctx.isSandboxHost ? "sandbox" : "production",
      confirmProduction: PROD, // production only with the explicit flag
      shopLabel: shop.shop_name,
      transport: cliTransport(ctx, shop),
      timeZone: shop.timezone || "Asia/Ho_Chi_Minh",
    });
    printReport(report);
    if (argv.includes("--save")) importReport(report);
    return;
  }
  if (cmd === "probe") {
    const apiPath = argv[1] ?? fail("thiếu apiPath");
    if (!isAdsReadOnlyPath(apiPath)) fail(`Từ chối "${apiPath}": chỉ cho phép GET /api/v2/ads/get_* không chứa động từ ghi (read-only policy).`);
    if (PROD && !isAllowlistedAdsPath(apiPath)) fail(`Từ chối "${apiPath}": production chỉ cho phép endpoint trong allowlist (probe.ts).`);
    const rawParams = argv[2] && !argv[2].startsWith("--") ? argv[2] : "{}";
    let params: Record<string, string | number>;
    try {
      params = JSON.parse(rawParams);
    } catch {
      fail(`params không phải JSON: ${rawParams}`);
    }
    const shop = await pickShop(ctx);
    console.log(`ENVIRONMENT: ${PROD ? "PRODUCTION" : ctx.isSandboxHost ? "SANDBOX" : "LIVE"}   MODE: READ_ONLY   SHOP: ${shop.shop_name}`);
    const res = await cliTransport(ctx, shop)({ endpoint: "shop_toggle_info", method: "GET", path: apiPath, params });
    console.log(`HTTP ${res.httpStatus ?? "-"}  ${res.latencyMs} ms  ${res.transportError ? `${res.transportError.code}: ${res.transportError.message}` : ""}`);
    try {
      console.log(JSON.stringify(sanitizeAdsPayload(JSON.parse(res.text), { dropIdentity: true }), null, 2));
    } catch {
      console.log(`non-JSON body: ${JSON.stringify(res.text.slice(0, 400))}`);
    }
    return;
  }
  fail("Lệnh: shops | survey [--save] | probe <apiPath> [json] | import <report.json>   (tuỳ chọn --shop <id> --prod)");
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
