// ============================================================
// SHOPEE-ADS-2 — background Ads sync against the LOCAL database:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/ads/ads-scheduler.integration.test.ts
//
// scheduler tick (slot claim, staggering, HOT / WARM / COLD / backfill /
// metadata) → enqueue (dedupe, coalescing, widening) → claim (priority,
// fairness, Ads concurrency cap, per-shop cap) → runners (active-campaign
// HOT scope + fallback, batch checkpoints, stale recovery, metadata repair)
// → canonical tables → dashboard freshness. Plus a 5-shop load simulation.
// Test shops are created and deleted here (cascade); nothing else is touched.
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { getSyncConfig } from "../../core/sync-config.ts";
import { claimNextSyncJob, recoverStaleSyncJobs } from "../../core/sync-jobs.ts";
import { SyncWorker, type SliceReport } from "../../core/sync-worker.ts";
import { mapWithConcurrency } from "../../core/time-windows.ts";
import { ApiCallMeter } from "../sync-instrumentation.ts";
import { ShopeeApiError } from "../errors.ts";
import { toJobFailure } from "../sync-errors.ts";
import { parseAdsFilters } from "./filters.ts";
import { FixtureShopeeAdsProvider, loadAdsFixtures, MeteredShopeeAdsProvider, type AdsDateRange, type AdsProviderContext, type ShopeeAdsProvider } from "./provider.ts";
import { ADS_SYNC_TYPES } from "./read-only-policy.ts";
import { RealAdsDashboardSource } from "./real-source.ts";
import { runAdsSchedulerTick, setAdsShopSyncEnabled } from "./schedule.ts";
import { SimulatedAdsProvider } from "./simulated-provider.test-util.ts";
import { adsColdRange, adsHotRange, createAdsRunner, enqueueAdsJob, getAdsSyncConfig, shopToday, type AdsSyncConfig } from "./sync.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("Test tích hợp Ads chỉ chạy với DB local.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TZ = "Asia/Ho_Chi_Minh";
const T0 = new Date("2026-10-28T09:30:00Z"); // 16:30 VN, same day as the captured fixtures
let clock = T0;
const TAG = `ads2${Date.now()}`;
const shopIds: string[] = [];
let shopN = 0;
const CONFIG: AdsSyncConfig = { ...getAdsSyncConfig({}), autoSyncEnabled: true };

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
});

async function newShop(): Promise<{ id: string; ext: string }> {
  const ext = `${Date.now()}${++shopN}`;
  const { data, error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: ext, shop_name: `${TAG} shop ${shopN}`, currency: "VND", data_source: "live", region: "VN", is_active: true })
    .select("id")
    .single();
  if (error) throw error;
  shopIds.push(data.id);
  const { error: connError } = await db.from("shop_connections").insert({ shop_id: data.id, connection_status: "connected" });
  if (connError) throw connError;
  return { id: data.id, ext };
}

class CountingProvider implements ShopeeAdsProvider {
  readonly mode = "fixture" as const;
  readonly calls: Array<{ endpoint: string; ids: number; range?: AdsDateRange }> = [];
  inner: ShopeeAdsProvider;
  constructor(inner: ShopeeAdsProvider) {
    this.inner = inner;
  }
  async listProductLevelCampaignIds(ctx: AdsProviderContext, input: { offset: number; limit: number }) {
    this.calls.push({ endpoint: "campaign_id_list", ids: 0 });
    return this.inner.listProductLevelCampaignIds(ctx, input);
  }
  async getProductLevelCampaignSettings(ctx: AdsProviderContext, input: { campaignIds: readonly string[] }) {
    this.calls.push({ endpoint: "campaign_setting_info", ids: input.campaignIds.length });
    return this.inner.getProductLevelCampaignSettings(ctx, input);
  }
  async getProductCampaignDailyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; range: AdsDateRange }) {
    this.calls.push({ endpoint: "campaign_daily_performance", ids: input.campaignIds.length, range: input.range });
    return this.inner.getProductCampaignDailyPerformance(ctx, input);
  }
  async getAllCpcAdsDailyPerformance(ctx: AdsProviderContext, input: { range: AdsDateRange }) {
    this.calls.push({ endpoint: "shop_daily_performance", ids: 0, range: input.range });
    return this.inner.getAllCpcAdsDailyPerformance(ctx, input);
  }
}

const fixtures = loadAdsFixtures();
const fixtureProvider = new CountingProvider(new FixtureShopeeAdsProvider(fixtures));

function worker(onlyShops: string[], provider: ShopeeAdsProvider, opts: { maxRunningAds?: number; config?: Partial<AdsSyncConfig>; now?: () => Date; id?: string } = {}) {
  const config = { ...getSyncConfig(), shopAllowlist: onlyShops, globalWorkers: 10, maxRunningPerShop: 1, sliceTimeBudgetMs: 120_000, maxSliceApiCalls: 200 };
  return new SyncWorker({
    db,
    config,
    workerId: opts.id ?? `test-${TAG}`,
    syncTypes: ADS_SYNC_TYPES,
    classifyError: toJobFailure,
    now: opts.now ?? (() => clock),
    logger: () => {},
    maxRunningAds: opts.maxRunningAds ?? null,
    createRunner: (job, budget) => {
      const meter = new ApiCallMeter(budget);
      return { meter, runner: createAdsRunner(job, { db, provider: new MeteredShopeeAdsProvider(provider, meter), config: { ...CONFIG, ...(opts.config ?? {}) } }) };
    },
  });
}

async function drain(onlyShops: string[], provider: ShopeeAdsProvider, opts: Parameters<typeof worker>[2] = {}): Promise<SliceReport[]> {
  const w = worker(onlyShops, provider, opts);
  const out: SliceReport[] = [];
  for (let i = 0; i < 400; i++) {
    const r = await w.runOne(120_000);
    if (!r) break;
    out.push(r);
  }
  return out;
}

const tick = (shops: string[], now: Date, config: Partial<AdsSyncConfig> = {}) => runAdsSchedulerTick(db, { config: { ...CONFIG, ...config }, now, shopIds: shops });

async function jobs(shopId: string) {
  const { data, error } = await db.from("channel_sync_jobs").select("id, sync_type, status, priority, lane, mode, metadata, started_at, finished_at, created_at").eq("shop_id", shopId).order("created_at");
  if (error) throw error;
  return data ?? [];
}

async function count(table: string, shopId: string): Promise<number> {
  const { count: c, error } = await db.from(table).select("id", { count: "exact", head: true }).eq("shop_id", shopId);
  if (error) throw error;
  return c ?? 0;
}

let A = { id: "", ext: "" };

test("ADS_AUTO_SYNC_ENABLED=false (default): the scheduler enqueues nothing, even for an enabled shop", async () => {
  A = await newShop();
  await setAdsShopSyncEnabled(db, { shopId: A.id, enabled: true, syncSlot: 0 });
  const r = await tick([A.id], T0, { autoSyncEnabled: false });
  assert.equal(r.disabled, true);
  assert.equal((await jobs(A.id)).length, 0);
  // and a shop that is not enabled gets nothing with the global switch on
  const other = await newShop();
  const r2 = await tick([other.id], T0);
  assert.equal(r2.shops, 0);
  assert.equal((await jobs(other.id)).length, 0);
});

test("no-browser flow: tick → metadata + 30-day backfill + HOT; 15 min later HOT = TODAY only, 1 shop call + 1 campaign call (43 active of 143)", async () => {
  clock = T0;
  const first = await tick([A.id], T0);
  assert.deepEqual(first.enqueued.map((e) => `${e.kind}:${e.syncType}`).sort(), ["backfill:ads_campaign_performance_read", "backfill:ads_shop_performance_read", "hot_shop:ads_shop_performance_read", "metadata:ads_campaign_read"]);
  // at-least-once cron: the same minute again schedules nothing
  const dup = await tick([A.id], T0);
  assert.equal(dup.slotsClaimed, 0);
  assert.equal(dup.enqueued.length, 0);
  const queued = await jobs(A.id);
  // one stagger offset per shop and tick: all its jobs become claimable together, priority decides (metadata before backfill)
  const { data: due } = await db.from("channel_sync_jobs").select("next_attempt_at").eq("shop_id", A.id);
  assert.equal(new Set((due ?? []).map((d) => d.next_attempt_at)).size, 1, "same next_attempt_at for the shop's jobs of this tick");
  const jitter = Date.parse(due![0].next_attempt_at) - T0.getTime();
  assert.ok(jitter >= 0 && jitter <= 20_000, `jitter ${jitter} ms`);
  assert.deepEqual(queued.map((j) => [j.sync_type, j.lane, j.priority]).sort(), [
    ["ads_campaign_performance_read", "ads_backfill", 7],
    ["ads_campaign_read", "ads_meta", 2],
    ["ads_shop_performance_read", "ads_backfill", 7],
    ["ads_shop_performance_read", "ads_hot", 2],
  ]);
  const reports = await drain([A.id], fixtureProvider);
  assert.ok(reports.every((r) => r.status === "success" || r.status === "pending"), JSON.stringify(reports.map((r) => [r.syncType, r.status, r.errorCode])));
  assert.equal(await count("shopee_ads_campaigns", A.id), 143);
  assert.equal(await count("shopee_ads_shop_daily_performance", A.id), 31);
  assert.equal(await count("shopee_ads_campaign_daily_performance", A.id), 143 * 31);

  // 15 minutes later: nobody opened the dashboard
  clock = new Date(T0.getTime() + 15 * 60_000);
  const hot = await tick([A.id], clock);
  assert.deepEqual(hot.enqueued.map((e) => `${e.kind}:${e.syncType}`).sort(), ["hot_campaign:ads_campaign_performance_read", "hot_shop:ads_shop_performance_read"], "no metadata (6 h), no WARM (hourly), no COLD");
  fixtureProvider.calls.length = 0;
  const hotReports = await drain([A.id], fixtureProvider);
  assert.ok(hotReports.every((r) => r.status === "success"));
  assert.deepEqual(fixtureProvider.calls.map((c) => [c.endpoint, c.ids, c.range]), [
    ["shop_daily_performance", 0, { from: "2026-10-28", to: "2026-10-28" }],
    ["campaign_daily_performance", 43, { from: "2026-10-28", to: "2026-10-28" }],
  ]);
  const { data: today } = await db.from("shopee_ads_shop_daily_performance").select("last_synced_at").eq("shop_id", A.id).eq("report_date", "2026-10-28").single();
  assert.equal(Date.parse(today!.last_synced_at), clock.getTime(), "today's shop row refreshed by the background HOT read");
  const hotCampaign = (await jobs(A.id)).filter((j) => j.lane === "ads_hot" && j.sync_type === "ads_campaign_performance_read").at(-1)!;
  assert.deepEqual((hotCampaign.metadata as { campaignScope: unknown }).campaignScope, { scope: "hot", candidates: 43, known: 143, fallback: null, unsupported: 0 });
  // dashboard freshness reads the DB: fresh, auto sync on
  const d = await new RealAdsDashboardSource(db, { now: () => clock }).load(parseAdsFilters({ period: "today", shop: A.id }, clock));
  assert.equal(d.sync.state, "fresh");
  assert.equal(Date.parse(d.sync.lastSyncedAt!), clock.getTime());
  assert.equal(d.sync.autoSync?.enabled, true);
  assert.deepEqual(d.sync.details?.map((x) => [x.key, x.stale]), [["shop_today", false], ["campaign_today", false], ["metadata", false]]);
  // 40 minutes without a HOT read → stale (shop > 25 min, campaigns > 35 min)
  const later = await new RealAdsDashboardSource(db, { now: () => new Date(clock.getTime() + 40 * 60_000) }).load(parseAdsFilters({ period: "today", shop: A.id }, clock));
  assert.equal(later.sync.state, "stale");
});

test("HOT fallback: campaign metadata stale (> 8 h) → ALL known campaigns (3 batches of ≤ 50), accuracy over optimization", async () => {
  await db.from("channel_sync_states").update({ last_success_at: new Date(clock.getTime() - 9 * 3_600_000).toISOString() }).eq("shop_id", A.id).eq("sync_type", "ads_campaign_read");
  try {
    await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: 3, range: adsHotRange(clock, TZ), scope: "hot", now: clock });
    fixtureProvider.calls.length = 0;
    await drain([A.id], fixtureProvider);
    assert.deepEqual(fixtureProvider.calls.map((c) => c.ids), [50, 50, 43], "no per-campaign loop: 143 ids in 3 calls");
    const j = (await jobs(A.id)).filter((x) => x.lane === "ads_hot" && x.sync_type === "ads_campaign_performance_read").at(-1)!;
    assert.deepEqual((j.metadata as { campaignScope: unknown }).campaignScope, { scope: "hot", candidates: 143, known: 143, fallback: "metadata_stale", unsupported: 0 });
  } finally {
    await db.from("channel_sync_states").update({ last_success_at: clock.toISOString() }).eq("shop_id", A.id).eq("sync_type", "ads_campaign_read");
  }
});

test("coalescing: a covering job that is RUNNING or at least as urgent absorbs HOT (no new row); a queued COLD is never promoted; WARM never absorbs HOT", async () => {
  const hotRange = adsHotRange(clock, TZ);
  // queued manual refresh (prio 1, today, all campaigns) covers the HOT request
  const m = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "manual", priority: 1, range: hotRange, scope: "all", now: clock });
  const before = (await jobs(A.id)).length;
  const h = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: 3, range: hotRange, scope: "hot", now: clock });
  assert.deepEqual([h.created, h.coalesced, h.jobId, h.priority], [false, true, m.jobId, 1]);
  assert.equal((await jobs(A.id)).length, before, "no narrower duplicate");
  const again = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: 3, range: hotRange, scope: "hot", now: clock });
  assert.equal(again.jobId, m.jobId, "repeat request deduped");
  await drain([A.id], fixtureProvider);

  // a QUEUED COLD (prio 6) also covers today, but would drag 8 days × all campaigns to HOT priority → HOT gets its own job
  const cold = adsColdRange(clock, TZ, CONFIG);
  const c = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "cold", priority: 6, range: cold, scope: "all", now: clock });
  const h2 = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: 3, range: hotRange, scope: "hot", now: clock });
  assert.deepEqual([h2.created, h2.lane, h2.priority], [true, "ads_hot", 3]);
  const { data: coldRow } = await db.from("channel_sync_jobs").select("priority").eq("id", c.jobId).single();
  assert.equal(coldRow!.priority, 6, "COLD keeps its priority");
  await drain([A.id], fixtureProvider);

  // a RUNNING COLD covering today absorbs HOT (the shop cannot run a second campaign read meanwhile)
  const c2 = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "cold", priority: 6, range: cold, scope: "all", now: clock });
  const claimed = await claimNextSyncJob(db, `hold-${TAG}`, { maxRunning: 10, syncTypes: ["ads_campaign_performance_read"], shopIds: [A.id], maxPerShop: 1 });
  assert.equal(claimed?.id, c2.jobId);
  const h3 = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: 3, range: hotRange, scope: "hot", now: clock });
  assert.deepEqual([h3.created, h3.coalesced, h3.jobId], [false, true, c2.jobId]);
  await db.from("channel_sync_jobs").update({ locked_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("id", c2.jobId);
  await recoverStaleSyncJobs(db, 3);
  await drain([A.id], fixtureProvider);
  // WARM (completed days only) does not cover today → HOT gets its own job
  const warm = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_shop_performance_read", strategy: "warm", priority: 4, range: { from: "2026-10-25", to: "2026-10-27" }, now: clock });
  const hot = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: 2, range: adsHotRange(clock, TZ), now: clock });
  assert.notEqual(hot.jobId, warm.jobId);
  assert.equal(hot.created, true);
  await drain([A.id], fixtureProvider);
});

test("same-lane dedupe: a queued HOT from before midnight is WIDENED to cover the new day (one job, not two)", async () => {
  const y = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: 2, range: { from: "2026-10-27", to: "2026-10-27" }, now: clock });
  const t = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: 2, range: { from: "2026-10-28", to: "2026-10-28" }, now: clock });
  assert.equal(t.jobId, y.jobId);
  assert.equal(t.coalesced, true);
  const { data } = await db.from("channel_sync_jobs").select("metadata").eq("id", y.jobId).single();
  assert.deepEqual((data!.metadata as { adsRange: unknown }).adsRange, { from: "2026-10-27", to: "2026-10-28" });
  await drain([A.id], fixtureProvider);
});

test("priority: a HOT job created AFTER a COLD job is claimed first (COLD / backfill never delay current-day data)", async () => {
  const B = await newShop();
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_shop_performance_read", strategy: "cold", priority: 6, range: adsColdRange(clock, TZ, CONFIG), now: clock });
  await enqueueAdsJob(db, { shopId: B.id, syncType: "ads_shop_performance_read", strategy: "backfill", priority: 7, range: { from: "2026-09-28", to: "2026-10-28" }, now: clock });
  await enqueueAdsJob(db, { shopId: B.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: 2, range: adsHotRange(clock, TZ), now: clock });
  const reports = await drain([A.id, B.id], fixtureProvider);
  assert.deepEqual(reports.map((r) => [r.shopId === B.id ? "B" : "A", r.status]).slice(0, 3), [["B", "success"], ["A", "success"], ["B", "success"]], "HOT(B) → COLD(A) → backfill(B)");
  const hotJob = (await jobs(B.id)).find((j) => j.lane === "ads_hot")!;
  assert.equal(reports[0].jobId, hotJob.id);
});

test("large shop: 1000 campaigns = 20 batches, 3 per slice with checkpoint; a small shop's job runs between the slices; no duplicate rows", async () => {
  // real time here: the claim orders by DB timestamps (created_at / next_attempt_at)
  const realNow = () => new Date();
  const H = await newShop();
  const S = await newShop();
  const range = adsHotRange(new Date(), TZ);
  const sim = new SimulatedAdsProvider([{ externalShopId: H.ext, campaigns: 1000 }, { externalShopId: S.ext, campaigns: 50 }], { date: range.from });
  for (const s of [H, S]) await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_campaign_read", strategy: "metadata", priority: 5, now: realNow() });
  await drain([H.id, S.id], sim, { now: realNow });
  assert.equal(await count("shopee_ads_campaigns", H.id), 1000);
  const heavy = await enqueueAdsJob(db, { shopId: H.id, syncType: "ads_campaign_performance_read", strategy: "cold", priority: 6, range, scope: "all", now: realNow() });
  const small = await enqueueAdsJob(db, { shopId: S.id, syncType: "ads_campaign_performance_read", strategy: "cold", priority: 6, range, scope: "all", now: realNow() });
  sim.calls.length = 0;
  const reports = await drain([H.id, S.id], sim, { now: realNow });
  const seq = reports.map((r) => `${r.jobId === heavy.jobId ? "H" : r.jobId === small.jobId ? "S" : "?"}:${r.status}`);
  assert.deepEqual(seq, ["H:pending", "S:success", "H:pending", "H:pending", "H:pending", "H:pending", "H:pending", "H:success"]);
  assert.deepEqual(reports.map((r) => r.apiCalls), [3, 1, 3, 3, 3, 3, 3, 2], "checkpointed batches: 20 calls for 1000 ids, none repeated");
  assert.equal(sim.calls.filter((c) => c.shop === H.ext).length, 20);
  assert.ok(sim.calls.every((c) => c.ids <= 50));
  assert.equal(await count("shopee_ads_campaign_daily_performance", H.id), 1000, "one row per campaign/day");
});

test("ADS-2.1 multi-shop gaps: a performance job waits for the FIRST complete catalogue (no partial id list), no provider call", async () => {
  const realNow = () => new Date();
  const P = await newShop();
  const range = adsHotRange(new Date(), TZ);
  const sim = new SimulatedAdsProvider([{ externalShopId: P.ext, campaigns: 120 }], { date: range.from });
  // a catalogue written page by page but not finished yet (as during a sliced ads_campaign_read)
  const { error } = await db.from("shopee_ads_campaigns").insert({ shop_id: P.id, provider_campaign_id: "100000", campaign_name: "partial", provider_status: "ongoing", last_synced_at: new Date().toISOString() });
  if (error) throw error;
  await enqueueAdsJob(db, { shopId: P.id, syncType: "ads_campaign_performance_read", strategy: "backfill", priority: 7, range, scope: "all", now: realNow() });
  const r = await worker([P.id], sim, { now: realNow }).runOne(120_000);
  assert.equal(r?.status, "retry", "dependency pending → retry with backoff");
  assert.equal(sim.calls.length, 0);
});

test("ADS-2.1 multi-shop gaps: Shopee refuses one non-product-ads id → that id is dropped and remembered, the batch is re-read, the job succeeds; the backfill marker is set; > 1000 campaigns reach the dashboard", async () => {
  const realNow = () => new Date();
  const B = await newShop();
  const range = adsHotRange(new Date(), TZ);
  const REFUSED = "100007";
  class RefusingProvider extends SimulatedAdsProvider {
    async getProductCampaignDailyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; range: AdsDateRange }) {
      if (input.campaignIds.includes(REFUSED)) {
        this.calls.push({ shop: ctx.externalShopId, endpoint: "campaign_daily_performance", startedAt: Date.now(), ms: 0, ids: input.campaignIds.length });
        throw new ShopeeApiError({ apiPath: "/api/v2/ads/get_product_campaign_daily_performance", errorCode: "error_param", message: `Wrong parameters. campaign_id_list: has invalid product ads campaign ids- ${REFUSED};` });
      }
      return super.getProductCampaignDailyPerformance(ctx, input);
    }
  }
  const sim = new RefusingProvider([{ externalShopId: B.ext, campaigns: 1100, ongoingShare: 1 }], { date: range.from });
  await enqueueAdsJob(db, { shopId: B.id, syncType: "ads_campaign_read", strategy: "metadata", priority: 5, now: realNow() });
  await enqueueAdsJob(db, { shopId: B.id, syncType: "ads_shop_performance_read", strategy: "backfill", priority: 7, range, now: realNow() });
  const backfill = await enqueueAdsJob(db, { shopId: B.id, syncType: "ads_campaign_performance_read", strategy: "backfill", priority: 7, range, scope: "all", now: realNow() });
  await drain([B.id], sim, { now: realNow, config: { batchesPerSlice: 100 } });
  const job = (await jobs(B.id)).find((j) => j.id === backfill.jobId)!;
  assert.equal(job.status, "success", "one refused id must not fail the job");
  const perf = sim.calls.filter((c) => c.endpoint === "campaign_daily_performance");
  assert.equal(perf.length, 23, "22 batches + 1 refused attempt");
  assert.deepEqual((job.metadata as { unsupportedCampaignIds: string[] }).unsupportedCampaignIds, [REFUSED]);
  assert.equal(await count("shopee_ads_campaign_daily_performance", B.id), 1099);
  const { data: refused } = await db.from("shopee_ads_campaigns").select("provider_campaign_id").eq("shop_id", B.id).not("performance_unsupported_at", "is", null);
  assert.deepEqual(refused?.map((r) => r.provider_campaign_id), [REFUSED]);
  const { data: marks } = await db.from("shopee_ads_shop_settings").select("shop_backfill_completed_at, campaign_backfill_completed_at").eq("shop_id", B.id).single();
  assert.ok(marks?.shop_backfill_completed_at && marks.campaign_backfill_completed_at, "both backfill markers set");

  // later jobs never send the refused id again (no wasted call)
  sim.calls.length = 0;
  await enqueueAdsJob(db, { shopId: B.id, syncType: "ads_campaign_performance_read", strategy: "cold", priority: 6, range, scope: "all", now: realNow() });
  await drain([B.id], sim, { now: realNow, config: { batchesPerSlice: 100 } });
  assert.equal(sim.calls.filter((c) => c.endpoint === "campaign_daily_performance").length, 22);

  // dashboard: PostgREST caps a response at 1000 rows — every campaign must still be there
  const data = await new RealAdsDashboardSource(db, { now: realNow }).load(parseAdsFilters({ period: "today", shop: B.id }, new Date()));
  assert.equal(data.statusCounts.all, 1099 + 1, "1100 ongoing campaigns listed (the refused one is ongoing, without data)");
  const perCampaign = data.campaigns.find((c) => c.metrics.spend > 0)!.metrics.spend;
  const campaignSpend = data.campaigns.reduce((s, c) => s + c.metrics.spend, 0);
  assert.equal(campaignSpend, 1099 * perCampaign, "Σ campaigns covers all 1099 readable campaigns (not the first 1000 rows)");
  // the simulated shop total = every ongoing campaign (incl. the refused one, which Shopee still bills) + 1000 non-product spend
  assert.equal(data.overview.outsideProductCampaigns?.spend, data.overview.current.spend - campaignSpend);
  assert.equal(data.overview.outsideProductCampaigns?.spend, 1000 + perCampaign);
});

test("stale recovery: an interrupted HOT job (worker died) is recovered and finishes without duplicate rows", async () => {
  const before = await count("shopee_ads_campaign_daily_performance", A.id);
  const j = await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: 3, range: adsHotRange(clock, TZ), scope: "hot", now: clock });
  const claimed = await claimNextSyncJob(db, `dead-${TAG}`, { maxRunning: 10, syncTypes: ADS_SYNC_TYPES, shopIds: [A.id], maxPerShop: 1 });
  assert.equal(claimed?.id, j.jobId);
  await db.from("channel_sync_jobs").update({ locked_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("id", j.jobId);
  const recovered = await recoverStaleSyncJobs(db, 3);
  assert.ok(recovered.some((r) => r.jobId === j.jobId));
  const reports = await drain([A.id], fixtureProvider);
  assert.equal(reports.find((r) => r.jobId === j.jobId)?.status, "success");
  assert.equal(await count("shopee_ads_campaign_daily_performance", A.id), before);
});

test("metadata fast path: a performance answer naming an unknown campaign enqueues a metadata repair (prio 3) at once", async () => {
  class ExtraCampaign extends CountingProvider {
    async getProductCampaignDailyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; range: AdsDateRange }) {
      const p = await super.getProductCampaignDailyPerformance(ctx, input);
      const raw = structuredClone(p.raw) as { response: { campaign_list: Array<Record<string, unknown>> } };
      const extra = structuredClone(raw.response.campaign_list[0]);
      extra.campaign_id = 999999001;
      raw.response.campaign_list.push(extra);
      return { ...p, raw };
    }
  }
  const provider = new ExtraCampaign(new FixtureShopeeAdsProvider(fixtures));
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: 3, range: adsHotRange(clock, TZ), scope: "hot", now: clock });
  const w = worker([A.id], provider);
  const r = await w.runOne(120_000);
  assert.equal(r?.status, "success");
  assert.equal(r?.logStatus, "partial");
  const repair = (await jobs(A.id)).filter((j) => j.sync_type === "ads_campaign_read" && ["pending", "retry"].includes(j.status));
  assert.equal(repair.length, 1);
  assert.equal(repair[0].priority, 3);
  assert.equal((repair[0].metadata as { strategy: string }).strategy, "repair");
  await drain([A.id], fixtureProvider);
});

test("failure isolation: one shop's provider keeps failing, the other shops' HOT reads still succeed", async () => {
  const s1 = await newShop();
  const s2 = await newShop();
  const range = adsHotRange(new Date(), TZ);
  const sim = new SimulatedAdsProvider([{ externalShopId: s1.ext, campaigns: 10 }, { externalShopId: s2.ext, campaigns: 10 }], { date: range.from });
  sim.failing.set(s1.ext, new Error("simulated provider outage"));
  for (const s of [s1, s2]) await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: 2, range, now: new Date() });
  const w = worker([s1.id, s2.id], sim, { now: () => new Date() });
  const r1 = await w.runOne(120_000);
  const r2 = await w.runOne(120_000);
  const byShop = Object.fromEntries([r1!, r2!].map((r) => [r.shopId, r.status]));
  assert.equal(byShop[s1.id], "retry");
  assert.equal(byShop[s2.id], "success");
  await db.from("channel_sync_jobs").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("shop_id", s1.id).in("status", ["pending", "retry"]);
});

test("burst idle wait: a job due in ~2 s (stagger jitter) is processed in the same burst, not left for the next scheduler minute", async () => {
  const s = await newShop();
  const range = adsHotRange(new Date(), TZ);
  const sim = new SimulatedAdsProvider([{ externalShopId: s.ext, campaigns: 5 }], { date: range.from });
  await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: 2, range, notBefore: new Date(Date.now() + 2000), now: new Date() });
  const config = { ...getSyncConfig(), shopAllowlist: [s.id], globalWorkers: 10, maxRunningPerShop: 1, sliceTimeBudgetMs: 5_000 };
  const mk = (idleWaitMs: number) =>
    new SyncWorker({
      db, config, workerId: `idle-${TAG}`, syncTypes: ADS_SYNC_TYPES, classifyError: toJobFailure, logger: () => {}, idleWaitMs,
      createRunner: (job, budget) => {
        const meter = new ApiCallMeter(budget);
        return { meter, runner: createAdsRunner(job, { db, provider: new MeteredShopeeAdsProvider(sim, meter), config: CONFIG }) };
      },
    });
  const without = await mk(0).runBurst({ timeBudgetMs: 20_000 });
  assert.deepEqual([without.slices.length, without.stoppedBy], [0, "empty"], "default: stops on an empty queue");
  const t = Date.now();
  const withWait = await mk(22_000).runBurst({ timeBudgetMs: 20_000 });
  assert.equal(withWait.slices[0]?.status, "success");
  assert.ok(Date.now() - t < 10_000, "waited only for the due time");
});

test("page load: RealAdsDashboardSource reads the DB only — zero jobs created, zero provider calls (permanent regression)", async () => {
  const jobsBefore = (await jobs(A.id)).length;
  fixtureProvider.calls.length = 0;
  const source = new RealAdsDashboardSource(db, { now: () => clock });
  for (const period of ["today", "7d", "30d"]) await source.load(parseAdsFilters({ period, shop: A.id }, clock));
  await source.load(parseAdsFilters({ period: "7d" }, clock));
  assert.equal((await jobs(A.id)).length, jobsBefore);
  assert.equal(fixtureProvider.calls.length, 0);
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  for (const f of ["src/lib/channels/shopee/ads/real-source.ts", "src/app/(authenticated)/shopee/ads/page.tsx", "src/components/ads/ads-refresh.tsx"]) {
    const src = read(f).replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["enqueueAdsJob", "requestAdsRefresh", "runAdsSchedulerTick", "kickShopeeSyncWorker", "ShopeeAdsProvider", "createAdsRunner"]) {
      assert.ok(!src.includes(banned), `${f} must not reference ${banned}`);
    }
  }
});

test("5-shop load (143 / 50 / 300 / 1000 / 20 campaigns, 150 ms per call): Ads concurrency ≤ 2 even with 3 workers, ≤ 1 call per shop at a time, every HOT job before the COLD backlog", async () => {
  const sizes = [143, 50, 300, 1000, 20];
  const shops = [];
  for (let i = 0; i < sizes.length; i++) shops.push(await newShop());
  const realNow = () => new Date();
  const today = shopToday(new Date(), TZ);
  const sim = new SimulatedAdsProvider(shops.map((s, i) => ({ externalShopId: s.ext, campaigns: sizes[i] })), { date: today, latencyMs: 150 });
  const ids = shops.map((s) => s.id);
  // catalogue first (not measured)
  for (const s of shops) await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_campaign_read", strategy: "metadata", priority: 5, now: realNow() });
  await mapWithConcurrency([0, 1, 2], 3, (i) => drain(ids, sim, { maxRunningAds: 2, now: realNow, id: `load-${TAG}-${i}` }));
  // worst case: a COLD backlog for every shop is already queued when the HOT cycle of all five shops is due at once
  const range = { from: today, to: today };
  for (const s of shops) await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_campaign_performance_read", strategy: "cold", priority: 6, range: adsColdRange(new Date(), TZ, CONFIG), scope: "all", now: realNow() });
  const hotIds: string[] = [];
  for (const s of shops) {
    hotIds.push((await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: 2, range, now: realNow() })).jobId);
    hotIds.push((await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: 3, range, scope: "hot", now: realNow() })).jobId);
  }
  sim.calls.length = 0;
  sim.maxInFlight = 0;
  const started = Date.now();
  await mapWithConcurrency([0, 1, 2], 3, (i) => drain(ids, sim, { maxRunningAds: 2, now: realNow, id: `load-${TAG}-${i}` }));
  const total = Date.now() - started;
  const { data: rows } = await db.from("channel_sync_jobs").select("id, shop_id, lane, status, created_at, started_at, finished_at, metadata").in("shop_id", ids).neq("sync_type", "ads_campaign_read");
  const hot = (rows ?? []).filter((r) => hotIds.includes(r.id));
  const cold = (rows ?? []).filter((r) => r.lane === "ads_cold");
  assert.ok(hot.every((r) => r.status === "success") && cold.every((r) => r.status === "success"));
  assert.ok(sim.maxInFlight <= 2, `max Ads calls in flight ${sim.maxInFlight}`);
  // per shop: calls never overlap in time
  for (const s of shops) {
    const calls = sim.calls.filter((c) => c.shop === s.ext).sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].startedAt >= calls[i - 1].startedAt + calls[i - 1].ms - 5, `shop ${s.ext}: overlapping calls`);
  }
  const hotDone = Math.max(...hot.map((r) => Date.parse(r.finished_at)));
  const hotCalls = hot.reduce((a, r) => a + Object.values(((r.metadata as { apiCalls?: Record<string, number> }).apiCalls ?? {})).reduce((x, y) => x + y, 0), 0);
  const coldBefore = cold.filter((r) => Date.parse(r.started_at) < hotDone).length;
  const waits = hot.map((r) => Date.parse(r.started_at) - Date.parse(r.created_at)).sort((a, b) => a - b);
  console.log(JSON.stringify({ event: "ads_load_simulation", shops: sizes, hotJobs: hot.length, hotCalls, hotCycleMs: hotDone - started, totalMs: total, maxInFlight: sim.maxInFlight, coldStartedBeforeHotDone: coldBefore, hotQueueWaitP95Ms: waits[Math.floor(waits.length * 0.95) - 1] ?? waits.at(-1) }));
  assert.equal(hotCalls, 5 + [1, 1, 2, 6, 1].reduce((a, b) => a + b, 0), "HOT = 1 shop call + ⌈active/50⌉ campaign calls per shop");
  assert.ok(coldBefore <= 2, `COLD slices started while HOT work remained: ${coldBefore} (only when every remaining HOT job was blocked by its own shop)`);
  assert.ok(hotDone - started < 10 * 60_000, "HOT cycle well under 10 minutes");
});
