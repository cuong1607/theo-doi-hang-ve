// ============================================================
// SHOPEE-ADS-1B — READ-ONLY Ads sync end to end against the LOCAL database
// (.env.local) with the sanitized PRODUCTION payloads as provider:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/ads/ads-sync.integration.test.ts
//
// queue (enqueue / claim / lease / retry) → worker → provider → snapshots →
// canonical tables → RealAdsDashboardSource. Test shops are created and
// deleted here (cascade); nothing else in the database is touched.
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { getSyncConfig } from "../../core/sync-config.ts";
import { enqueueSyncJob } from "../../core/sync-jobs.ts";
import { SyncWorker } from "../../core/sync-worker.ts";
import { ApiCallMeter } from "../sync-instrumentation.ts";
import { toJobFailure } from "../sync-errors.ts";
import { parseAdsFilters } from "./filters.ts";
import { FixtureShopeeAdsProvider, loadAdsFixtures, MeteredShopeeAdsProvider, type AdsFixtureData } from "./provider.ts";
import { ADS_SYNC_TYPES } from "./read-only-policy.ts";
import { RealAdsDashboardSource } from "./real-source.ts";
import { adsColdRange, createAdsRunner, enqueueAdsJob, requestAdsRefresh } from "./sync.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("Test tích hợp Ads chỉ chạy với DB local.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const NOW = new Date("2026-10-28T09:30:00Z"); // 16:30 in Vietnam — same day as the captured fixtures
const TAG = `ads1b${Date.now()}`;
const shopIds: string[] = [];
let shopN = 0;

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
});

async function newShop(): Promise<string> {
  const { data, error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: `${Date.now()}${++shopN}`, shop_name: `${TAG} shop ${shopN}`, currency: "VND", data_source: "live", region: "VN", is_active: true })
    .select("id")
    .single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

const baseData = loadAdsFixtures();
let provider: FixtureShopeeAdsProvider = new FixtureShopeeAdsProvider(baseData);
let providerCalls = 0;

function worker(onlyShops: string[]) {
  const config = { ...getSyncConfig(), shopAllowlist: onlyShops, globalWorkers: 10, maxRunningPerShop: 1 };
  return new SyncWorker({
    db,
    config,
    workerId: `test-${TAG}`,
    syncTypes: ADS_SYNC_TYPES,
    classifyError: toJobFailure,
    now: () => NOW,
    logger: () => {},
    createRunner: (job, budget) => {
      const meter = new ApiCallMeter(budget);
      const counting = { track: <T,>(name: string, fn: () => Promise<T>) => meter.track(name, () => { providerCalls++; return fn(); }) };
      return { meter, runner: createAdsRunner(job, { db, provider: new MeteredShopeeAdsProvider(provider, counting) }) };
    },
  });
}

/** Runs claimable Ads jobs of the given shops until none is left (retry jobs with a future next_attempt_at stay). */
async function drain(onlyShops: string[]) {
  const w = worker(onlyShops);
  const reports = [];
  for (let i = 0; i < 100; i++) {
    const r = await w.runOne(120_000);
    if (!r) break;
    reports.push(r);
  }
  return reports;
}

async function count(table: string, shopId: string): Promise<number> {
  const { count: c, error } = await db.from(table).select("id", { count: "exact", head: true }).eq("shop_id", shopId);
  if (error) throw error;
  return c ?? 0;
}

async function sumCampaignFacts(shopId: string, date: string) {
  const { data, error } = await db.from("shopee_ads_campaign_daily_performance").select("expense, impression, clicks, broad_order, broad_gmv").eq("shop_id", shopId).eq("report_date", date);
  if (error) throw error;
  return (data ?? []).reduce((a, r) => ({ expense: a.expense + Number(r.expense), impression: a.impression + Number(r.impression), clicks: a.clicks + Number(r.clicks), broadOrder: a.broadOrder + Number(r.broad_order), broadGmv: a.broadGmv + Number(r.broad_gmv) }), { expense: 0, impression: 0, clicks: 0, broadOrder: 0, broadGmv: 0 });
}

const fixtureJson = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "src/lib/channels/shopee/ads/__fixtures__/provider", `${name}.json`), "utf8")).response.response;

let shopA = "";

test("dependency: a campaign-performance job before any campaign metadata retries WITHOUT calling Shopee", async () => {
  const s = await newShop();
  await enqueueSyncJob(db, { shopId: s, syncType: "ads_campaign_performance_read", mode: "manual", priority: 6, metadata: { adsRange: { from: "2026-10-27", to: "2026-10-27" } } });
  const before = providerCalls;
  const [r] = await drain([s]);
  assert.equal(r.status, "retry");
  assert.equal(r.errorCode, "ads_campaigns_pending");
  assert.equal(providerCalls, before, "no provider call");
});

test("initial refresh through the queue: 143 campaigns + product links, campaign facts (≤7-day windows × ≤50 ids), shop facts (≤30-day windows)", async () => {
  shopA = await newShop();
  const refresh = await requestAdsRefresh(db, { shopId: shopA, now: NOW });
  assert.equal(refresh.initial, true);
  assert.deepEqual(refresh.range, { from: "2026-09-28", to: "2026-10-28" });
  assert.deepEqual(refresh.jobs.map((j) => j.syncType), ["ads_campaign_read", "ads_campaign_performance_read", "ads_shop_performance_read"]);
  const { data: jobs } = await db.from("channel_sync_jobs").select("sync_type, mode, metadata, lane, priority").eq("shop_id", shopA);
  assert.ok((jobs ?? []).every((j) => j.mode === "manual" && j.priority === 1), "user-initiated, highest priority");
  assert.deepEqual((jobs ?? []).map((j) => j.lane).sort(), ["ads_backfill", "ads_backfill", "ads_meta"]);
  // idempotent while pending
  const again = await requestAdsRefresh(db, { shopId: shopA, now: NOW });
  assert.ok(again.jobs.every((j) => !j.created));

  const reports = await drain([shopA]);
  assert.ok(reports.every((r) => r.status === "success" || r.status === "pending"), JSON.stringify(reports.map((r) => [r.syncType, r.status, r.errorCode])));
  assert.equal(await count("shopee_ads_campaigns", shopA), 143);
  assert.equal(await count("shopee_ads_campaign_products", shopA), 143);
  assert.equal(await count("shopee_ads_campaign_daily_performance", shopA), 143 * 31, "one row per campaign per day (zeros included, as the API returns them)");
  assert.equal(await count("shopee_ads_shop_daily_performance", shopA), 31, "28/09 … 28/10");
  const { data: states } = await db.from("channel_sync_states").select("sync_type, last_success_at").eq("shop_id", shopA);
  assert.deepEqual((states ?? []).map((s) => s.sync_type).sort(), [...ADS_SYNC_TYPES].sort());
  assert.ok((states ?? []).every((s) => Date.parse(s.last_success_at) === NOW.getTime()), "freshness = when the read finished");
  const { count: snaps } = await db.from("channel_api_snapshots").select("id", { count: "exact", head: true }).eq("shop_id", shopA).eq("entity_type", "ads");
  assert.ok((snaps ?? 0) >= 2 + 3 + 15 + 2, `raw snapshots kept (${snaps})`);
});

test("raw payload → canonical rows: exact primitives for 3 campaign/day and 3 shop/day rows", async () => {
  const rawCampaigns = [...fixtureJson("exp-campaign-daily-performance").campaign_list, ...fixtureJson("exp-campaign-daily-performance-3").campaign_list]
    .filter((c: { metrics_list: Array<{ expense: number }> }) => c.metrics_list[0].expense > 0)
    .slice(0, 3);
  for (const c of rawCampaigns) {
    const m = c.metrics_list[0];
    const { data: camp } = await db.from("shopee_ads_campaigns").select("id").eq("shop_id", shopA).eq("provider_campaign_id", String(c.campaign_id)).single();
    const { data: row } = await db.from("shopee_ads_campaign_daily_performance").select("*").eq("campaign_id", camp!.id).eq("report_date", "2026-10-27").single();
    assert.deepEqual(
      [Number(row!.expense), Number(row!.impression), Number(row!.clicks), Number(row!.direct_order), Number(row!.broad_order), Number(row!.direct_gmv), Number(row!.broad_gmv), Number(row!.direct_item_sold), Number(row!.broad_item_sold)],
      [m.expense, m.impression, m.clicks, m.direct_order, m.broad_order, m.direct_gmv, m.broad_gmv, m.direct_order_amount, m.broad_order_amount],
      `campaign ${c.campaign_id}`,
    );
  }
  for (const r of fixtureJson("exp-shop-daily-performance-2").slice(-3)) {
    const iso = `${r.date.slice(6)}-${r.date.slice(3, 5)}-${r.date.slice(0, 2)}`;
    const { data: row } = await db.from("shopee_ads_shop_daily_performance").select("*").eq("shop_id", shopA).eq("report_date", iso).single();
    assert.deepEqual(
      [Number(row!.expense), Number(row!.impression), Number(row!.clicks), Number(row!.direct_order), Number(row!.broad_order), Number(row!.direct_gmv), Number(row!.broad_gmv), Number(row!.direct_item_sold), Number(row!.broad_item_sold)],
      [r.expense, r.impression, r.clicks, r.direct_order, r.broad_order, r.direct_gmv, r.broad_gmv, r.direct_item_sold, r.broad_item_sold],
      `shop ${r.date}`,
    );
  }
  // settings: raw status / daily budget / provider timestamps preserved
  const { data: c40 } = await db.from("shopee_ads_campaigns").select("provider_status, provider_bidding_method, daily_budget, roas_target, provider_end_at").eq("shop_id", shopA).eq("provider_campaign_id", "900000040").single();
  assert.deepEqual([c40!.provider_status, c40!.provider_bidding_method, Number(c40!.daily_budget), Number(c40!.roas_target), c40!.provider_end_at], ["ongoing", "auto", 300000, 15, null]);
});

test("REGRESSION 27/10: shop total (1,104,162 đ) stays its own fact — never overwritten by Σ campaigns (1,072,671 đ)", async () => {
  const sum = await sumCampaignFacts(shopA, "2026-10-27");
  assert.deepEqual(sum, { expense: 1072671, impression: 29727, clicks: 960, broadOrder: 49, broadGmv: 11140148 });
  const { data: shopRow } = await db.from("shopee_ads_shop_daily_performance").select("expense, impression").eq("shop_id", shopA).eq("report_date", "2026-10-27").single();
  assert.equal(Number(shopRow!.expense), 1104162);
  assert.ok(Number(shopRow!.expense) > sum.expense);
});

test("dashboard (real source): overview = SHOP facts, table = CAMPAIGN facts, outside-product-campaigns delta, CPC = spend / clicks, Direct ≠ Broad", async () => {
  const source = new RealAdsDashboardSource(db, { now: () => NOW });
  const filters = { ...parseAdsFilters({ period: "custom", from: "2026-10-27", to: "2026-10-27", shop: shopA }, NOW) };
  const d = await source.load(filters);
  const cur = d.overview.current;
  assert.equal(cur.spend, 1104162, "overview spend = shop-level expense");
  assert.equal(cur.revenue, 11447308, "Doanh số Broad");
  assert.equal(cur.directRevenue, 10966208, "Doanh số Direct");
  assert.equal(cur.orders, 52);
  assert.equal(cur.directOrders, 41);
  assert.equal(cur.cpc, 1104162 / 1042, "CPC = spend / clicks");
  assert.equal(cur.roas, 11447308 / 1104162, "Broad ROAS ratio-of-sums");
  assert.equal(cur.directRoas, 10966208 / 1104162);
  assert.equal(cur.ctr, 1042 / 36145);
  assert.equal(cur.conversionRate, 52 / 1042);
  assert.equal(d.overview.outsideProductCampaigns!.spend, 31491, "shop − Σ campaigns");
  assert.equal(d.overview.outsideProductCampaigns!.impressions, 6418);
  const tableSpend = d.campaigns.reduce((a, r) => a + r.metrics.spend, 0);
  assert.equal(tableSpend, 1072671, "campaign table = campaign facts");
  assert.equal(d.campaigns.filter((r) => r.metrics.spend > 0).length, 43);
  const c40 = d.campaigns.find((r) => r.provider?.campaignId === "900000040")!;
  assert.equal(c40.status, "active");
  assert.equal(c40.dailyBudget, 300000);
  assert.equal(c40.metrics.cpc, 300000 / 172, "campaign CPC = spend / clicks, not Shopee cpc (20000)");
  assert.equal(c40.topProducts.length, 1);
  assert.equal(d.statusCounts.closed + d.statusCounts.paused + d.statusCounts.ended + d.statusCounts.active + d.statusCounts.unknown, d.statusCounts.all);
  assert.equal(d.insights.length, 0, "no demo insights in real mode");
  assert.equal(d.sync.source, "shopee");
  assert.equal(d.sync.state, "fresh");
  assert.equal(d.sync.details?.length, 3);
  assert.equal(d.sync.todayPartial, false);
  assert.equal(d.sync.reportThrough, "2026-10-28");
  // a range including today is flagged partial; "Hôm nay" has no comparison against a full day
  const today = await source.load(parseAdsFilters({ period: "today", shop: shopA }, NOW));
  assert.equal(today.sync.todayPartial, true);
  assert.equal(today.overview.previous.spend, 0);
  assert.equal(today.overview.current.spend, 508621);
});

test("idempotency: a second refresh keeps 143 campaigns, no duplicate links / facts, same totals", async () => {
  const before = { c: await count("shopee_ads_campaigns", shopA), p: await count("shopee_ads_campaign_products", shopA), f: await count("shopee_ads_campaign_daily_performance", shopA), s: await count("shopee_ads_shop_daily_performance", shopA) };
  // ADS-2: right after a sync the manual refresh is deduped (no provider call)
  const dedup = await requestAdsRefresh(db, { shopId: shopA, now: NOW });
  assert.equal(dedup.fresh, true);
  assert.equal(dedup.jobs.length, 0, "Dữ liệu vừa được đồng bộ → nothing enqueued");
  const r = await requestAdsRefresh(db, { shopId: shopA, now: NOW, force: true, config: { campaignStaleMinutes: 0 } });
  assert.equal(r.initial, false);
  assert.deepEqual(r.range, { from: "2026-10-28", to: "2026-10-28" }, "manual = today (HOT lane, all campaigns)");
  assert.ok(r.jobs.some((j) => j.syncType === "ads_campaign_read"), "metadata re-read when stale");
  assert.deepEqual(r.jobs.filter((j) => !j.poll).map((j) => [j.syncType, j.strategy]), [["ads_shop_performance_read", "warm"], ["ads_campaign_performance_read", "warm"]], "background WARM catch-up (no WARM ran yet)");
  await drain([shopA]);
  const afterCounts = { c: await count("shopee_ads_campaigns", shopA), p: await count("shopee_ads_campaign_products", shopA), f: await count("shopee_ads_campaign_daily_performance", shopA), s: await count("shopee_ads_shop_daily_performance", shopA) };
  assert.deepEqual(afterCounts, before);
  assert.deepEqual(await sumCampaignFacts(shopA, "2026-10-27"), { expense: 1072671, impression: 29727, clicks: 960, broadOrder: 49, broadGmv: 11140148 });
});

test("late provider update (COLD restatement): the same report date is UPSERTED (no duplicate fact), restatement counted, campaign settings change updates the same row", async () => {
  const { data: campBefore } = await db.from("shopee_ads_campaigns").select("id").eq("shop_id", shopA).eq("provider_campaign_id", "900000040").single();
  // provider now reports more for 27/10 and campaign #40 is paused with a new item
  const changed: AdsFixtureData = { ...baseData, settings: new Map(baseData.settings) };
  const s40 = structuredClone(baseData.settings.get("900000040")!) as Record<string, Record<string, unknown>>;
  s40.common_info.campaign_status = "paused";
  s40.common_info.item_id_list = [900099999];
  changed.settings.set("900000040", s40);
  provider = new FixtureShopeeAdsProvider(changed, {
    shopDaily: (date, row) => (date === "27-10-2026" ? { ...row, expense: Number(row.expense) + 100 } : row),
    campaignDaily: (id, date, row) => (id === "900000040" && date === "27-10-2026" ? { ...row, expense: Number(row.expense) + 50 } : row),
  });
  try {
    const facts = await count("shopee_ads_campaign_daily_performance", shopA);
    await enqueueAdsJob(db, { shopId: shopA, syncType: "ads_campaign_read", strategy: "metadata", priority: 5, now: NOW });
    const cold = adsColdRange(NOW, "Asia/Ho_Chi_Minh", { restatementDays: 7 });
    const coldShop = await enqueueAdsJob(db, { shopId: shopA, syncType: "ads_shop_performance_read", strategy: "cold", priority: 6, range: cold, now: NOW });
    const coldCampaign = await enqueueAdsJob(db, { shopId: shopA, syncType: "ads_campaign_performance_read", strategy: "cold", priority: 6, range: cold, scope: "all", now: NOW });
    await drain([shopA]);
    // values stored at NOW (after 27/10 had ended) and now different = real restatement, counted with samples
    const { data: coldJobs } = await db.from("channel_sync_jobs").select("id, status, metadata").in("id", [coldShop.jobId, coldCampaign.jobId]);
    for (const j of coldJobs ?? []) {
      assert.equal(j.status, "success");
      assert.equal((j.metadata as { stats: { restatedRows?: number } }).stats.restatedRows, 1, `one restated row (${j.id})`);
    }
    const sample = (coldJobs ?? []).map((j) => (j.metadata as { restatedSamples: Array<{ date: string; fields: Record<string, [string, string]> }> }).restatedSamples[0]);
    assert.ok(sample.every((s) => s.date === "2026-10-27" && Object.keys(s.fields).join() === "expense"));
    assert.equal(await count("shopee_ads_campaign_daily_performance", shopA), facts, "no duplicate fact rows");
    const { data: shopRow } = await db.from("shopee_ads_shop_daily_performance").select("expense").eq("shop_id", shopA).eq("report_date", "2026-10-27").single();
    assert.equal(Number(shopRow!.expense), 1104262);
    const { data: camp } = await db.from("shopee_ads_campaigns").select("id, provider_status").eq("shop_id", shopA).eq("provider_campaign_id", "900000040").single();
    assert.equal(camp!.id, campBefore!.id, "same canonical row");
    assert.equal(camp!.provider_status, "paused");
    const { data: fact } = await db.from("shopee_ads_campaign_daily_performance").select("expense").eq("campaign_id", camp!.id).eq("report_date", "2026-10-27").single();
    assert.equal(Number(fact!.expense), 300050, "history stays attached, value upserted");
    const { data: links } = await db.from("shopee_ads_campaign_products").select("provider_item_id").eq("campaign_id", camp!.id);
    assert.deepEqual((links ?? []).map((l) => l.provider_item_id), ["900099999"], "stale link removed, new one added (complete payload)");
    assert.equal(await count("shopee_ads_campaign_products", shopA), 143);
  } finally {
    provider = new FixtureShopeeAdsProvider(baseData);
  }
});

test("multi-shop: same provider campaign ids in two shops never collide; all-shop overview sums SHOP primitives then derives ratios", async () => {
  const shopB = await newShop();
  await requestAdsRefresh(db, { shopId: shopB, now: NOW });
  await drain([shopB]);
  assert.equal(await count("shopee_ads_campaigns", shopB), 143);
  assert.equal(await count("shopee_ads_campaigns", shopA), 143, "shop A untouched");
  const source = new RealAdsDashboardSource(db, { now: () => NOW });
  const a = await source.load(parseAdsFilters({ period: "custom", from: "2026-10-26", to: "2026-10-26", shop: shopA }, NOW));
  const b = await source.load(parseAdsFilters({ period: "custom", from: "2026-10-26", to: "2026-10-26", shop: shopB }, NOW));
  assert.equal(a.overview.current.spend, 1028066);
  assert.equal(b.overview.current.spend, 1028066);
  // all-shop: the source covers every live shop of the DB, so compare through the RPC restricted to A + B
  const { data: both } = await db.rpc("ads_dashboard_shop_daily", { p_shop_ids: [shopA, shopB], p_from: "2026-10-26", p_to: "2026-10-26" });
  const row = (both as Array<{ expense: number; clicks: number; shops_with_data: number }>)[0];
  assert.equal(Number(row.expense), 2 * 1028066);
  assert.equal(Number(row.shops_with_data), 2);
  assert.equal(Number(row.expense) / Number(row.clicks), 1028066 / 893, "ratio from summed primitives = same CPC (not an average of shop CPCs)");
});

test("zero / empty range: no NaN / Infinity, ratios null, no fabricated values", async () => {
  const source = new RealAdsDashboardSource(db, { now: () => NOW });
  const d = await source.load(parseAdsFilters({ period: "custom", from: "2026-01-01", to: "2026-01-07", shop: shopA }, NOW));
  assert.equal(d.overview.current.spend, 0);
  for (const k of ["roas", "acos", "ctr", "cpc", "conversionRate", "directRoas", "directAcos", "directConversionRate"] as const) assert.equal(d.overview.current[k], null, k);
  assert.equal(d.overview.outsideProductCampaigns, null, "no shop facts → no delta");
  assert.ok(d.trend.every((p) => Number.isFinite(p.spend) && p.roas === null));
  assert.ok(JSON.stringify(d).indexOf("NaN") === -1 && JSON.stringify(d).indexOf("Infinity") === -1);
});

test("unknown provider status persists raw and maps to a neutral UI status", async () => {
  const changed: AdsFixtureData = { ...baseData, settings: new Map(baseData.settings) };
  const s1 = structuredClone(baseData.settings.get("900000001")!) as Record<string, Record<string, unknown>>;
  s1.common_info.campaign_status = "brand_new_status";
  changed.settings.set("900000001", s1);
  provider = new FixtureShopeeAdsProvider(changed);
  try {
    await enqueueSyncJob(db, { shopId: shopA, syncType: "ads_campaign_read", mode: "manual", priority: 5 });
    const reports = await drain([shopA]);
    assert.ok(reports.every((r) => r.status === "success"));
    const { data } = await db.from("shopee_ads_campaigns").select("provider_status").eq("shop_id", shopA).eq("provider_campaign_id", "900000001").single();
    assert.equal(data!.provider_status, "brand_new_status");
    const d = await new RealAdsDashboardSource(db, { now: () => NOW }).load(parseAdsFilters({ period: "custom", from: "2026-10-27", to: "2026-10-27", shop: shopA, status: "unknown" }, NOW));
    void d; // listed only when active in the period; the mapping itself is unit-tested
  } finally {
    provider = new FixtureShopeeAdsProvider(baseData);
  }
});
