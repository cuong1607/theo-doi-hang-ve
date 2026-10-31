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
import { compareCounterSnapshots, snapshotsFromProbe, summarizeCounterSemantics, type CounterSnapshot, type ItemCounterDelta, type ItemIntervalContext } from "../../src/lib/channels/shopee/product-analytics/counter-semantics.ts";
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

if (process.argv[2] === "semantics") {
  // SHOPEE-PRODUCT-ANALYTICS-1P: compare consecutive production probe runs of
  // each shop (same item ids, a VN calendar-day boundary in between). SELECT
  // only. Comparison source = Ads direct_item_sold of single-item campaigns
  // over the VN hours wholly inside the interval (a LOWER BOUND on units).
  // Raw report (real ids) → <outDir>; sanitized → fixtures (--save).
  const outDir = process.argv[3] ?? fail("Cách dùng: semantics <outDir> [--save]");
  const cloud = cloudDb();
  const { data, error } = await cloud.from("channel_api_snapshots").select("shop_id, payload").eq("entity_type", PRODUCT_ANALYTICS_PROBE_ENTITY).order("synced_at").limit(500);
  if (error) fail(error.message);
  const byShop = new Map<string, ProductAnalyticsProbeResult[]>();
  for (const r of data ?? []) {
    const run = r.payload as ProductAnalyticsProbeResult;
    if (run.environment !== "production" || !run.report.calls.some((c) => c.label !== "control" && c.classification === "OK")) continue;
    byShop.set(r.shop_id as string, [...(byShop.get(r.shop_id as string) ?? []), run]);
  }
  const vnDate = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const shops: unknown[] = [];
  const allDeltas: ItemCounterDelta[] = [];
  let intervals = 0;
  for (const [shopId, shopRuns] of byShop) {
    // one observation per item per VN day (the latest), whatever run it came in:
    // an admin may split a shop's ids over several runs
    const days = new Map<string, Map<string, { snap: CounterSnapshot; run: ProductAnalyticsProbeResult }>>();
    for (const run of shopRuns) {
      const day = days.get(vnDate(run.ranAt)) ?? new Map();
      for (const snap of snapshotsFromProbe(run)) day.set(snap.itemId, { snap, run });
      days.set(vnDate(run.ranAt), day);
    }
    const ordered = [...days.keys()].sort();
    for (let i = 0; i + 1 < ordered.length; i++) {
      const [dayA, dayB] = [days.get(ordered[i])!, days.get(ordered[i + 1])!];
      const ids = [...dayA.keys()].filter((id) => dayB.has(id));
      if (!ids.length) continue;
      const t0 = ids.map((id) => dayA.get(id)!.snap);
      const t1 = ids.map((id) => dayB.get(id)!.snap);
      // interval bounds for the Ads lower bound: the latest T0 and the earliest T1 observation (conservative)
      const a = { ranAt: t0.map((s) => s.capturedAt).sort().at(-1)!, shopLabel: dayA.get(ids[0])!.run.shopLabel };
      const b = { ranAt: t1.map((s) => s.capturedAt).sort()[0] };
      const { data: products } = await cloud.from("shopee_ads_products").select("provider_item_id, provider_status").eq("shop_id", shopId).in("provider_item_id", ids);
      const { data: links } = await cloud.from("shopee_ads_campaign_products").select("campaign_id, provider_item_id").eq("shop_id", shopId).limit(5000);
      const itemsPerCampaign = new Map<string, Set<string>>();
      for (const l of links ?? []) itemsPerCampaign.set(l.campaign_id as string, (itemsPerCampaign.get(l.campaign_id as string) ?? new Set()).add(l.provider_item_id as string));
      const [t0Ms, t1Ms] = [new Date(a.ranAt).getTime(), new Date(b.ranAt).getTime()];
      const context = new Map<string, ItemIntervalContext>();
      for (const id of ids) {
        const single = [...itemsPerCampaign].filter(([, items]) => items.size === 1 && items.has(id)).map(([c]) => c);
        let units: number | null = null;
        let hours = 0;
        if (single.length) {
          const { data: rows, error: e } = await cloud
            .from("shopee_ads_campaign_hourly_performance")
            .select("campaign_id, report_date, report_hour, direct_item_sold")
            .eq("shop_id", shopId)
            .in("campaign_id", single)
            .gte("report_date", vnDate(a.ranAt))
            .lte("report_date", vnDate(b.ranAt))
            .order("id")
            .range(0, 999);
          if (e) fail(e.message);
          units = 0;
          const slots = new Set<string>();
          for (const r of rows ?? []) {
            const start = new Date(`${r.report_date}T${String(r.report_hour).padStart(2, "0")}:00:00+07:00`).getTime();
            if (start < t0Ms || start + 3_600_000 > t1Ms) continue;
            units += Number(r.direct_item_sold);
            slots.add(`${r.report_date} ${r.report_hour}`);
          }
          hours = slots.size;
        }
        context.set(id, { providerStatus: (products ?? []).find((p) => p.provider_item_id === id)?.provider_status ?? null, adsDirectUnitsLowerBound: units, adsHours: hours });
      }
      const deltas = compareCounterSnapshots(t0, t1, context);
      allDeltas.push(...deltas);
      intervals++;
      shops.push({ shopId, shopLabel: a.shopLabel, t0: a.ranAt, t1: b.ranAt, deltas, context: Object.fromEntries(context) });
    }
  }
  if (!intervals) fail("Chưa có cặp lượt probe production nào qua mốc ngày (cần T0 và T1 khác ngày VN cho cùng shop).");
  const verdict = summarizeCounterSemantics(allDeltas, intervals);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `pa-semantics-raw-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ verdict, shops }, null, 2));
  for (const d of allDeltas) console.log(`${d.itemId}  ${d.providerStatus ?? "-"}  ret ${d.returnedT0 ? 1 : 0}/${d.returnedT1 ? 1 : 0}  sale ${d.saleT0}→${d.saleT1} (Δ${d.deltaSale}, ads≥${d.adsDirectUnitsLowerBound ?? "-"})  views ${d.viewsT0}→${d.viewsT1} (Δ${d.deltaViews})  ${d.sale} / ${d.views}`);
  console.log(JSON.stringify(verdict, null, 2));
  if (SAVE) {
    // stable placeholders: item-N per real id, shop-N per shop; no names, no real ids
    const ids = new Map<string, string>();
    const alias = (id: string) => ids.get(id) ?? (ids.set(id, `item-${ids.size + 1}`), ids.get(id)!);
    const sanitized = {
      _meta: { note: "sanitized T0/T1 comparison (SHOPEE-PRODUCT-ANALYTICS-1P); ids are placeholders; comparison source = Ads direct_item_sold, single-item campaigns, whole VN hours (lower bound)" },
      verdict,
      shops: (shops as Array<{ t0: string; t1: string; deltas: ItemCounterDelta[] }>).map((s, i) => ({ shop: `shop-${i + 1}`, t0: s.t0, t1: s.t1, deltas: s.deltas.map((d) => ({ ...d, itemId: alias(d.itemId) })) })),
    };
    const text = JSON.stringify(sanitized, null, 2);
    if ([...ids.keys()].some((id) => text.includes(id))) fail("Còn item id thật trong bản sanitized — dừng.");
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path.join(FIXTURE_DIR, "counter-semantics-prod.json"), text + "\n");
    console.log("sanitized → __fixtures__/provider/counter-semantics-prod.json");
  }
  process.exit(0);
}

const [planFile, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!planFile || !outDir) fail("Cách dùng: product-analytics-discovery.ts <plan.json> <outDir> [--save]  |  import-cloud [N]  |  semantics <outDir> [--save]");

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
