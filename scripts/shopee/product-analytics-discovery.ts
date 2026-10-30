// ============================================================
// DEV TOOL — SHOPEE-PRODUCT-ANALYTICS-1: discover product analytics reads,
// READ-ONLY.
//
//   PRODUCTION (live partner credentials in this run's env):
//   node --env-file=.env.shopee-live.local scripts/shopee/product-analytics-discovery.ts <plan.json> <outDir> [--save]
//   SANDBOX (route / shape check with the local sandbox shop):
//   node --env-file=.env.local scripts/shopee/product-analytics-discovery.ts <plan.json> <outDir> [--save]
//
//   The production partner key normally lives only on Vercel (a pulled env
//   file has it masked) → prefer the admin page /shopee/product-analytics/probe.
//
//   plan.json  [{ "shopKey": "<internal shops.id>", "shopLabel": "…", "itemIds": ["…"] }]
//              ≤ 10 items in total (discovery.ts validates; ≤ 12 requests, 1 s gap)
//   outDir     RAW report (real ids — keep it OUT of the repo, e.g. the scratchpad)
//   --save     sanitized fixtures → src/lib/channels/shopee/product-analytics/__fixtures__/provider/
//              (refuses when the secret scan finds anything; sandbox files are
//              prefixed "sandbox-"). Review before committing.
//
// Safety: production = same rules as live-readonly.ts — tokens read from the
// cloud DB (.env.cloud.local), NEVER refreshed, nothing written to any
// database. Sandbox = the local connection row only. GET only, through
// assertProductAnalyticsReadRequest.
// ============================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { ShopeeClient } from "../../src/lib/channels/shopee/client.ts";
import { getShopeeConfig } from "../../src/lib/channels/shopee/config.ts";
import { ShopeeConnectionService, type ShopeeTokenSource } from "../../src/lib/channels/shopee/token.ts";
import { inventoryFields, PRODUCT_ANALYTICS_PROBE_ENTITY, runProductAnalyticsDiscovery, sanitizeDiscoveryReport, type DiscoveryShopPlan, type DiscoveryTransport, type ProductAnalyticsProbeResult } from "../../src/lib/channels/shopee/product-analytics/discovery.ts";
import { assertProductAnalyticsReadRequest } from "../../src/lib/channels/shopee/product-analytics/read-only-policy.ts";
import { cloudDb, fail, ReadOnlyTokenSource } from "./cloud-readonly.ts";

const FIXTURE_DIR = path.join(process.cwd(), "src/lib/channels/shopee/product-analytics/__fixtures__/provider");

const SAVE = process.argv.includes("--save");

if (process.argv[2] === "import-cloud") {
  // Results of the admin page (/shopee/product-analytics/probe) live in ONE
  // channel_api_snapshots row per run. SELECT only; fixtures are sanitized.
  const cloud = cloudDb();
  const { data, error } = await cloud
    .from("channel_api_snapshots")
    .select("payload, synced_at")
    .eq("entity_type", PRODUCT_ANALYTICS_PROBE_ENTITY)
    .order("synced_at", { ascending: false })
    .limit(Number(process.argv[3] ?? 10));
  if (error) fail(error.message);
  const runs = (data ?? []).map((r) => r.payload as ProductAnalyticsProbeResult).filter((r) => r.environment === "production");
  if (!runs.length) fail("Chưa có lượt probe production nào trên cloud.");
  mkdirSync(FIXTURE_DIR, { recursive: true });
  runs.forEach((run, i) => {
    const { fixtures, secretFindings } = sanitizeDiscoveryReport(run.report, [], { comparisons: run.comparisons, suffix: `prod-${runs.length - i}` });
    if (secretFindings.length) fail(`Secret scan tìm thấy ${secretFindings.length} giá trị trong lượt ${run.ranAt} — dừng.`);
    for (const f of fixtures) writeFileSync(path.join(FIXTURE_DIR, f.name), JSON.stringify(f.content, null, 2) + "\n");
    console.log(`${run.ranAt}  ${run.report.calls.map((c) => `${c.label}=${c.classification}`).join(" ")}  → ${fixtures.length} fixtures`);
  });
  process.exit(0);
}

const [planFile, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!planFile || !outDir) fail("Cách dùng: product-analytics-discovery.ts <plan.json> <outDir> [--save]  |  import-cloud [N]");

const plan = JSON.parse(readFileSync(planFile, "utf8")) as DiscoveryShopPlan[];
const config = getShopeeConfig({ ...process.env, SHOPEE_REDIRECT_URL: process.env.SHOPEE_REDIRECT_URL || "https://localhost/readonly" });
const SANDBOX = /sandbox|test-stable/i.test(config.apiBaseUrl);
const client = new ShopeeClient({ partnerId: config.partnerId, partnerKey: config.partnerKey, apiBaseUrl: config.apiBaseUrl, maxRetries: 0, logger: () => {} });

let db: SupabaseClient;
let tokens: ShopeeTokenSource;
if (SANDBOX) {
  const dbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) fail("Host sandbox nhưng NEXT_PUBLIC_SUPABASE_URL không phải DB local.");
  db = createClient(dbUrl, process.env.SUPABASE_SERVICE_ROLE_KEY ?? fail("thiếu SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
  tokens = new ShopeeConnectionService({ db, client, encryptionKey: config.encryptionKey, logger: () => {} });
} else {
  db = cloudDb();
  tokens = new ReadOnlyTokenSource(db, config.encryptionKey);
}

const { data: shops, error } = await db.from("shops").select("id, external_shop_id, shop_name").eq("channel", "shopee").eq("data_source", "live").in("id", plan.map((p) => p.shopKey));
if (error) fail(error.message);
const shopById = new Map((shops ?? []).map((s) => [s.id as string, s]));
for (const p of plan) if (!shopById.has(p.shopKey)) fail(`Shop không hợp lệ: ${p.shopKey}`);

const secrets: string[] = [config.partnerKey];
const transport: DiscoveryTransport = async (req) => {
  assertProductAnalyticsReadRequest(req.method, req.path);
  const shop = shopById.get(req.shopKey)!;
  const accessToken = await tokens.getValidAccessToken(shop.id as string);
  secrets.push(accessToken);
  const url = client.signedUrl(req.path, req.params, { externalShopId: shop.external_shop_id as string, accessToken });
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const text = (await res.text()).split(accessToken).join("[redacted]").split(config.partnerKey).join("[redacted]");
    return { httpStatus: res.status, latencyMs: Date.now() - started, text };
  } catch (err) {
    return { httpStatus: null, latencyMs: Date.now() - started, text: "", transportError: { code: "network_error", message: err instanceof Error ? err.name : "fetch failed" } };
  }
};

console.log(`ENVIRONMENT: ${SANDBOX ? "SANDBOX" : "PRODUCTION"}   MODE: READ_ONLY   items: ${plan.reduce((n, p) => n + p.itemIds.length, 0)}   shops: ${plan.length}`);
const report = await runProductAnalyticsDiscovery({ plan, transport });
for (const c of report.calls) {
  console.log(`${c.method} ${c.path}  [${c.shopLabel}]  http ${c.httpStatus}  ${c.classification}  err=${c.providerError ?? "-"}  items ${c.returnedItemIds.length}/${c.requestedItems}  ${c.latencyMs} ms`);
}
console.log(`requests ${report.requestsUsed}/${report.requestBudget} · stop: ${report.stoppedReason}`);

mkdirSync(outDir, { recursive: true });
const stamp = `${SANDBOX ? "sandbox" : "prod"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
writeFileSync(path.join(outDir, `pa-discovery-raw-${stamp}.json`), JSON.stringify(report, null, 2));
const { fixtures, secretFindings } = sanitizeDiscoveryReport(report, secrets);
const ok = report.calls.map((c, i) => [c, fixtures[i]] as const).filter(([c]) => c.classification === "OK");
writeFileSync(path.join(outDir, `pa-discovery-fields-${stamp}.json`), JSON.stringify(inventoryFields(ok.map(([c]) => c.body), ok.map(([, f]) => (f.content as { body: unknown }).body)), null, 2));
console.log(`raw + field inventory → ${outDir}`);

if (SAVE) {
  if (secretFindings.length) fail(`Secret scan tìm thấy ${secretFindings.length} giá trị nghi là bí mật — KHÔNG lưu fixture.`);
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const f of fixtures) writeFileSync(path.join(FIXTURE_DIR, `${SANDBOX ? "sandbox-" : ""}${f.name}`), JSON.stringify(f.content, null, 2) + "\n");
  console.log(`${fixtures.length} sanitized fixtures → ${path.relative(process.cwd(), FIXTURE_DIR)}`);
}
