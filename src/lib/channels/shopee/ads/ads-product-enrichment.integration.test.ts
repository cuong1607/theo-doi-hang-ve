// ============================================================
// SHOPEE-ADS-3A.2 — product enrichment against the LOCAL database:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/ads/ads-product-enrichment.integration.test.ts
//
// need-set = items referenced by Ads campaigns only → enrichment job (lowest
// performance-free priority, metadata lane, ≤ 50 ids per GET) →
// shopee_ads_products (cache: idempotent, renames update the same row,
// absent items never deleted, multi-shop isolation) → TTL / cache hits →
// scheduler need check → new-item fast path → dashboard campaign rows
// (names / images / SKU from one RPC; placeholders before enrichment; zero
// provider calls / jobs on page load) → failure isolation.
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
import { parseAdsFilters, queryCampaigns, parseAdsTableQuery } from "./filters.ts";
import { FixtureShopeeAdsProvider, loadAdsFixtures, MeteredShopeeAdsProvider, type AdsDateRange, type AdsFixtureData, type AdsProviderContext, type ShopeeAdsProvider } from "./provider.ts";
import { ADS_SYNC_TYPES } from "./read-only-policy.ts";
import { RealAdsDashboardSource } from "./real-source.ts";
import { SimulatedAdsProvider } from "./simulated-provider.test-util.ts";
import { loadAdsSyncOverview, runAdsSchedulerTick, setAdsShopProductEnrichmentEnabled, setAdsShopSyncEnabled } from "./schedule.ts";
import { ADS_PRIORITY, createAdsRunner, enqueueAdsJob, getAdsSyncConfig, maybeEnqueueAdsProductEnrichment, requestAdsRefresh, shopToday, type AdsSyncConfig } from "./sync.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("Test tích hợp Ads chỉ chạy với DB local.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TZ = "Asia/Ho_Chi_Minh";
const T0 = new Date("2026-10-28T07:40:00Z");
let clock = T0;
const TAG = `ads3a2${Date.now()}`;
const shopIds: string[] = [];
let shopN = 0;
const ON: AdsSyncConfig = { ...getAdsSyncConfig({}), autoSyncEnabled: true, productEnrichmentEnabled: true };
let CONFIG: AdsSyncConfig = ON;

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

/** Counts every provider call; can fail the product endpoint (failure isolation). */
class CountingProvider implements ShopeeAdsProvider {
  readonly mode = "fixture" as const;
  readonly calls: Array<{ endpoint: string; ids: number }> = [];
  inner: ShopeeAdsProvider;
  failItems: Error | null = null;
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
    this.calls.push({ endpoint: "campaign_daily_performance", ids: input.campaignIds.length });
    return this.inner.getProductCampaignDailyPerformance(ctx, input);
  }
  async getAllCpcAdsDailyPerformance(ctx: AdsProviderContext, input: { range: AdsDateRange }) {
    this.calls.push({ endpoint: "shop_daily_performance", ids: 0 });
    return this.inner.getAllCpcAdsDailyPerformance(ctx, input);
  }
  async getAllCpcAdsHourlyPerformance(ctx: AdsProviderContext, input: { date: string }) {
    this.calls.push({ endpoint: "shop_hourly_performance", ids: 0 });
    return this.inner.getAllCpcAdsHourlyPerformance(ctx, input);
  }
  async getProductCampaignHourlyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; date: string }) {
    this.calls.push({ endpoint: "campaign_hourly_performance", ids: input.campaignIds.length });
    return this.inner.getProductCampaignHourlyPerformance(ctx, input);
  }
  async getItemBaseInfo(ctx: AdsProviderContext, input: { itemIds: readonly string[] }) {
    this.calls.push({ endpoint: "item_base_info", ids: input.itemIds.length });
    if (this.failItems) throw this.failItems;
    return this.inner.getItemBaseInfo(ctx, input);
  }
}

const fixtures = loadAdsFixtures();
const itemCalls = (p: CountingProvider) => p.calls.filter((c) => c.endpoint === "item_base_info").map((c) => c.ids);

function worker(onlyShops: string[], provider: ShopeeAdsProvider) {
  const config = { ...getSyncConfig(), shopAllowlist: onlyShops, globalWorkers: 10, maxRunningPerShop: 1, sliceTimeBudgetMs: 120_000, maxSliceApiCalls: 200 };
  return new SyncWorker({
    db,
    config,
    workerId: `test-${TAG}`,
    syncTypes: ADS_SYNC_TYPES,
    classifyError: toJobFailure,
    now: () => clock,
    logger: () => {},
    maxRunningAds: null,
    createRunner: (job, budget) => {
      const meter = new ApiCallMeter(budget);
      return { meter, runner: createAdsRunner(job, { db, provider: new MeteredShopeeAdsProvider(provider, meter), config: CONFIG }) };
    },
  });
}

async function drain(onlyShops: string[], provider: ShopeeAdsProvider, max = 400): Promise<SliceReport[]> {
  const w = worker(onlyShops, provider);
  const out: SliceReport[] = [];
  for (let i = 0; i < max; i++) {
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

const TODAY = shopToday(T0, TZ);

async function seed(shopId: string, provider: ShopeeAdsProvider) {
  await enqueueAdsJob(db, { shopId, syncType: "ads_campaign_read", strategy: "manual", priority: 1, now: clock });
  await drain([shopId], provider);
  await enqueueAdsJob(db, { shopId, syncType: "ads_campaign_performance_read", strategy: "manual", priority: 1, range: { from: "2026-10-27", to: TODAY }, scope: "all", now: clock });
  await drain([shopId], provider);
}

async function dashboard(shopId: string) {
  return new RealAdsDashboardSource(db, { now: () => clock }).load(parseAdsFilters({ period: "7d", shop: shopId }, clock));
}

let A = { id: "", ext: "" };
const provider = new CountingProvider(new FixtureShopeeAdsProvider(fixtures));

test("72 / 22 / 54 / 71. before any enrichment: campaign rows show the neutral placeholder (real mode never uses fixture names); opening the page = 0 provider calls, 0 jobs", async () => {
  A = await newShop();
  CONFIG = { ...ON, productEnrichmentEnabled: false };
  await seed(A.id, provider);
  assert.equal(await count("shopee_ads_campaign_products", A.id), 143);
  const { data: distinct } = await db.rpc("ads_product_enrichment_summary", { p_shop_ids: [A.id], p_stale_before: clock.toISOString() });
  assert.equal(distinct![0].referenced, 101, "143 campaigns advertise 101 distinct items (29 shared)");
  assert.equal(await count("channel_sync_jobs", A.id, { sync_type: "ads_product_enrichment_read" }), 0, "flag OFF → the catalogue read never enqueues enrichment");

  provider.calls.length = 0;
  const jobsBefore = (await jobs(A.id)).length;
  const d = await dashboard(A.id);
  assert.equal(provider.calls.length, 0, "page load: zero provider calls");
  assert.equal((await jobs(A.id)).length, jobsBefore, "page load: zero jobs");
  assert.ok(d.campaigns.length > 0);
  for (const c of d.campaigns) {
    const p = c.topProducts[0];
    assert.equal(p.enrichment, "pending");
    assert.equal(p.name, `Sản phẩm Shopee #${p.itemId}`, "placeholder, never blank, never a fixture name");
    assert.equal(p.imageUrl, null);
    assert.equal(p.sku, null);
  }
});

test("5 / 17 / 20 / 46. enqueue only when needed: global flag OFF or shop switch OFF → no job; ON → one job; fresh cache → no job", async () => {
  CONFIG = { ...ON, productEnrichmentEnabled: false };
  assert.equal(await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: CONFIG }), null, "global flag off");
  CONFIG = ON;
  assert.equal(await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: CONFIG }), null, "shop switch off");
  await setAdsShopProductEnrichmentEnabled(db, { shopId: A.id, enabled: true });
  const first = await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: CONFIG });
  assert.ok(first?.created);
  const dup = await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: CONFIG });
  assert.equal(dup?.jobId, first!.jobId, "42. dedupe: the queued job already covers the shop");
  assert.equal(dup?.created, false);
  const j = (await jobs(A.id)).find((x) => x.id === first!.jobId)!;
  assert.equal(j.lane, "ads_meta");
  assert.equal(j.priority, ADS_PRIORITY.productEnrichment);
});

test("2 / 4 / 13 / 43 / 44 / 48. initial enrichment: only the 101 referenced items, deduplicated, 3 batched GETs (50 + 50 + 1); names / images / SKU stored; cache hit rate 0 → 1", async () => {
  provider.calls.length = 0;
  const reports = await drain([A.id], provider);
  assert.ok(reports.every((r) => r.status === "success" || r.status === "pending"), JSON.stringify(reports.map((r) => [r.syncType, r.status, r.errorMessage])));
  assert.deepEqual(itemCalls(provider), [50, 50, 1], "≤ 50 ids per call, never one request per product");
  assert.deepEqual([...new Set(provider.calls.map((c) => c.endpoint))], ["item_base_info"], "no catalogue scan, no other endpoint");
  assert.equal(await count("shopee_ads_products", A.id), 101);
  assert.equal(await count("shopee_ads_products", A.id, { enrichment_status: "enriched" }), 101);
  const job = (await jobs(A.id)).filter((x) => x.sync_type === "ads_product_enrichment_read").at(-1)!;
  const meta = job.metadata as { productScope: Record<string, unknown>; stats: Record<string, number>; apiCalls: Record<string, number> };
  assert.deepEqual(meta.productScope, { scope: "stale", referenced: 101, candidates: 101, missing: 101, stale: 0, cacheHits: 0, cacheHitRate: 0, ttlHours: 24 });
  assert.equal(meta.stats.itemsRequested, 101);
  assert.equal(meta.stats.itemsReturned, 101);
  assert.equal(meta.apiCalls["/api/v2/product/get_item_base_info"], 3);
  // raw snapshot reused (channel_api_snapshots, entity 'ads'), projected — no description / attributes
  const { data: snaps } = await db.from("channel_api_snapshots").select("payload").eq("shop_id", A.id).eq("api_name", "/api/v2/product/get_item_base_info");
  assert.equal(snaps!.length, 3);
  assert.ok(JSON.stringify(snaps).includes("item_name") && !JSON.stringify(snaps).includes("description"));

  // 24 / 25 / 26: the dashboard reads names / images / SKU in the same campaign RPC
  const d = await dashboard(A.id);
  const p = d.campaigns.map((c) => c.topProducts[0]);
  assert.ok(p.every((x) => x.enrichment === "enriched" && /^Item #\d+$/.test(x.name)));
  assert.ok(p.every((x) => x.imageUrl?.startsWith("https://cf.shopee.vn/file/")));
  assert.ok(p.some((x) => x.sku) && p.some((x) => !x.sku), "SKU only where Shopee has one");
  assert.ok(p.some((x) => x.providerStatus === "UNLIST") || p.some((x) => x.providerStatus === "SELLER_DELETE") || p.every((x) => x.providerStatus === "NORMAL"));

  // 8 / 20 / 68: fresh cache → no job, no provider call
  provider.calls.length = 0;
  assert.equal(await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: CONFIG }), null);
  assert.equal(provider.calls.length, 0);
});

test("63 / 67 / 38. idempotent + rename: an admin re-read keeps 101 rows (same ids); a renamed product updates THE SAME row and the campaign row shows the new name", async () => {
  const { data: before } = await db.from("shopee_ads_products").select("id, provider_item_id, product_name").eq("shop_id", A.id);
  const listedItem = (await dashboard(A.id)).campaigns[0].topProducts[0].itemId;
  const target = before!.find((r) => r.provider_item_id === listedItem)!;
  provider.inner = new FixtureShopeeAdsProvider(fixtures, { item: (id, row) => (id === target.provider_item_id ? { ...row, item_name: "Thảm lông cừu (đổi tên)" } : row) });
  clock = new Date(T0.getTime() + 60_000);
  const r = await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: CONFIG, scope: "all" });
  assert.ok(r?.created, "force scope = every referenced item");
  provider.calls.length = 0;
  await drain([A.id], provider);
  assert.deepEqual(itemCalls(provider), [50, 50, 1]);
  const { data: afterRows } = await db.from("shopee_ads_products").select("id, provider_item_id, product_name, last_checked_at").eq("shop_id", A.id);
  assert.equal(afterRows!.length, 101);
  assert.deepEqual(afterRows!.map((x) => x.id).sort(), before!.map((x) => x.id).sort(), "same rows");
  const renamed = afterRows!.find((x) => x.id === target.id)!;
  assert.equal(renamed.product_name, "Thảm lông cừu (đổi tên)");
  assert.equal(Date.parse(renamed.last_checked_at), clock.getTime());
  const job = (await jobs(A.id)).filter((x) => x.sync_type === "ads_product_enrichment_read").at(-1)!;
  assert.equal((job.metadata as { stats: Record<string, number> }).stats.productsRenamed, 1);
  const d = await dashboard(A.id);
  const rows = d.campaigns.filter((c) => c.topProducts.some((x) => x.itemId === target.provider_item_id));
  assert.ok(rows.length > 0 && rows.every((c) => c.topProducts[0].name === "Thảm lông cừu (đổi tên)"), "historical facts unchanged, current name shown");
  // 74: search by the new product name, accents folded
  const table = parseAdsTableQuery({ q: "THAM LONG CUU (doi ten" });
  assert.equal(queryCampaigns(d.campaigns, table).total, rows.length);
});

test("66 / 37 / 21. provider returns no metadata for an item: campaign stays usable, earlier metadata kept, row marked not_returned (never deleted); an item never seen shows the placeholder", async () => {
  const { data: known } = await db.from("shopee_ads_products").select("provider_item_id, product_name").eq("shop_id", A.id).eq("product_name", "Item #3").single();
  // a brand-new item nobody has read yet, attached to an existing campaign
  const { data: camp } = await db.from("shopee_ads_campaigns").select("id").eq("shop_id", A.id).limit(1).single();
  await db.from("shopee_ads_campaign_products").insert({ shop_id: A.id, campaign_id: camp!.id, provider_item_id: "123456789" });
  provider.inner = new FixtureShopeeAdsProvider(fixtures, { item: (id, row) => (id === known!.provider_item_id ? null : row) });
  clock = new Date(T0.getTime() + 2 * 60_000);
  await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: CONFIG, scope: "all" });
  const reports = await drain([A.id], provider);
  assert.ok(reports.every((r) => r.status === "success"), JSON.stringify(reports.map((r) => [r.status, r.errorMessage])));
  const { data: gone } = await db.from("shopee_ads_products").select("product_name, enrichment_status, image_url").eq("shop_id", A.id).eq("provider_item_id", known!.provider_item_id).single();
  assert.deepEqual([gone!.product_name, gone!.enrichment_status], ["Item #3", "not_returned"], "metadata of the earlier read kept");
  const { data: fresh } = await db.from("shopee_ads_products").select("product_name, enrichment_status").eq("shop_id", A.id).eq("provider_item_id", "123456789").single();
  assert.deepEqual(fresh, { product_name: null, enrichment_status: "not_returned" });
  const d = await dashboard(A.id);
  const row = d.campaigns.find((c) => c.id === camp!.id);
  if (row) {
    const p = row.topProducts.find((x) => x.itemId === "123456789")!;
    assert.equal(p.name, "Sản phẩm Shopee #123456789");
    assert.equal(p.enrichment, "not_returned");
  }
  await db.from("shopee_ads_campaign_products").delete().eq("shop_id", A.id).eq("provider_item_id", "123456789");
  provider.inner = new FixtureShopeeAdsProvider(fixtures);
});

test("69 / 18. TTL: metadata older than ADS_PRODUCT_ENRICHMENT_TTL_HOURS becomes eligible again; a shorter TTL never re-reads a just-read item", async () => {
  clock = new Date(T0.getTime() + 25 * 3_600_000);
  const { data: s } = await db.rpc("ads_product_enrichment_summary", { p_shop_ids: [A.id], p_stale_before: new Date(clock.getTime() - 24 * 3_600_000).toISOString() });
  assert.equal(s![0].stale, 101);
  const r = await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: CONFIG });
  assert.ok(r?.created);
  provider.calls.length = 0;
  await drain([A.id], provider);
  assert.deepEqual(itemCalls(provider), [50, 50, 1]);
  const job = (await jobs(A.id)).filter((x) => x.sync_type === "ads_product_enrichment_read").at(-1)!;
  assert.equal((job.metadata as { productScope: { stale: number } }).productScope.stale, 101);
  // just refreshed → nothing due, even with a 1-hour TTL
  assert.equal(await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: { ...CONFIG, productEnrichmentTtlHours: 1 } }), null);
});

test("64 / 30. multi-shop: the same provider item ids in another shop are separate rows; an update in one shop never touches the other", async () => {
  const B = await newShop();
  const aRows = await count("shopee_ads_products", A.id);
  await seed(B.id, provider);
  await setAdsShopProductEnrichmentEnabled(db, { shopId: B.id, enabled: true });
  provider.inner = new FixtureShopeeAdsProvider(fixtures, { item: (_id, row) => ({ ...row, item_name: `B ${row.item_name}` }) });
  await maybeEnqueueAdsProductEnrichment(db, { shopId: B.id, now: clock, config: CONFIG });
  await drain([B.id], provider);
  provider.inner = new FixtureShopeeAdsProvider(fixtures);
  assert.equal(await count("shopee_ads_products", B.id), 101);
  assert.equal(await count("shopee_ads_products", A.id), aRows, "shop A row count unchanged");
  const { data: a } = await db.from("shopee_ads_products").select("product_name").eq("shop_id", A.id).like("product_name", "B %");
  assert.equal(a!.length, 0, "shop A untouched");
  const dB = await dashboard(B.id);
  assert.ok(dB.campaigns.every((c) => c.topProducts[0].name.startsWith("B Item #")));
  const dAll = await new RealAdsDashboardSource(db, { now: () => clock }).load(parseAdsFilters({ period: "7d", shop: "all" }, clock));
  for (const c of dAll.campaigns.filter((x) => x.shopId === A.id || x.shopId === B.id)) {
    assert.equal(c.topProducts[0].name.startsWith("B "), c.shopId === B.id, "joins scoped by shop + item id");
  }
  await db.from("shops").delete().eq("id", B.id);
});

/**
 * ADS-3A.2.1: answers like production does on a re-read of the same items —
 * a new request_id, the items in another order, a different set of
 * shipping-fee warning lines — while the product data stays identical.
 */
class VolatileItemsProvider extends FixtureShopeeAdsProvider {
  private n = 0;
  async getItemBaseInfo(ctx: AdsProviderContext, input: { itemIds: readonly string[] }) {
    const p = await super.getItemBaseInfo(ctx, input);
    const n = ++this.n;
    const raw = p.raw as Record<string, unknown>;
    const response = raw.response as Record<string, unknown>;
    const list = response.item_list as unknown[];
    const shift = n % Math.max(1, list.length);
    const channels = [5000, 5001, 50012, 50053, 50039, 5004].filter((_c, i) => (i + n) % 3 !== 0);
    return {
      ...p,
      raw: {
        ...raw,
        request_id: `e3e3e7f35f04${n.toString(16).padStart(4, "0")}${Date.now().toString(16)}`,
        warning: channels.map((c) => `fail to get channel estimated_shipping_fee for channel [${c}];`).join("\n"),
        response: { ...response, item_list: [...list.slice(shift), ...list.slice(0, shift)] },
      },
    };
  }
}

test("3A.2.1 / 8 / 9. snapshot dedupe: re-reading identical products with a new request_id / item order / shipping warnings adds NO snapshot; rows unchanged; request ids kept in the job log; a real change still adds one", async () => {
  const D = await newShop();
  provider.inner = new FixtureShopeeAdsProvider(fixtures);
  await seed(D.id, provider);
  await setAdsShopProductEnrichmentEnabled(db, { shopId: D.id, enabled: true });
  const snapshots = async () => {
    const { data, error } = await db.from("channel_api_snapshots").select("id, payload").eq("shop_id", D.id).eq("api_name", "/api/v2/product/get_item_base_info");
    if (error) throw error;
    return data as Array<{ id: string; payload: { request_id?: string; warning?: string } }>;
  };
  const rows = async () => {
    const { data } = await db.from("shopee_ads_products").select("id, provider_item_id, product_name, image_url, item_sku, provider_status, enrichment_status").eq("shop_id", D.id).order("provider_item_id");
    return data!;
  };
  const lastJobMeta = async () => (await jobs(D.id)).filter((x) => x.sync_type === "ads_product_enrichment_read").at(-1)!.metadata as { stats: Record<string, number>; requestIds: string[] };

  provider.inner = new VolatileItemsProvider(fixtures);
  await maybeEnqueueAdsProductEnrichment(db, { shopId: D.id, now: clock, config: CONFIG });
  await drain([D.id], provider);
  const first = await snapshots();
  assert.equal(first.length, 3, "3 batches → 3 snapshots");
  assert.ok(first.every((s) => s.payload.request_id?.startsWith("e3e3e7f35f04") && s.payload.warning?.includes("estimated_shipping_fee")), "stored raw keeps request_id + warning");
  assert.equal((await lastJobMeta()).stats.snapshotsInserted, 3);
  const rowsBefore = await rows();

  clock = new Date(clock.getTime() + 60_000);
  await maybeEnqueueAdsProductEnrichment(db, { shopId: D.id, now: clock, config: CONFIG, scope: "all" });
  await drain([D.id], provider);
  const second = await snapshots();
  assert.equal(second.length, 3, "no duplicate snapshot caused by request_id / order / warnings");
  assert.deepEqual(second.map((s) => s.payload.request_id).sort(), first.map((s) => s.payload.request_id).sort(), "deduped rows keep their first request_id");
  const meta = await lastJobMeta();
  assert.equal(meta.stats.snapshotsDeduped, 3);
  assert.equal(meta.stats.snapshotsInserted ?? 0, 0);
  assert.equal(meta.requestIds.length, 3, "9. the latest request ids stay auditable in the job log");
  assert.ok(meta.requestIds.every((id) => !first.some((s) => s.payload.request_id === id)), "new request ids recorded");
  assert.deepEqual(await rows(), rowsBefore, "canonical product rows unchanged");

  // a real product change still produces a new snapshot (only the batch that changed)
  const renamed = rowsBefore[0].provider_item_id;
  provider.inner = new (class extends VolatileItemsProvider {})(fixtures, { item: (id, row) => (id === renamed ? { ...row, item_name: "Đổi tên thật" } : row) });
  clock = new Date(clock.getTime() + 60_000);
  await maybeEnqueueAdsProductEnrichment(db, { shopId: D.id, now: clock, config: CONFIG, scope: "all" });
  await drain([D.id], provider);
  assert.equal((await snapshots()).length, 4, "the changed batch → one new snapshot");
  assert.equal((await lastJobMeta()).stats.snapshotsInserted, 1);
  provider.inner = new FixtureShopeeAdsProvider(fixtures);
  await db.from("shops").delete().eq("id", D.id);
});

test("19 / 65. new item fast path: the catalogue read that discovers a newly advertised item enqueues enrichment; the name lands without waiting for the next slot", async () => {
  const data: AdsFixtureData = { ...fixtures, settings: new Map(fixtures.settings), items: new Map(fixtures.items) };
  const [cid, setting] = [...data.settings.entries()][0];
  data.settings.set(cid, { ...setting, common_info: { ...(setting.common_info as object), item_id_list: [987654321] } });
  data.items.set("987654321", { ...fixtures.items.values().next().value!, item_id: 987654321, item_name: "Sản phẩm mới quảng cáo" });
  provider.inner = new FixtureShopeeAdsProvider(data);
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_read", strategy: "metadata", priority: ADS_PRIORITY.metadata, now: clock });
  provider.calls.length = 0;
  const reports = await drain([A.id], provider);
  assert.deepEqual(reports.map((r) => r.syncType), ["ads_campaign_read", "ads_product_enrichment_read"]);
  const catalogue = (await jobs(A.id)).filter((x) => x.sync_type === "ads_campaign_read").at(-1)!;
  assert.ok((catalogue.metadata as { productEnrichment?: { created: boolean } }).productEnrichment?.created);
  assert.deepEqual(itemCalls(provider), [1], "only the unknown item (cache serves the other 100)");
  const enr = (await jobs(A.id)).filter((x) => x.sync_type === "ads_product_enrichment_read").at(-1)!;
  assert.equal((enr.metadata as { productScope: { cacheHitRate: number } }).productScope.cacheHitRate, 0.9901);
  const { data: row } = await db.from("shopee_ads_products").select("product_name").eq("shop_id", A.id).eq("provider_item_id", "987654321").single();
  assert.equal(row!.product_name, "Sản phẩm mới quảng cáo");
  provider.inner = new FixtureShopeeAdsProvider(fixtures);
  // restore the catalogue
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_read", strategy: "metadata", priority: ADS_PRIORITY.metadata, now: clock });
  await drain([A.id], provider);
});

test("70 / 40 / 41. performance isolation: a large enrichment backlog never runs before HOT / hourly; each enrichment slice yields after ADS_BATCHES_PER_SLICE calls", async () => {
  const P = await newShop();
  await seed(P.id, provider);
  await setAdsShopProductEnrichmentEnabled(db, { shopId: P.id, enabled: true });
  CONFIG = { ...ON, batchesPerSlice: 1 };
  await maybeEnqueueAdsProductEnrichment(db, { shopId: P.id, now: clock, config: CONFIG });
  const w = worker([P.id], provider);
  const first = await w.runOne(120_000);
  assert.equal(first?.syncType, "ads_product_enrichment_read");
  assert.equal(first?.status, "pending", "one batch, then back of the line");
  // HOT + hourly arrive while the enrichment backlog is still queued
  const range = { from: TODAY, to: TODAY };
  await enqueueAdsJob(db, { shopId: P.id, syncType: "ads_shop_hourly_read", strategy: "hot", priority: ADS_PRIORITY.hotShopHourly, range, now: clock });
  await enqueueAdsJob(db, { shopId: P.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: ADS_PRIORITY.hotShop, range, now: clock });
  await enqueueAdsJob(db, { shopId: P.id, syncType: "ads_shop_performance_read", strategy: "cold", priority: ADS_PRIORITY.cold, range: { from: "2026-10-24", to: range.to }, now: clock });
  const order: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await w.runOne(120_000);
    if (!r) break;
    order.push(`${r.syncType}${r.status === "pending" ? "…" : ""}`);
  }
  const dump = JSON.stringify((await jobs(P.id)).map((j) => [j.sync_type, j.status, j.priority]));
  assert.deepEqual(order.slice(0, 3), ["ads_shop_performance_read", "ads_shop_hourly_read", "ads_shop_performance_read"], `HOT, hourly, COLD before any further enrichment slice: ${order} ${dump}`);
  assert.deepEqual(order.slice(3), ["ads_product_enrichment_read…", "ads_product_enrichment_read"]);
  CONFIG = ON;
  await db.from("shops").delete().eq("id", P.id);
});

test("39. failure isolation: product metadata fetch fails → enrichment retries; campaign performance and the dashboard keep working", async () => {
  await db.from("channel_sync_jobs").delete().eq("shop_id", A.id).in("status", ["pending", "retry"]);
  clock = new Date(T0.getTime() + 100 * 3_600_000);
  provider.failItems = new Error("simulated product endpoint outage");
  await maybeEnqueueAdsProductEnrichment(db, { shopId: A.id, now: clock, config: CONFIG, scope: "all" });
  await enqueueAdsJob(db, { shopId: A.id, syncType: "ads_campaign_performance_read", strategy: "manual", priority: ADS_PRIORITY.manual, range: { from: shopToday(clock, TZ), to: shopToday(clock, TZ) }, scope: "all", now: clock });
  const reports = await drain([A.id], provider, 2);
  assert.equal(reports[0].syncType, "ads_campaign_performance_read");
  assert.equal(reports[0].status, "success", JSON.stringify(reports.map((r) => [r.syncType, r.status, r.errorMessage])));
  assert.equal(reports[1].syncType, "ads_product_enrichment_read");
  assert.ok(["retry", "failed"].includes(reports[1].status), reports[1].status);
  const d = await dashboard(A.id);
  assert.ok(d.campaigns.length > 0 && d.campaigns.every((c) => c.topProducts[0].name.length > 0), "cached names still shown");
  provider.failItems = null;
  await db.from("channel_sync_jobs").delete().eq("shop_id", A.id).eq("sync_type", "ads_product_enrichment_read").in("status", ["pending", "retry", "running"]);
});

test("17 / 45. scheduler: product slot every 15 min (offset +7) — enqueues only on unknown / stale items; fresh cache = slot consumed, no job; flag OFF = no slot", async () => {
  const S = await newShop();
  await setAdsShopSyncEnabled(db, { shopId: S.id, enabled: true, syncSlot: 0 });
  clock = T0;
  await seed(S.id, provider);
  const done = clock.toISOString();
  await db.from("shopee_ads_shop_settings").update({ shop_backfill_completed_at: done, campaign_backfill_completed_at: done, last_metadata_slot_at: done, last_warm_slot_at: done, last_cold_slot_at: done }).eq("shop_id", S.id);
  await setAdsShopProductEnrichmentEnabled(db, { shopId: S.id, enabled: true });

  const off = await runAdsSchedulerTick(db, { config: { ...ON, productEnrichmentEnabled: false }, now: clock, shopIds: [S.id] });
  assert.ok(!off.enqueued.some((e) => e.kind === "product_enrichment"), "global flag off");
  await drain([S.id], provider);

  clock = new Date(T0.getTime() + 15 * 60_000);
  const t1 = await runAdsSchedulerTick(db, { config: ON, now: clock, shopIds: [S.id] });
  assert.ok(t1.enqueued.some((e) => e.kind === "product_enrichment" && e.syncType === "ads_product_enrichment_read"), JSON.stringify(t1.enqueued.map((e) => e.kind)));
  const queued = (await jobs(S.id)).filter((j) => ["pending", "retry"].includes(j.status));
  const enr = queued.find((j) => j.sync_type === "ads_product_enrichment_read")!;
  const hot = queued.find((j) => j.sync_type === "ads_shop_performance_read")!;
  assert.ok(enr.priority > hot.priority, "enrichment below HOT");
  const order = (await drain([S.id], provider)).map((r) => r.syncType);
  assert.equal(order.at(-1), "ads_product_enrichment_read", "claimed after every performance read");
  assert.equal(await count("shopee_ads_products", S.id), 101);

  // next slot: everything fresh → slot consumed, no job, no provider call
  clock = new Date(T0.getTime() + 30 * 60_000);
  provider.calls.length = 0;
  const t2 = await runAdsSchedulerTick(db, { config: ON, now: clock, shopIds: [S.id] });
  assert.ok(!t2.enqueued.some((e) => e.kind === "product_enrichment"));
  assert.deepEqual(t2.productCacheHits, [S.id]);
  await drain([S.id], provider);
  assert.deepEqual(itemCalls(provider), [], "steady state: no product call");

  // admin overview: cache state
  const ov = (await loadAdsSyncOverview(db, clock)).find((o) => o.shopId === S.id)!;
  assert.deepEqual({ ...ov.products, lastEnrichedAt: null }, { referenced: 101, enriched: 101, notReturned: 0, missing: 0, stale: 0, withImage: 101, withSku: 27, lastEnrichedAt: null, enabled: true });

  // 56: manual "Làm mới dữ liệu" → nothing for products while the cache is fresh
  const refresh = await requestAdsRefresh(db, { shopId: S.id, now: clock, config: ON, force: true });
  assert.ok(!refresh.jobs.some((j) => j.syncType === "ads_product_enrichment_read"));
  await db.from("shops").delete().eq("id", S.id);
  clock = T0;
});

test("49 / 50 / 52. dashboard campaign RPC: products joined in ONE aggregated request (no N+1), latency measured", async () => {
  const runs: number[] = [];
  let rows = 0;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const { data, error } = await db.rpc("ads_dashboard_campaigns", { p_shop_ids: [A.id], p_from: "2026-10-22", p_to: "2026-10-28" });
    runs.push(performance.now() - t);
    assert.ifError(error);
    rows = data!.length;
    assert.ok(data!.every((r: { products: unknown[] }) => Array.isArray(r.products) && r.products.length === 1));
  }
  runs.sort((a, b) => a - b);
  console.log(JSON.stringify({ metric: "ads_dashboard_campaigns_with_products", campaigns: rows, medianMs: Math.round(runs[2]), maxMs: Math.round(runs[4]) }));
  assert.equal(rows, 143);
});

test("3A.2.1 / 16 / 17 / 29. display thumbnail derived in the presentation layer (flag ON → `_tn` + original kept; OFF → none); stored image_url never rewritten; no extra query", async () => {
  const before = process.env.ADS_PRODUCT_THUMBNAIL_TN_ENABLED;
  try {
    process.env.ADS_PRODUCT_THUMBNAIL_TN_ENABLED = "true";
    const on = (await dashboard(A.id)).campaigns.flatMap((c) => c.topProducts).filter((p) => p.imageUrl);
    assert.ok(on.length > 0);
    assert.ok(on.every((p) => p.thumbnailUrl === `${p.imageUrl}_tn` && !p.imageUrl!.endsWith("_tn")), "thumbnail = original + _tn; original kept as the fallback");
    process.env.ADS_PRODUCT_THUMBNAIL_TN_ENABLED = "false";
    const off = (await dashboard(A.id)).campaigns.flatMap((c) => c.topProducts);
    assert.ok(off.every((p) => !p.thumbnailUrl), "flag OFF → original only");
    const { data: stored } = await db.from("shopee_ads_products").select("image_url").eq("shop_id", A.id).like("image_url", "%_tn");
    assert.equal(stored!.length, 0, "canonical image_url unchanged");
  } finally {
    if (before === undefined) delete process.env.ADS_PRODUCT_THUMBNAIL_TN_ENABLED;
    else process.env.ADS_PRODUCT_THUMBNAIL_TN_ENABLED = before;
  }
});

test("47 / 76. capacity — current 5-shop item profile (101 / 82 / 176 / 439 / 172 distinct Ads items), concurrency unchanged (2): initial enrichment workload, HOT cycle with vs without the enrichment backlog, steady state", async () => {
  const items = [101, 82, 176, 439, 172];
  const LATENCY = 60;
  const shops = [];
  for (let i = 0; i < items.length; i++) shops.push(await newShop());
  const realNow = () => new Date();
  const today = shopToday(new Date(), TZ);
  // one campaign per distinct item: the need-set equals the real distinct item count of each shop
  const sim = new SimulatedAdsProvider(shops.map((s, i) => ({ externalShopId: s.ext, campaigns: items[i], ongoingShare: 0.3 })), { date: today, latencyMs: LATENCY });
  const ids = shops.map((s) => s.id);
  const run = (tag: string) =>
    mapWithConcurrency([0, 1, 2], 3, async (i) => {
      const config = { ...getSyncConfig(), shopAllowlist: ids, globalWorkers: 10, maxRunningPerShop: 1, sliceTimeBudgetMs: 120_000, maxSliceApiCalls: 200 };
      const w = new SyncWorker({
        db,
        config,
        workerId: `cap-${tag}-${i}`,
        syncTypes: ADS_SYNC_TYPES,
        classifyError: toJobFailure,
        now: realNow,
        logger: () => {},
        maxRunningAds: 2,
        createRunner: (job, budget) => {
          const meter = new ApiCallMeter(budget);
          return { meter, runner: createAdsRunner(job, { db, provider: new MeteredShopeeAdsProvider(sim, meter), config: ON }) };
        },
      });
      for (let k = 0; k < 400; k++) if (!(await w.runOne(120_000))) break;
    });
  for (const s of shops) await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_campaign_read", strategy: "metadata", priority: 7, now: realNow() });
  await run(`${TAG}-meta`);
  const range = { from: today, to: today };

  async function cycle(withEnrichment: boolean) {
    const hotIds: string[] = [];
    const enrIds: string[] = [];
    for (const s of shops) {
      // enrichment queued FIRST (worst case: a full backlog already waiting when the HOT slot fires)
      if (withEnrichment) {
        await setAdsShopProductEnrichmentEnabled(db, { shopId: s.id, enabled: true });
        const r = await maybeEnqueueAdsProductEnrichment(db, { shopId: s.id, now: realNow(), config: ON });
        if (r) enrIds.push(r.jobId);
      }
      hotIds.push((await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_shop_performance_read", strategy: "hot", priority: ADS_PRIORITY.hotShop, range, now: realNow() })).jobId);
      hotIds.push((await enqueueAdsJob(db, { shopId: s.id, syncType: "ads_campaign_performance_read", strategy: "hot", priority: ADS_PRIORITY.hotCampaign, range, scope: "hot", now: realNow() })).jobId);
    }
    sim.calls.length = 0;
    sim.maxInFlight = 0;
    const started = Date.now();
    await run(`${TAG}-${withEnrichment ? "e" : "d"}`);
    const { data: rows } = await db.from("channel_sync_jobs").select("id, status, started_at, finished_at, metadata").in("id", [...hotIds, ...enrIds]);
    const pick = (list: string[]) => (rows ?? []).filter((r) => list.includes(r.id));
    const calls = (list: string[]) => pick(list).reduce((a, r) => a + Object.values((r.metadata as { apiCalls?: Record<string, number> }).apiCalls ?? {}).reduce((x, y) => x + y, 0), 0);
    assert.ok((rows ?? []).every((r) => r.status === "success"), JSON.stringify((rows ?? []).map((r) => r.status)));
    const hotDone = Math.max(...pick(hotIds).map((r) => Date.parse(r.finished_at)));
    const enrDone = enrIds.length ? Math.max(...pick(enrIds).map((r) => Date.parse(r.finished_at))) : null;
    const enrStartedBeforeHotDone = pick(enrIds).filter((r) => Date.parse(r.started_at) < hotDone).length;
    return { hotCalls: calls(hotIds), enrichmentCalls: calls(enrIds), hotCycleMs: hotDone - started, totalMs: (enrDone ?? hotDone) - started, maxInFlight: sim.maxInFlight, itemCallSizes: sim.calls.filter((c) => c.endpoint === "item_base_info").map((c) => c.ids), enrStartedBeforeHotDone };
  }

  const before = await cycle(false);
  const withBacklog = await cycle(true);
  // steady state: every item cached → not one enrichment job / call
  let steadyJobs = 0;
  for (const s of shops) if (await maybeEnqueueAdsProductEnrichment(db, { shopId: s.id, now: realNow(), config: ON })) steadyJobs++;
  const report = {
    event: "ads_product_enrichment_capacity",
    distinctItemsPerShop: items,
    totalItems: items.reduce((a, b) => a + b, 0),
    initialEnrichmentCalls: withBacklog.enrichmentCalls,
    expectedCalls: items.reduce((a, n) => a + Math.ceil(n / 50), 0),
    largestCall: Math.max(...withBacklog.itemCallSizes),
    hotCalls: withBacklog.hotCalls,
    hotCycleMsWithout: before.hotCycleMs,
    hotCycleMsWithBacklog: withBacklog.hotCycleMs,
    fullCycleMsWithBacklog: withBacklog.totalMs,
    enrichmentStartedBeforeHotDone: withBacklog.enrStartedBeforeHotDone,
    // ≈ 1 s per product call in production (Ads reads: 0.4–2.3 s), 2 calls in flight
    estProdSecondsInitialEnrichment: Math.round(withBacklog.enrichmentCalls / 2),
    maxInFlight: withBacklog.maxInFlight,
    steadyStateJobs: steadyJobs,
  };
  console.log(JSON.stringify(report));
  assert.equal(withBacklog.enrichmentCalls, report.expectedCalls, "⌈items / 50⌉ per shop — never one call per product");
  assert.ok(report.largestCall <= 50);
  assert.equal(before.hotCalls, withBacklog.hotCalls, "enrichment never changes the HOT reads");
  assert.ok(withBacklog.maxInFlight <= 2, "concurrency unchanged");
  assert.ok(withBacklog.hotCycleMs <= before.hotCycleMs * 1.5 + 4 * LATENCY, `HOT cycle ${before.hotCycleMs} → ${withBacklog.hotCycleMs} ms`);
  assert.equal(steadyJobs, 0, "steady state: no enrichment job while the cache is fresh");
  for (const s of shops) await db.from("shops").delete().eq("id", s.id);
});
