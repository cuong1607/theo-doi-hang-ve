// ============================================================
// SHOPEE-ADS-3A.1 — hourly TODAY sync against the LOCAL database:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/ads/ads-hourly.integration.test.ts
//
// scheduler (hourly in the HOT slot, ADS_HOURLY_SYNC_ENABLED + per-shop
// switch) → queue (priority below daily HOT) → hourly runners (GET only,
// ≤ 50 ids per call, current hour partial, future hours never stored) →
// hourly tables (idempotent upserts, multi-shop isolation) → dashboard
// intraday (DB only, zero provider calls / jobs on page load) → completed-day
// reconciliation with the daily facts → retention. Plus the 5-shop capacity
// measurement (daily HOT cycle with / without hourly).
// Test shops are created and deleted here (cascade); nothing else is touched.
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { getSyncConfig } from "../../core/sync-config.ts";
import { SyncWorker, type SliceReport } from "../../core/sync-worker.ts";
import { mapWithConcurrency } from "../../core/time-windows.ts";
import { ApiCallMeter } from "../sync-instrumentation.ts";
import { toJobFailure } from "../sync-errors.ts";
import { pruneRetention } from "../sync-service.ts";
import { parseAdsFilters } from "./filters.ts";
import { FixtureShopeeAdsProvider, loadAdsFixtures, MeteredShopeeAdsProvider, type AdsDateRange, type AdsProviderContext, type ShopeeAdsProvider } from "./provider.ts";
import { ADS_SYNC_TYPES } from "./read-only-policy.ts";
import { RealAdsDashboardSource } from "./real-source.ts";
import { loadAdsSyncOverview, runAdsSchedulerTick, setAdsShopHourlyEnabled, setAdsShopSyncEnabled } from "./schedule.ts";
import { SimulatedAdsProvider } from "./simulated-provider.test-util.ts";
import { ADS_PRIORITY, createAdsRunner, enqueueAdsJob, getAdsSyncConfig, requestAdsRefresh, shopToday, type AdsSyncConfig } from "./sync.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("Test tích hợp Ads chỉ chạy với DB local.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TZ = "Asia/Ho_Chi_Minh";
const T0 = new Date("2026-10-28T07:40:00Z"); // 14:40 VN on 28/10 — 27/10 (captured fixtures) is a completed day
let clock = T0;
const TAG = `ads3a${Date.now()}`;
const shopIds: string[] = [];
let shopN = 0;
const CONFIG: AdsSyncConfig = { ...getAdsSyncConfig({}), autoSyncEnabled: true, hourlySyncEnabled: true };

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
});

async function newShop(ext = `${Date.now()}${++shopN}`): Promise<{ id: string; ext: string }> {
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

/** Counts every provider call (endpoint + ids + date) — the page-load / no-per-campaign-loop evidence. */
class CountingProvider implements ShopeeAdsProvider {
  readonly mode = "fixture" as const;
  readonly calls: Array<{ endpoint: string; ids: number; date?: string; range?: AdsDateRange }> = [];
  readonly inner: ShopeeAdsProvider;
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
  async getAllCpcAdsHourlyPerformance(ctx: AdsProviderContext, input: { date: string }) {
    this.calls.push({ endpoint: "shop_hourly_performance", ids: 0, date: input.date });
    return this.inner.getAllCpcAdsHourlyPerformance(ctx, input);
  }
  async getProductCampaignHourlyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; date: string }) {
    this.calls.push({ endpoint: "campaign_hourly_performance", ids: input.campaignIds.length, date: input.date });
    return this.inner.getProductCampaignHourlyPerformance(ctx, input);
  }
}

// exact data: no replay of the captured day for other dates
const exact = { ...loadAdsFixtures(), replayHourly: false };
// "today" (28/10) gets the captured 27/10 hourly profile so the intraday path has data
const replay = loadAdsFixtures();

function worker(onlyShops: string[], provider: ShopeeAdsProvider, opts: { maxRunningAds?: number; now?: () => Date; id?: string } = {}) {
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
      return { meter, runner: createAdsRunner(job, { db, provider: new MeteredShopeeAdsProvider(provider, meter), config: CONFIG }) };
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

async function count(table: string, shopId: string, filter: Record<string, string | number> = {}): Promise<number> {
  let q = db.from(table).select("id", { count: "exact", head: true }).eq("shop_id", shopId);
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { count: c, error } = await q;
  if (error) throw error;
  return c ?? 0;
}

async function jobs(shopId: string) {
  const { data, error } = await db.from("channel_sync_jobs").select("id, sync_type, status, priority, lane, metadata, started_at, finished_at, created_at").eq("shop_id", shopId).order("created_at");
  if (error) throw error;
  return data ?? [];
}

/** Catalogue + daily facts of one date (manual reads, as the dashboard refresh would do). */
async function seedDaily(shopId: string, provider: ShopeeAdsProvider, date: string) {
  await enqueueAdsJob(db, { shopId, syncType: "ads_campaign_read", strategy: "manual", priority: 1, now: clock });
  await drain([shopId], provider);
  await enqueueAdsJob(db, { shopId, syncType: "ads_shop_performance_read", strategy: "manual", priority: 1, range: { from: date, to: date }, now: clock });
  await enqueueAdsJob(db, { shopId, syncType: "ads_campaign_performance_read", strategy: "manual", priority: 1, range: { from: date, to: date }, scope: "all", now: clock });
  await drain([shopId], provider);
}

const TODAY = shopToday(T0, TZ);
const YESTERDAY = "2026-10-27";
let A = { id: "", ext: "" };

test("16 / 67. shop hourly TODAY: GET, 00h–14h stored (future hours never), a second identical read keeps the row count; a changed current hour updates THE SAME row", async () => {
  A = await newShop();
  const provider = new CountingProvider(new FixtureShopeeAdsProvider(replay));
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_shop_hourly_read", strategy: "manual", priority: ADS_PRIORITY.manualHourly, range: { from: TODAY, to: TODAY }, now: clock });
  const [r] = await drain([A.id], provider);
  assert.equal(r.status, "success", r.errorMessage ?? "");
  assert.deepEqual(provider.calls, [{ endpoint: "shop_hourly_performance", ids: 0, date: TODAY }]);
  assert.equal(await count("shopee_ads_shop_hourly_performance", A.id), 15, "00h … 14h (14:40 VN)");
  const job = (await jobs(A.id)).at(-1)!;
  assert.equal((job.metadata as { stats?: Record<string, number> }).stats?.futureHours, 9, "Shopee answered 24 hours; 15h–23h were not stored");

  // idempotent: same read again → same rows
  clock = new Date(T0.getTime() + 10 * 60_000); // 14:50
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_shop_hourly_read", strategy: "manual", priority: ADS_PRIORITY.manualHourly, range: { from: TODAY, to: TODAY }, now: clock });
  await drain([A.id], provider);
  assert.equal(await count("shopee_ads_shop_hourly_performance", A.id), 15);

  // restatement of the running hour: same row, new values
  const bumped = new CountingProvider(new FixtureShopeeAdsProvider(replay, { shopHourly: (_d, row) => (row.hour === 14 ? { ...row, expense: Number(row.expense) + 777, clicks: Number(row.clicks) + 3 } : row) }));
  const { data: before } = await db.from("shopee_ads_shop_hourly_performance").select("id, expense, clicks").eq("shop_id", A.id).eq("report_date", TODAY).eq("report_hour", 14).single();
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_shop_hourly_read", strategy: "manual", priority: ADS_PRIORITY.manualHourly, range: { from: TODAY, to: TODAY }, now: clock });
  await drain([A.id], bumped);
  const { data: afterRow } = await db.from("shopee_ads_shop_hourly_performance").select("id, expense, clicks, last_synced_at").eq("shop_id", A.id).eq("report_date", TODAY).eq("report_hour", 14).single();
  assert.equal(afterRow!.id, before!.id, "same row");
  assert.equal(Number(afterRow!.expense), Number(before!.expense) + 777);
  assert.equal(Number(afterRow!.clicks), Number(before!.clicks) + 3);
  assert.equal(Date.parse(afterRow!.last_synced_at), clock.getTime());
  assert.equal(await count("shopee_ads_shop_hourly_performance", A.id), 15);
  clock = T0;
});

test("17 / 13. campaign hourly TODAY (HOT candidates): waits for the catalogue, then ≤ 50 ids per call — never one request per campaign", async () => {
  const provider = new CountingProvider(new FixtureShopeeAdsProvider(replay));
  // no catalogue yet → retry, no provider call
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_hourly_read", strategy: "hot", priority: ADS_PRIORITY.hotCampaignHourly, range: { from: TODAY, to: TODAY }, scope: "hot", now: clock });
  const [pending] = await drain([A.id], provider);
  assert.equal(pending.status, "retry");
  assert.equal(pending.errorCode, "ads_campaigns_pending");
  assert.equal(provider.calls.length, 0);
  await db.from("channel_sync_jobs").delete().eq("shop_id", A.id).eq("sync_type", "ads_campaign_hourly_read");

  await seedDaily(A.id, provider, TODAY);
  provider.calls.length = 0;
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_hourly_read", strategy: "hot", priority: ADS_PRIORITY.hotCampaignHourly, range: { from: TODAY, to: TODAY }, scope: "hot", now: clock });
  const reports = await drain([A.id], provider);
  assert.ok(reports.every((r) => r.status === "success"), JSON.stringify(reports.map((r) => [r.status, r.errorMessage])));
  const hourlyCalls = provider.calls.filter((c) => c.endpoint === "campaign_hourly_performance");
  assert.deepEqual(hourlyCalls.map((c) => c.ids), [43], "43 HOT candidates of 143 → ONE batched call");
  const job = (await jobs(A.id)).filter((j) => j.sync_type === "ads_campaign_hourly_read").at(-1)!;
  assert.deepEqual((job.metadata as { campaignScope: unknown }).campaignScope, { scope: "hot", candidates: 43, known: 143, fallback: null, unsupported: 0 });
  // campaign 900000040 has a captured hourly profile (replayed for today): 15 hours stored; zero-day campaigns 15 zero hours each
  const { data: c40 } = await db.from("shopee_ads_campaigns").select("id").eq("shop_id", A.id).eq("provider_campaign_id", "900000040").single();
  assert.equal(await count("shopee_ads_campaign_hourly_performance", A.id, { campaign_id: c40!.id }), 15);
  const rows = await count("shopee_ads_campaign_hourly_performance", A.id);
  assert.equal(rows % 15, 0, "only hours 00–14 for every stored campaign");
  // a re-read keeps the row count (unique campaign × date × hour)
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_hourly_read", strategy: "manual", priority: ADS_PRIORITY.manualHourly, range: { from: TODAY, to: TODAY }, scope: "hot", now: clock });
  await drain([A.id], provider);
  assert.equal(await count("shopee_ads_campaign_hourly_performance", A.id), rows);
});

test("68. multi-shop isolation: the same provider campaign ids / date / hour in two shops never collide", async () => {
  const B = await newShop();
  const provider = new CountingProvider(new FixtureShopeeAdsProvider(replay));
  await seedDaily(B.id, provider, TODAY);
  await enqueueAdsJob(db, { shopId: B.id, syncType: "ads_shop_hourly_read", strategy: "manual", priority: 2, range: { from: TODAY, to: TODAY }, now: clock });
  await enqueueAdsJob(db, { shopId: B.id, syncType: "ads_campaign_hourly_read", strategy: "manual", priority: 2, range: { from: TODAY, to: TODAY }, scope: "hot", now: clock });
  await drain([B.id], provider);
  assert.equal(await count("shopee_ads_shop_hourly_performance", B.id), 15);
  assert.equal(await count("shopee_ads_shop_hourly_performance", A.id), 15, "shop A untouched");
  assert.equal(await count("shopee_ads_campaign_hourly_performance", B.id), await count("shopee_ads_campaign_hourly_performance", A.id));
  const { data: c40 } = await db.from("shopee_ads_campaigns").select("id, shop_id").eq("provider_campaign_id", "900000040").in("shop_id", [A.id, B.id]);
  assert.equal(new Set((c40 ?? []).map((c) => c.id)).size, 2, "two campaigns, one per shop");
  // the composite FK refuses an hourly row pointing at another shop's campaign
  const foreign = (c40 ?? []).find((c) => c.shop_id === A.id)!;
  const { error } = await db.from("shopee_ads_campaign_hourly_performance").insert({ shop_id: B.id, campaign_id: foreign.id, report_date: TODAY, report_hour: 3, last_synced_at: clock.toISOString() });
  assert.ok(error, "cross-shop hourly row refused");
  // hour outside 0–23 refused by the table too
  const { error: hourError } = await db.from("shopee_ads_shop_hourly_performance").insert({ shop_id: B.id, report_date: "2026-10-20", report_hour: 24, last_synced_at: clock.toISOString() });
  assert.ok(hourError, "report_hour 24 refused");
  await db.from("shops").delete().eq("id", B.id);
});

test("71 / 36. finalize of a completed day (27/10, production fixtures): ALL campaigns, reconciliation = ROUNDING_DIFFERENCE (shop −1 đ, campaign −2 đ, counts / GMV exact)", async () => {
  const C = await newShop();
  const provider = new CountingProvider(new FixtureShopeeAdsProvider(exact));
  await seedDaily(C.id, provider, YESTERDAY);
  provider.calls.length = 0;
  await enqueueAdsJob(db, { shopId: C.id, syncType: "ads_shop_hourly_read", strategy: "finalize", priority: ADS_PRIORITY.hourlyFinalize, range: { from: YESTERDAY, to: YESTERDAY }, now: clock });
  await enqueueAdsJob(db, { shopId: C.id, syncType: "ads_campaign_hourly_read", strategy: "finalize", priority: ADS_PRIORITY.hourlyFinalize, range: { from: YESTERDAY, to: YESTERDAY }, scope: "all", now: clock });
  const reports = await drain([C.id], provider);
  assert.ok(reports.every((r) => r.status === "success" || r.status === "pending"), JSON.stringify(reports.map((r) => [r.syncType, r.status, r.errorMessage])));
  assert.deepEqual(provider.calls.filter((c) => c.endpoint === "campaign_hourly_performance").map((c) => c.ids), [50, 50, 43], "accuracy pass: every campaign, batched");
  assert.equal(await count("shopee_ads_shop_hourly_performance", C.id), 24, "a completed day: 24 hours");
  const finalize = (await jobs(C.id)).filter((j) => (j.metadata as { strategy?: string }).strategy === "finalize");
  assert.ok(finalize.every((j) => j.lane === "ads_warm"), "completed day → WARM lane (never today's freshness, never blocks HOT)");
  for (const j of finalize) {
    const rec = (j.metadata as { reconciliation?: Array<{ date: string; status: string; shopExpenseDelta: number }> }).reconciliation!;
    assert.deepEqual(rec.map((x) => [x.date, x.status, x.shopExpenseDelta]), [[YESTERDAY, "ROUNDING_DIFFERENCE", -1]]);
  }
  const { data: rpc } = await db.rpc("ads_dashboard_hourly_reconciliation", { p_shop_ids: [C.id], p_from: YESTERDAY, p_to: YESTERDAY });
  const row = (rpc ?? [])[0];
  assert.equal(Number(row.h_expense), 1104161);
  assert.equal(Number(row.d_expense), 1104162);
  assert.equal(Number(row.h_broad_gmv), Number(row.d_broad_gmv));
  assert.equal(Number(row.campaign_max_abs_expense_delta), 2, "campaign 900000040: 299,998 vs 300,000");
  assert.equal(row.campaigns_metric_mismatch, 0);
  // campaigns whose captured day was non-zero but have no hourly capture are not invented (only 101 compared)
  assert.equal(row.campaigns_compared, 101);
  await db.from("shops").delete().eq("id", C.id);
});

test("74 / 73 / 19. no browser: scheduler (hourly in the HOT slot) → worker → DB → dashboard intraday; opening the page = 0 provider calls, 0 jobs", async () => {
  const S = await newShop();
  await setAdsShopSyncEnabled(db, { shopId: S.id, enabled: true, syncSlot: 0 });
  const provider = new CountingProvider(new FixtureShopeeAdsProvider(replay));
  await seedDaily(S.id, provider, TODAY);
  await db.from("shopee_ads_shop_settings").update({ shop_backfill_completed_at: clock.toISOString(), campaign_backfill_completed_at: clock.toISOString(), last_metadata_slot_at: clock.toISOString(), last_warm_slot_at: clock.toISOString(), last_cold_slot_at: clock.toISOString() }).eq("shop_id", S.id);

  // global flag on, shop switch off → no hourly job
  const off = await runAdsSchedulerTick(db, { config: CONFIG, now: clock, shopIds: [S.id] });
  assert.ok(!off.enqueued.some((e) => e.kind.includes("hourly")));
  // shop switch on, global flag off → no hourly job
  await setAdsShopHourlyEnabled(db, { shopId: S.id, enabled: true });
  clock = new Date(T0.getTime() + 15 * 60_000);
  const globalOff = await runAdsSchedulerTick(db, { config: { ...CONFIG, hourlySyncEnabled: false }, now: clock, shopIds: [S.id] });
  assert.ok(!globalOff.enqueued.some((e) => e.kind.includes("hourly")));
  await drain([S.id], provider);

  clock = new Date(T0.getTime() + 30 * 60_000); // 15:10 VN
  const t = await runAdsSchedulerTick(db, { config: CONFIG, now: clock, shopIds: [S.id] });
  const kinds = t.enqueued.map((e) => `${e.kind}:${e.syncType}`).sort();
  assert.ok(kinds.includes("hot_hourly:ads_shop_hourly_read") && kinds.includes("hot_hourly:ads_campaign_hourly_read"), kinds.join(","));
  assert.ok(kinds.includes("hourly_finalize:ads_shop_hourly_read"), "first enable: yesterday finalized once");
  const queued = (await jobs(S.id)).filter((j) => ["pending", "retry"].includes(j.status));
  const pr = (type: string, strategy: string) => queued.find((j) => j.sync_type === type && (j.metadata as { strategy: string }).strategy === strategy)?.priority;
  assert.ok(pr("ads_shop_performance_read", "hot")! < pr("ads_shop_hourly_read", "hot")!, "daily HOT before hourly");
  assert.ok(pr("ads_campaign_performance_read", "hot")! < pr("ads_campaign_hourly_read", "hot")!);
  provider.calls.length = 0;
  const reports = await drain([S.id], provider);
  assert.ok(reports.every((r) => r.status === "success" || r.status === "pending"), JSON.stringify(reports.map((r) => [r.syncType, r.status, r.errorMessage])));
  // claim order: both daily HOT reads finished before the first hourly read started (WARM / COLD / finalize come after)
  const ran = (await jobs(S.id)).filter((j) => Date.parse(j.created_at) >= Date.parse(queued[0].created_at));
  const strategyOf = (j: { metadata: unknown }) => (j.metadata as { strategy: string }).strategy;
  const dailyHotDone = Math.max(...ran.filter((j) => strategyOf(j) === "hot" && !j.sync_type.includes("hourly")).map((j) => Date.parse(j.finished_at)));
  const firstHourlyStart = Math.min(...ran.filter((j) => j.sync_type.includes("hourly")).map((j) => Date.parse(j.started_at)));
  assert.ok(firstHourlyStart >= dailyHotDone, "daily HOT first");
  const coldStart = Math.min(...ran.filter((j) => j.lane === "ads_cold").map((j) => Date.parse(j.started_at)));
  const hotHourlyDone = Math.max(...ran.filter((j) => j.sync_type.includes("hourly") && strategyOf(j) === "hot").map((j) => Date.parse(j.finished_at)));
  assert.ok(coldStart >= hotHourlyDone, "COLD after hourly HOT");
  const hotHourlyCalls = provider.calls.filter((c) => c.endpoint.includes("hourly") && c.date === TODAY).length;
  assert.equal(hotHourlyCalls, 2, "≈ +2 calls per 15-minute cycle for a 143-campaign shop (1 shop + 1 batch of 43)");
  assert.equal(await count("shopee_ads_shop_hourly_performance", S.id, { report_date: TODAY }), 16, "00h … 15h");

  // the dashboard (DB only)
  const before = provider.calls.length;
  const jobsBefore = (await jobs(S.id)).length;
  let d = await new RealAdsDashboardSource(db, { now: () => clock }).load(parseAdsFilters({ period: "7d", shop: S.id }, clock));
  for (let i = 0; i < 4; i++) d = await new RealAdsDashboardSource(db, { now: () => clock }).load(parseAdsFilters({ period: "today", shop: S.id }, clock));
  assert.equal(provider.calls.length, before, "page load: 0 Shopee calls");
  assert.equal((await jobs(S.id)).length, jobsBefore, "page load: 0 jobs");
  const it = d.intraday!;
  assert.equal(it.status, "ok");
  assert.equal(it.currentHour, 15);
  assert.equal(it.hours.length, 16);
  assert.equal(it.hours.at(-1)!.state, "current");
  assert.equal(it.freshness.stale, false);
  assert.equal(it.reconciliation?.date, YESTERDAY);
  // TODAY KPI stays the DAILY shop fact (hourly is the breakdown)
  const { data: daily } = await db.from("shopee_ads_shop_daily_performance").select("expense").eq("shop_id", S.id).eq("report_date", TODAY).single();
  assert.equal(d.overview.current.spend, Number(daily!.expense));
  // admin overview: hourly enabled, last write, runs
  const ov = (await loadAdsSyncOverview(db, clock)).find((o) => o.shopId === S.id)!;
  assert.equal(ov.hourly.enabled, true);
  assert.ok(ov.hourly.lastSyncedAt);
  assert.ok(ov.hourly.runs >= 2 && ov.hourly.apiCalls >= 2);

  // 52. manual refresh: hourly follows the daily jobs, deduped when written < 5 min ago
  clock = new Date(clock.getTime() + 2 * 60_000);
  const recent = await requestAdsRefresh(db, { shopId: S.id, now: clock, config: CONFIG });
  assert.ok(!recent.jobs.some((j) => j.syncType.includes("hourly")), "hourly synced 2 min ago → no hourly job");
  clock = new Date(clock.getTime() + 10 * 60_000);
  const later = await requestAdsRefresh(db, { shopId: S.id, now: clock, config: CONFIG });
  const hourly = later.jobs.filter((j) => j.syncType.includes("hourly"));
  assert.deepEqual(hourly.map((j) => [j.syncType, j.poll]), [["ads_shop_hourly_read", false], ["ads_campaign_hourly_read", false]]);
  const { data: hj } = await db.from("channel_sync_jobs").select("priority").in("id", hourly.map((j) => j.jobId));
  assert.ok((hj ?? []).every((j) => j.priority === ADS_PRIORITY.manualHourly && j.priority > ADS_PRIORITY.manual));
  await db.from("shops").delete().eq("id", S.id);
  clock = T0;
});

test("21. daily HOT queue behind → the hourly slot waits (left unclaimed, retried by the next heartbeat)", async () => {
  const S = await newShop();
  await setAdsShopSyncEnabled(db, { shopId: S.id, enabled: true, syncSlot: 0 });
  await setAdsShopHourlyEnabled(db, { shopId: S.id, enabled: true });
  await db.from("shopee_ads_shop_settings").update({ shop_backfill_completed_at: clock.toISOString(), campaign_backfill_completed_at: clock.toISOString() }).eq("shop_id", S.id);
  // a daily HOT read from the previous slot is still pending
  await enqueueAdsJob(db, { shopId: S.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: 2, range: { from: TODAY, to: TODAY }, now: clock });
  await db.from("channel_sync_jobs").update({ created_at: new Date(clock.getTime() - 20 * 60_000).toISOString() }).eq("shop_id", S.id);
  const t = await runAdsSchedulerTick(db, { config: CONFIG, now: clock, shopIds: [S.id] });
  assert.ok(!t.enqueued.some((e) => e.kind === "hot_hourly"));
  assert.deepEqual(t.hourlyDeferred, [S.id]);
  const { data: s } = await db.from("shopee_ads_shop_settings").select("last_hot_hourly_slot_at").eq("shop_id", S.id).single();
  assert.equal(s!.last_hot_hourly_slot_at, null, "slot not consumed");
  await db.from("shops").delete().eq("id", S.id);
});

test("75. queue priority: daily HOT + hourly HOT + COLD queued together → daily HOT is claimed first, COLD last", async () => {
  const P = await newShop();
  const provider = new CountingProvider(new FixtureShopeeAdsProvider(replay));
  await seedDaily(P.id, provider, TODAY);
  const range = { from: TODAY, to: TODAY };
  // enqueue in the "wrong" order on purpose
  await enqueueAdsJob(db, { shopId: P.id, syncType: "ads_shop_performance_read", strategy: "cold", priority: ADS_PRIORITY.cold, range: { from: "2026-10-21", to: TODAY }, now: clock });
  await enqueueAdsJob(db, { shopId: P.id, syncType: "ads_shop_hourly_read", strategy: "hot", priority: ADS_PRIORITY.hotShopHourly, range, now: clock });
  await enqueueAdsJob(db, { shopId: P.id, syncType: "ads_campaign_hourly_read", strategy: "hot", priority: ADS_PRIORITY.hotCampaignHourly, range, scope: "hot", now: clock });
  await enqueueAdsJob(db, { shopId: P.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: ADS_PRIORITY.hotCampaign, range, scope: "hot", now: clock });
  await enqueueAdsJob(db, { shopId: P.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: ADS_PRIORITY.hotShop, range, now: clock });
  const order = (await drain([P.id], provider)).map((r) => `${r.syncType}`);
  assert.deepEqual(order, ["ads_shop_performance_read", "ads_campaign_performance_read", "ads_shop_hourly_read", "ads_campaign_hourly_read", "ads_shop_performance_read"]);
  const cold = (await jobs(P.id)).find((j) => j.lane === "ads_cold")!;
  const hourlyDone = Math.max(...(await jobs(P.id)).filter((j) => j.sync_type.includes("hourly")).map((j) => Date.parse(j.finished_at)));
  assert.ok(Date.parse(cold.started_at) >= hourlyDone, "COLD after hourly");
  await db.from("shops").delete().eq("id", P.id);
});

test("39. retention: hourly rows older than ADS_HOURLY_RETENTION_DAYS are pruned by the existing retention run; today / recent rows kept", async () => {
  const R = await newShop();
  const today = shopToday(new Date(), TZ);
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const rows = [0, 1, 13, 15, 40].map((n) => ({ shop_id: R.id, report_date: day(n), report_hour: 5, last_synced_at: new Date().toISOString() }));
  const { error } = await db.from("shopee_ads_shop_hourly_performance").insert(rows);
  assert.ifError(error);
  const r = await pruneRetention(db, getSyncConfig({}), 14);
  assert.equal(r.error, null);
  assert.ok(r.adsHourly >= 2);
  const { data: left } = await db.from("shopee_ads_shop_hourly_performance").select("report_date").eq("shop_id", R.id).order("report_date");
  assert.deepEqual((left ?? []).map((x) => x.report_date), [day(13), day(1), day(0)]);
  // a retention below 2 days is clamped: yesterday / today are never deleted
  await pruneRetention(db, getSyncConfig({}), 0);
  assert.deepEqual(((await db.from("shopee_ads_shop_hourly_performance").select("report_date").eq("shop_id", R.id).order("report_date")).data ?? []).map((x) => x.report_date), [day(1), day(0)]);
  await db.from("shops").delete().eq("id", R.id);
});

test("76. capacity — current 5-shop profile (143 / 108 / 246 / 1135 / 294 campaigns, 30% ongoing), concurrency unchanged (2): daily HOT cycle before vs after hourly", async () => {
  const sizes = [143, 108, 246, 1135, 294];
  const LATENCY = 60;
  const shops = [];
  for (let i = 0; i < sizes.length; i++) shops.push(await newShop());
  const realNow = () => new Date();
  const today = shopToday(new Date(), TZ);
  const sim = new SimulatedAdsProvider(shops.map((s, i) => ({ externalShopId: s.ext, campaigns: sizes[i], ongoingShare: 0.3 })), { date: today, latencyMs: LATENCY });
  const ids = shops.map((s) => s.id);
  for (const s of shops) await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_campaign_read", strategy: "metadata", priority: 7, now: realNow() });
  await mapWithConcurrency([0, 1, 2], 3, (i) => drain(ids, sim, { maxRunningAds: 2, now: realNow, id: `cap-${TAG}-${i}` }));
  const range = { from: today, to: today };

  async function cycle(withHourly: boolean) {
    const hotIds: string[] = [];
    const hourlyIds: string[] = [];
    for (const s of shops) {
      hotIds.push((await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: ADS_PRIORITY.hotShop, range, now: realNow() })).jobId);
      hotIds.push((await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: ADS_PRIORITY.hotCampaign, range, scope: "hot", now: realNow() })).jobId);
      if (withHourly) {
        hourlyIds.push((await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_shop_hourly_read", strategy: "hot", priority: ADS_PRIORITY.hotShopHourly, range, now: realNow() })).jobId);
        hourlyIds.push((await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_campaign_hourly_read", strategy: "hot", priority: ADS_PRIORITY.hotCampaignHourly, range, scope: "hot", now: realNow() })).jobId);
      }
    }
    sim.calls.length = 0;
    sim.maxInFlight = 0;
    const started = Date.now();
    await mapWithConcurrency([0, 1, 2], 3, (i) => drain(ids, sim, { maxRunningAds: 2, now: realNow, id: `cap-${TAG}-${i}` }));
    const { data: rows } = await db.from("channel_sync_jobs").select("id, status, started_at, finished_at, metadata").in("id", [...hotIds, ...hourlyIds]);
    const pick = (list: string[]) => (rows ?? []).filter((r) => list.includes(r.id));
    const calls = (list: string[]) => pick(list).reduce((a, r) => a + Object.values((r.metadata as { apiCalls?: Record<string, number> }).apiCalls ?? {}).reduce((x, y) => x + y, 0), 0);
    assert.ok((rows ?? []).every((r) => r.status === "success"), JSON.stringify((rows ?? []).map((r) => r.status)));
    const hotDone = Math.max(...pick(hotIds).map((r) => Date.parse(r.finished_at)));
    const hourlyDone = hourlyIds.length ? Math.max(...pick(hourlyIds).map((r) => Date.parse(r.finished_at))) : null;
    const hourlyStartedBeforeHotDone = pick(hourlyIds).filter((r) => Date.parse(r.started_at) < hotDone).length;
    return { dailyCalls: calls(hotIds), hourlyCalls: calls(hourlyIds), dailyCycleMs: hotDone - started, totalMs: (hourlyDone ?? hotDone) - started, maxInFlight: sim.maxInFlight, hourlyStartedBeforeHotDone };
  }

  const before = await cycle(false);
  const afterCycle = await cycle(true);
  // production latency ≈ 330 ms per call (ADS-1A), 2 calls in flight
  const prod = (c: number) => Math.round((c * 330) / 2 / 1000);
  const report = {
    event: "ads_hourly_capacity",
    shops: sizes,
    simulatedLatencyMs: LATENCY,
    dailyHotCalls: afterCycle.dailyCalls,
    hourlyHotCalls: afterCycle.hourlyCalls,
    totalCalls: afterCycle.dailyCalls + afterCycle.hourlyCalls,
    dailyCycleMsBefore: before.dailyCycleMs,
    dailyCycleMsAfter: afterCycle.dailyCycleMs,
    fullCycleMsAfter: afterCycle.totalMs,
    estProdSecondsDailyOnly: prod(before.dailyCalls),
    estProdSecondsWithHourly: prod(afterCycle.dailyCalls + afterCycle.hourlyCalls),
    maxInFlight: afterCycle.maxInFlight,
    hourlyStartedBeforeDailyDone: afterCycle.hourlyStartedBeforeHotDone,
  };
  console.log(JSON.stringify(report));
  assert.equal(before.dailyCalls, afterCycle.dailyCalls, "hourly adds calls, never changes the daily ones");
  assert.ok(afterCycle.maxInFlight <= 2, "concurrency unchanged");
  // with priorities below daily HOT and 2 slots, at most the slot freed by the last daily job's shop may start an hourly job early
  assert.ok(afterCycle.dailyCycleMs <= before.dailyCycleMs * 1.5 + 4 * LATENCY, `daily HOT cycle ${before.dailyCycleMs} → ${afterCycle.dailyCycleMs} ms`);
  assert.ok(prod(afterCycle.dailyCalls + afterCycle.hourlyCalls) < 15 * 60, "whole cycle far below the 15-minute window");
  for (const s of shops) await db.from("shops").delete().eq("id", s.id);
});
