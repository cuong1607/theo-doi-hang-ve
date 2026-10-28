// ============================================================
// SHOPEE-ADS-1B: READ-ONLY Ads sync — services + queue runners + enqueue.
//
//   ads_campaign_read              list ids (limit 100) → settings (50 ids)
//                                  → snapshots → upsert campaigns + product links
//   ads_campaign_performance_read  campaigns × ≤7-day windows × ≤50 ids
//                                  → upsert campaign daily facts
//   ads_shop_performance_read      ≤30-day windows → upsert SHOP daily facts
//                                  (independent table: shop total ≠ Σ campaigns)
//
// Runs only inside the existing queue worker (claim / lease / checkpoint /
// retry / backoff / stale recovery). Never called from a page render.
// Every provider call goes through the read-only provider (GET, allowlist).
//
// Overlap: every performance refresh re-reads today + the previous
// ADS_PERFORMANCE_RESTATEMENT_DAYS (default 7) completed days — PROVISIONAL,
// historical restatement is not proven yet (docs/shopee-ads-sync.md).
// No "server-only" marker: integration tests drive it with a local DB.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { payloadHash } from "../../core/snapshots.ts";
import { enqueueSyncJob, type EnqueueResult, type SyncJobRow } from "../../core/sync-jobs.ts";
import { continuation, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../../core/sync-runner.ts";
import type { ProviderPayload } from "../product-provider.ts";
import {
  parseCampaignDailyPerformance,
  parseCampaignIdPage,
  parseCampaignSettings,
  parseShopDailyPerformance,
  type AdsCampaignWrite,
  type AdsPerformancePrimitives,
} from "./mapper.ts";
import { ADS_CAMPAIGN_PAGE_SIZE, ADS_CAMPAIGN_RANGE_DAYS, ADS_ID_BATCH, ADS_SHOP_RANGE_DAYS, type AdsDateRange, type AdsProviderContext, type ShopeeAdsProvider } from "./provider.ts";
import { type AdsSyncType } from "./read-only-policy.ts";
import { sanitizeAdsPayload } from "./sanitize.ts";
import { ADS_SNAPSHOT_ENTITY_TYPE } from "./types.ts";

// ------------------------------------------------------------------ config (centralized)

export interface AdsSyncConfig {
  /** Completed days re-read on every performance refresh (provisional). */
  restatementDays: number;
  /** Days fetched on the first performance sync of a shop. */
  initialBackfillDays: number;
  /** Campaign metadata is re-read by "Làm mới" only when older than this. */
  campaignStaleMinutes: number;
}

const intEnv = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function getAdsSyncConfig(env: Record<string, string | undefined> = process.env): AdsSyncConfig {
  return {
    restatementDays: intEnv(env.ADS_PERFORMANCE_RESTATEMENT_DAYS, 7, 0, 30),
    initialBackfillDays: intEnv(env.ADS_INITIAL_BACKFILL_DAYS, 30, 1, 90),
    campaignStaleMinutes: intEnv(env.ADS_CAMPAIGN_STALE_MINUTES, 360, 5, 7 * 24 * 60),
  };
}

/** Manual "Làm mới" lane priorities (lower = earlier): metadata first, facts right after. */
export const ADS_JOB_PRIORITY: Record<AdsSyncType, number> = {
  ads_campaign_read: 5,
  ads_campaign_performance_read: 6,
  ads_shop_performance_read: 6,
};

// ------------------------------------------------------------------ dates (pure)

const DAY_MS = 86_400_000;

/** Today's date (YYYY-MM-DD) in the shop's timezone. */
export function shopToday(now: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")}`;
}

export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Refresh window: today + the previous `restatementDays` completed days; first sync: `initialBackfillDays`. */
export function adsPerformanceRange(now: Date, timeZone: string, config: AdsSyncConfig, initial: boolean): AdsDateRange {
  const today = shopToday(now, timeZone);
  return { from: addDaysIso(today, -(initial ? config.initialBackfillDays : config.restatementDays)), to: today };
}

/** Splits an inclusive range into consecutive windows of ≤ maxDays (oldest first). */
export function splitAdsRange(range: AdsDateRange, maxDays: number): AdsDateRange[] {
  const out: AdsDateRange[] = [];
  for (let from = range.from; from <= range.to; from = addDaysIso(from, maxDays)) {
    const to = addDaysIso(from, maxDays - 1);
    out.push({ from, to: to < range.to ? to : range.to });
  }
  return out;
}

export function chunk<T>(list: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
}

// ------------------------------------------------------------------ snapshots (existing channel_api_snapshots, entity 'ads')

/** Raw response history: identical payload for the same request key only refreshes synced_at. */
export async function saveAdsSnapshot(db: SupabaseClient, input: { shopId: string; payload: ProviderPayload; key: string; sourceMode: "live" | "fixture"; syncedAt: string }) {
  const raw = sanitizeAdsPayload(input.payload.raw);
  const hash = payloadHash(raw);
  const match = { shop_id: input.shopId, entity_type: ADS_SNAPSHOT_ENTITY_TYPE, entity_external_id: input.key.slice(0, 200), api_name: input.payload.apiName };
  const { data: latest, error } = await db.from("channel_api_snapshots").select("id, payload_hash").match(match).order("synced_at", { ascending: false }).limit(1).maybeSingle<{ id: string; payload_hash: string | null }>();
  if (error) throw new Error(`Không đọc được snapshot Ads: ${error.message}`);
  if (latest?.payload_hash === hash) {
    const { error: upd } = await db.from("channel_api_snapshots").update({ synced_at: input.syncedAt }).eq("id", latest.id);
    if (upd) throw new Error(`Không cập nhật được snapshot Ads: ${upd.message}`);
    return "refreshed" as const;
  }
  const { error: ins } = await db.from("channel_api_snapshots").insert({ ...match, payload: raw, payload_hash: hash, source_mode: input.sourceMode, synced_at: input.syncedAt });
  if (ins) throw new Error(`Không lưu được snapshot Ads: ${ins.message}`);
  return "inserted" as const;
}

// ------------------------------------------------------------------ canonical writes

const UPSERT_CHUNK = 500;

export async function upsertAdsCampaigns(db: SupabaseClient, shopId: string, campaigns: AdsCampaignWrite[], syncedAt: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const part of chunk(campaigns, UPSERT_CHUNK)) {
    const { data, error } = await db
      .from("shopee_ads_campaigns")
      .upsert(
        part.map((c) => ({
          shop_id: shopId,
          provider_campaign_id: c.providerCampaignId,
          campaign_name: c.campaignName,
          provider_status: c.providerStatus,
          provider_ad_type: c.providerAdType,
          provider_bidding_method: c.providerBiddingMethod,
          provider_placement: c.providerPlacement,
          daily_budget: c.dailyBudget,
          roas_target: c.roasTarget,
          provider_start_at: c.providerStartAt,
          provider_end_at: c.providerEndAt,
          last_synced_at: syncedAt,
        })),
        { onConflict: "shop_id,provider_campaign_id" },
      )
      .select("id, provider_campaign_id");
    if (error) throw new Error(`Không lưu được chiến dịch Ads: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; provider_campaign_id: string }>) ids.set(r.provider_campaign_id, r.id);
  }
  return ids;
}

/**
 * Product links of campaigns whose settings payload was COMPLETE (parsed):
 * insert the current set, remove links no longer listed. Campaigns that
 * failed to parse are never touched (no blind delete from a partial answer).
 */
export async function reconcileAdsCampaignProducts(db: SupabaseClient, shopId: string, campaigns: AdsCampaignWrite[], idByProvider: Map<string, string>): Promise<{ inserted: number; removed: number }> {
  let inserted = 0;
  let removed = 0;
  for (const part of chunk(campaigns, ADS_ID_BATCH)) {
    const campaignIds = part.map((c) => idByProvider.get(c.providerCampaignId)).filter((v): v is string => !!v);
    if (!campaignIds.length) continue;
    const { data: existing, error } = await db.from("shopee_ads_campaign_products").select("id, campaign_id, provider_item_id").in("campaign_id", campaignIds);
    if (error) throw new Error(`Không đọc được sản phẩm chiến dịch: ${error.message}`);
    const have = new Map<string, { id: string }>();
    for (const r of (existing ?? []) as Array<{ id: string; campaign_id: string; provider_item_id: string }>) have.set(`${r.campaign_id}|${r.provider_item_id}`, { id: r.id });
    const want = new Set<string>();
    const toInsert: Array<{ shop_id: string; campaign_id: string; provider_item_id: string }> = [];
    for (const c of part) {
      const campaignId = idByProvider.get(c.providerCampaignId);
      if (!campaignId) continue;
      for (const item of c.itemIds) {
        const key = `${campaignId}|${item}`;
        want.add(key);
        if (!have.has(key)) toInsert.push({ shop_id: shopId, campaign_id: campaignId, provider_item_id: item });
      }
    }
    if (toInsert.length) {
      const { error: insError } = await db.from("shopee_ads_campaign_products").upsert(toInsert, { onConflict: "campaign_id,provider_item_id", ignoreDuplicates: true });
      if (insError) throw new Error(`Không lưu được sản phẩm chiến dịch: ${insError.message}`);
      inserted += toInsert.length;
    }
    const stale = [...have.entries()].filter(([k]) => !want.has(k)).map(([, v]) => v.id);
    if (stale.length) {
      const { error: delError } = await db.from("shopee_ads_campaign_products").delete().in("id", stale);
      if (delError) throw new Error(`Không xoá được liên kết sản phẩm cũ: ${delError.message}`);
      removed += stale.length;
    }
  }
  return { inserted, removed };
}

const factColumns = (p: AdsPerformancePrimitives) => ({
  report_date: p.reportDate,
  expense: p.expense,
  impression: p.impression,
  clicks: p.clicks,
  direct_order: p.directOrder,
  broad_order: p.broadOrder,
  direct_gmv: p.directGmv,
  broad_gmv: p.broadGmv,
  direct_item_sold: p.directItemSold,
  broad_item_sold: p.broadItemSold,
});

export async function upsertAdsCampaignFacts(db: SupabaseClient, rows: Array<{ shopId: string; campaignId: string; facts: AdsPerformancePrimitives }>, syncedAt: string) {
  for (const part of chunk(rows, UPSERT_CHUNK)) {
    const { error } = await db
      .from("shopee_ads_campaign_daily_performance")
      .upsert(part.map((r) => ({ shop_id: r.shopId, campaign_id: r.campaignId, ...factColumns(r.facts), last_synced_at: syncedAt })), { onConflict: "campaign_id,report_date" });
    if (error) throw new Error(`Không lưu được hiệu quả chiến dịch: ${error.message}`);
  }
}

export async function upsertAdsShopFacts(db: SupabaseClient, shopId: string, rows: AdsPerformancePrimitives[], syncedAt: string) {
  for (const part of chunk(rows, UPSERT_CHUNK)) {
    const { error } = await db.from("shopee_ads_shop_daily_performance").upsert(part.map((r) => ({ shop_id: shopId, ...factColumns(r), last_synced_at: syncedAt })), { onConflict: "shop_id,report_date" });
    if (error) throw new Error(`Không lưu được hiệu quả cấp shop: ${error.message}`);
  }
}

// ------------------------------------------------------------------ queue runners

interface AdsShop {
  id: string;
  external_shop_id: string;
  timezone: string;
  region: string | null;
}

async function loadAdsShop(db: SupabaseClient, shopId: string): Promise<AdsShop> {
  const { data, error } = await db.from("shops").select("id, external_shop_id, timezone, region, channel").eq("id", shopId).maybeSingle<AdsShop & { channel: string }>();
  if (error) throw new Error(`Không đọc được shop: ${error.message}`);
  if (!data || data.channel !== "shopee") throw new Error("Shop không tồn tại hoặc không phải Shopee.");
  return { id: data.id, external_shop_id: data.external_shop_id, timezone: data.timezone || "Asia/Ho_Chi_Minh", region: data.region };
}

/** Range of a performance job: stored in job metadata as shop-local YYYY-MM-DD. */
function jobRange(job: SyncJobRow): AdsDateRange {
  const r = (job.metadata?.adsRange ?? null) as AdsDateRange | null;
  if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to) || r.to < r.from) throw new Error("Job Ads thiếu khoảng ngày hợp lệ (metadata.adsRange).");
  return r;
}

type FailureList = Array<{ externalId: string | null; reason: string }>;
const doneOutcome = (range: AdsDateRange | null, failures: number, firstFailure: string | null, finishedAt: Date): SliceOutcome => ({
  kind: "done",
  logStatus: failures > 0 ? "partial" : "success",
  advanceCheckpoint: true,
  windowFrom: range ? `${range.from}T00:00:00Z` : null,
  // last_success_at = when the read finished (freshness); report dates live in the fact tables
  windowTo: finishedAt.toISOString(),
  errorCode: failures > 0 ? "partial_failure" : null,
  errorMessage: failures > 0 ? `${failures} lỗi; đầu tiên: ${firstFailure ?? ""}`.slice(0, 500) : null,
});

interface CampaignCheckpoint {
  phase: "list" | "settings";
  offset: number;
  ids: string[];
  settingsIndex: number;
}

export class AdsCampaignReadRunner implements SyncJobRunner {
  private readonly deps: { db: SupabaseClient; provider: ShopeeAdsProvider };

  constructor(deps: { db: SupabaseClient; provider: ShopeeAdsProvider }) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const progress = input.progress as SliceInput<CampaignCheckpoint>["progress"];
    const shop = await loadAdsShop(this.deps.db, job.shop_id);
    const ctx: AdsProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    progress.checkpoint ??= { phase: "list", offset: 0, ids: [], settingsIndex: 0 };
    const cp = progress.checkpoint;
    const failures = (progress.meta.adsFailures as FailureList | undefined) ?? [];
    const save = async () => (await lease.checkpoint(progress.toPatch({ offsetValue: cp.offset }))).cancelRequested;

    while (cp.phase === "list") {
      if (!budget.canSpend(1)) return continuation(budget, "more_pages");
      const payload = await this.deps.provider.listProductLevelCampaignIds(ctx, { offset: cp.offset, limit: ADS_CAMPAIGN_PAGE_SIZE });
      await saveAdsSnapshot(this.deps.db, { shopId: shop.id, payload, key: `campaign_ids:${cp.offset}`, sourceMode: this.deps.provider.mode, syncedAt: now().toISOString() });
      const page = parseCampaignIdPage(payload.raw);
      for (const id of page.campaignIds) if (!cp.ids.includes(id)) cp.ids.push(id);
      cp.offset += page.count;
      progress.counters.fetched += page.count;
      if (!page.hasNextPage || page.count === 0) cp.phase = "settings";
      if (await save()) return { kind: "cancelled" };
    }

    const batches = chunk(cp.ids, ADS_ID_BATCH);
    while (cp.settingsIndex < batches.length) {
      if (!budget.canSpend(1)) return continuation(budget, "more_details");
      const batch = batches[cp.settingsIndex];
      const payload = await this.deps.provider.getProductLevelCampaignSettings(ctx, { campaignIds: batch });
      const syncedAt = now().toISOString();
      await saveAdsSnapshot(this.deps.db, { shopId: shop.id, payload, key: `campaign_settings:${batch[0]}:${batch.length}`, sourceMode: this.deps.provider.mode, syncedAt });
      const parsed = parseCampaignSettings(payload.raw);
      const idMap = await upsertAdsCampaigns(this.deps.db, shop.id, parsed.campaigns, syncedAt);
      const links = await reconcileAdsCampaignProducts(this.deps.db, shop.id, parsed.campaigns, idMap);
      progress.counters.updated += parsed.campaigns.length;
      progress.counters.failed += parsed.failures.length;
      progress.incr("productLinksInserted", links.inserted);
      progress.incr("productLinksRemoved", links.removed);
      for (const f of parsed.failures) failures.push({ externalId: f.id, reason: f.reason });
      progress.meta.adsFailures = failures.slice(0, 20);
      cp.settingsIndex++;
      if (await save()) return { kind: "cancelled" };
    }
    progress.meta.campaignsSeen = cp.ids.length;
    return doneOutcome(null, failures.length, failures[0]?.reason ?? null, now());
  }
}

interface PerformanceCheckpoint {
  windows: AdsDateRange[];
  windowIndex: number;
  batchIndex: number;
}

/** Provider campaign id → canonical uuid for the shop (paged: PostgREST returns ≤ 1000 rows per request). */
export async function loadAdsCampaignIds(db: SupabaseClient, shopId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("shopee_ads_campaigns").select("id, provider_campaign_id").eq("shop_id", shopId).order("provider_campaign_id").range(from, from + 999);
    if (error) throw new Error(`Không đọc được chiến dịch: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; provider_campaign_id: string }>;
    for (const r of rows) out.set(r.provider_campaign_id, r.id);
    if (rows.length < 1000) return out;
  }
}

export class AdsCampaignPerformanceReadRunner implements SyncJobRunner {
  private readonly deps: { db: SupabaseClient; provider: ShopeeAdsProvider };

  constructor(deps: { db: SupabaseClient; provider: ShopeeAdsProvider }) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const progress = input.progress as SliceInput<PerformanceCheckpoint>["progress"];
    const shop = await loadAdsShop(this.deps.db, job.shop_id);
    const ctx: AdsProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    const range = jobRange(job);
    const idMap = await loadAdsCampaignIds(this.deps.db, shop.id);
    if (idMap.size === 0) {
      // Campaign metadata has not been synced yet: wait for ads_campaign_read (retry with backoff, no provider call).
      throw new AdsDependencyPendingError();
    }
    progress.checkpoint ??= { windows: splitAdsRange(range, ADS_CAMPAIGN_RANGE_DAYS), windowIndex: 0, batchIndex: 0 };
    const cp = progress.checkpoint;
    const providerIds = [...idMap.keys()];
    const batches = chunk(providerIds, ADS_ID_BATCH);
    const failures = (progress.meta.adsFailures as FailureList | undefined) ?? [];

    while (cp.windowIndex < cp.windows.length) {
      while (cp.batchIndex < batches.length) {
        if (!budget.canSpend(1)) return continuation(budget, "more_records");
        const window = cp.windows[cp.windowIndex];
        const batch = batches[cp.batchIndex];
        const payload = await this.deps.provider.getProductCampaignDailyPerformance(ctx, { campaignIds: batch, range: window });
        const syncedAt = now().toISOString();
        await saveAdsSnapshot(this.deps.db, { shopId: shop.id, payload, key: `campaign_daily:${window.from}:${window.to}:${batch[0]}:${batch.length}`, sourceMode: this.deps.provider.mode, syncedAt });
        const parsed = parseCampaignDailyPerformance(payload.raw);
        const rows = parsed.rows.flatMap((r) => {
          const campaignId = idMap.get(r.providerCampaignId);
          if (!campaignId) {
            failures.push({ externalId: r.providerCampaignId, reason: "Chiến dịch chưa có trong danh mục (chờ ads_campaign_read)." });
            return [];
          }
          return [{ shopId: shop.id, campaignId, facts: r }];
        });
        await upsertAdsCampaignFacts(this.deps.db, rows, syncedAt);
        progress.counters.fetched += parsed.rows.length;
        progress.counters.updated += rows.length;
        progress.counters.failed += parsed.failures.length;
        progress.incr("missingFields", parsed.missingFields);
        for (const f of parsed.failures) failures.push({ externalId: f.id, reason: f.reason });
        progress.meta.adsFailures = failures.slice(0, 20);
        cp.batchIndex++;
        if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
      }
      cp.batchIndex = 0;
      cp.windowIndex++;
    }
    progress.meta.lastReportDate = range.to;
    return doneOutcome(range, failures.length, failures[0]?.reason ?? null, now());
  }
}

export class AdsShopPerformanceReadRunner implements SyncJobRunner {
  private readonly deps: { db: SupabaseClient; provider: ShopeeAdsProvider };

  constructor(deps: { db: SupabaseClient; provider: ShopeeAdsProvider }) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const progress = input.progress as SliceInput<{ windows: AdsDateRange[]; windowIndex: number }>["progress"];
    const shop = await loadAdsShop(this.deps.db, job.shop_id);
    const ctx: AdsProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    const range = jobRange(job);
    progress.checkpoint ??= { windows: splitAdsRange(range, ADS_SHOP_RANGE_DAYS), windowIndex: 0 };
    const cp = progress.checkpoint;
    while (cp.windowIndex < cp.windows.length) {
      if (!budget.canSpend(1)) return continuation(budget, "more_records");
      const window = cp.windows[cp.windowIndex];
      const payload = await this.deps.provider.getAllCpcAdsDailyPerformance(ctx, { range: window });
      const syncedAt = now().toISOString();
      await saveAdsSnapshot(this.deps.db, { shopId: shop.id, payload, key: `shop_daily:${window.from}:${window.to}`, sourceMode: this.deps.provider.mode, syncedAt });
      const parsed = parseShopDailyPerformance(payload.raw);
      await upsertAdsShopFacts(this.deps.db, shop.id, parsed.rows, syncedAt);
      progress.counters.fetched += parsed.rows.length;
      progress.counters.updated += parsed.rows.length;
      progress.incr("missingFields", parsed.missingFields);
      cp.windowIndex++;
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }
    progress.meta.lastReportDate = range.to;
    return doneOutcome(range, 0, null, now());
  }
}

/** Retryable: the campaign catalogue is not there yet (backoff, then the job runs again). */
export class AdsDependencyPendingError extends Error {
  readonly code = "ads_campaigns_pending";
  constructor() {
    super("Chưa có danh mục chiến dịch — chờ đồng bộ chiến dịch (ads_campaign_read) xong.");
    this.name = "AdsDependencyPendingError";
  }
}

export function createAdsRunner(job: SyncJobRow, deps: { db: SupabaseClient; provider: ShopeeAdsProvider }): SyncJobRunner {
  switch (job.sync_type) {
    case "ads_campaign_read":
      return new AdsCampaignReadRunner(deps);
    case "ads_campaign_performance_read":
      return new AdsCampaignPerformanceReadRunner(deps);
    case "ads_shop_performance_read":
      return new AdsShopPerformanceReadRunner(deps);
    default:
      throw new Error(`Không phải job Ads: ${job.sync_type}`);
  }
}

// ------------------------------------------------------------------ enqueue (manual "Làm mới dữ liệu")

export interface AdsRefreshResult {
  shopId: string;
  jobs: Array<{ syncType: AdsSyncType; jobId: string; created: boolean; status: string }>;
  range: AdsDateRange;
  initial: boolean;
}

/**
 * Enqueues the read jobs of one shop: campaign metadata when stale (or never
 * synced), campaign performance and shop performance for the refresh window
 * (first time: the initial backfill). Idempotent per shop + type + lane.
 */
export async function requestAdsRefresh(db: SupabaseClient, input: { shopId: string; now?: Date; createdBy?: string | null; config?: AdsSyncConfig }): Promise<AdsRefreshResult> {
  const now = input.now ?? new Date();
  const config = input.config ?? getAdsSyncConfig();
  const shop = await loadAdsShop(db, input.shopId);
  const { data: states, error } = await db.from("channel_sync_states").select("sync_type, last_success_at").eq("shop_id", shop.id).in("sync_type", ["ads_campaign_read", "ads_campaign_performance_read", "ads_shop_performance_read"]);
  if (error) throw new Error(`Không đọc được trạng thái đồng bộ Ads: ${error.message}`);
  const last = new Map(((states ?? []) as Array<{ sync_type: string; last_success_at: string | null }>).map((s) => [s.sync_type, s.last_success_at]));
  const initial = !last.get("ads_campaign_performance_read") || !last.get("ads_shop_performance_read");
  const range = adsPerformanceRange(now, shop.timezone, config, initial);
  const campaignLast = last.get("ads_campaign_read");
  const campaignStale = !campaignLast || now.getTime() - Date.parse(campaignLast) >= config.campaignStaleMinutes * 60_000;

  const jobs: AdsRefreshResult["jobs"] = [];
  const enqueue = async (syncType: AdsSyncType, metadata: Record<string, unknown>) => {
    const r: EnqueueResult = await enqueueSyncJob(db, { shopId: shop.id, syncType, mode: "manual", priority: ADS_JOB_PRIORITY[syncType], metadata, createdBy: input.createdBy ?? null });
    jobs.push({ syncType, jobId: r.jobId, created: r.created, status: r.status });
  };
  if (campaignStale) await enqueue("ads_campaign_read", { requestedAt: now.toISOString() });
  await enqueue("ads_campaign_performance_read", { adsRange: range, initial, requestedAt: now.toISOString() });
  await enqueue("ads_shop_performance_read", { adsRange: range, initial, requestedAt: now.toISOString() });
  return { shopId: shop.id, jobs, range, initial };
}
