// ============================================================
// SHOPEE-ADS-1B / ADS-2: READ-ONLY Ads sync — services + queue runners + enqueue.
//
//   ads_campaign_read              list ids (limit 100) → settings (50 ids)
//                                  → snapshots → upsert campaigns + product links
//   ads_campaign_performance_read  campaign scope × ≤7-day windows × ≤50 ids
//                                  → upsert campaign daily facts
//   ads_shop_performance_read      ≤30-day windows → upsert SHOP daily facts
//                                  (independent table: shop total ≠ Σ campaigns)
//   ads_shop_hourly_read           ADS-3A.1: one date per call → shop × hour rows
//   ads_campaign_hourly_read       ADS-3A.1: one date × ≤50 ids → campaign × hour
//                                  (today: hours ≤ current shop hour only)
//   ads_product_enrichment_read    ADS-3A.2: product/get_item_base_info × ≤50 item
//                                  ids → shopee_ads_products (only items referenced
//                                  by Ads campaigns that are unknown / TTL-expired)
//
// ADS-2 strategies (metadata.strategy, each in its own queue lane):
//   hot       every 15 min, TODAY only; campaigns = active candidates
//   warm      hourly, the previous N completed days; recent-activity candidates
//   cold      1–2×/day, 7 completed days + today, ALL campaigns (reconciliation)
//   backfill  first sync of a shop (30 days, ≤7-day chunks)
//   manual    "Làm mới dữ liệu" (today, all campaigns, highest priority)
//   metadata  campaign catalogue every 6 h
//   repair    metadata re-read when a performance answer names an unknown campaign
//   finalize  ADS-3A.1: yesterday's hourly rows once after the day rollover
//             (all campaigns) + hourly-vs-daily reconciliation
//   enrichment ADS-3A.2: product metadata, lowest priority above backfill;
//             the canonical table is the cache (fresh items are never re-read)
//
// Runs only inside the existing queue worker (claim / lease / checkpoint /
// retry / backoff / stale recovery). Never called from a page render.
// Every provider call goes through the read-only provider (GET, allowlist).
// No "server-only" marker: integration tests drive it with a local DB.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { payloadHash } from "../../core/snapshots.ts";
import { type SyncJobRow, type SyncMode } from "../../core/sync-jobs.ts";
import { continuation, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../../core/sync-runner.ts";
import type { JobProgress } from "../../core/sync-progress.ts";
import { ShopeeApiError } from "../errors.ts";
import type { ProviderPayload } from "../product-provider.ts";
import { adsHourlyReconciliation, loadAdsHourlyReconciliation } from "./hourly.ts";
import {
  parseCampaignDailyPerformance,
  parseCampaignHourlyPerformance,
  parseCampaignIdPage,
  parseCampaignSettings,
  parseShopDailyPerformance,
  parseShopHourlyPerformance,
  parseItemBaseInfo,
  type AdsCampaignWrite,
  type AdsProductWrite,
  type AdsHourlyPrimitives,
  type AdsPerformancePrimitives,
} from "./mapper.ts";
import { ADS_CAMPAIGN_PAGE_SIZE, ADS_CAMPAIGN_RANGE_DAYS, ADS_ID_BATCH, ADS_ITEM_BATCH, ADS_SHOP_RANGE_DAYS, type AdsDateRange, type AdsProviderContext, type ShopeeAdsProvider } from "./provider.ts";
import { type AdsSyncType } from "./read-only-policy.ts";
import { sanitizeAdsPayload } from "./sanitize.ts";
import { ADS_SNAPSHOT_ENTITY_TYPE } from "./types.ts";

// ------------------------------------------------------------------ config (centralized)

export interface AdsSyncConfig {
  /** COLD path: completed days re-read 1–2×/day (ADS_PERFORMANCE_RESTATEMENT_DAYS, provisional). */
  restatementDays: number;
  /** Days fetched on the first performance sync of a shop. */
  initialBackfillDays: number;
  /** Manual "Làm mới": campaign metadata is re-read only when older than this. */
  campaignStaleMinutes: number;
  /** WARM path: completed days re-read every hour (yesterday back N days). */
  warmRestatementDays: number;
  hotIntervalMinutes: number;
  campaignHotIntervalMinutes: number;
  warmIntervalMinutes: number;
  /** COLD restatement times ("HH:MM") in coldTimeZone. */
  coldTimes: string[];
  coldTimeZone: string;
  metadataIntervalMinutes: number;
  /** HOT may skip non-active campaigns only while campaign metadata is newer than this. */
  metadataStaleMinutes: number;
  /** Global cap on running Ads jobs (= concurrent Ads API calls). */
  globalApiConcurrency: number;
  /** One Ads provider workflow per shop (enforced by the claim's per-shop cap). */
  perShopApiConcurrency: number;
  /** ADS_AUTO_SYNC_ENABLED: the scheduler enqueues Ads jobs (default OFF until the pilot is validated). */
  autoSyncEnabled: boolean;
  /** Manual refresh right after a HOT sync (< N min) returns "Dữ liệu vừa được đồng bộ" without provider calls. */
  manualDedupeMinutes: number;
  /** Deterministic 0–N s start offset per shop + slot (no same-second bursts). */
  jitterSeconds: number;
  /** Campaign batches per slice before the job goes to the back of its line (large shops never block small ones). */
  batchesPerSlice: number;
  /** A campaign whose status changed / ended within this many hours stays a HOT candidate. */
  hotRecentStatusHours: number;
  /** ADS_HOURLY_SYNC_ENABLED (ADS-3A.1): hourly TODAY reads (scheduler + manual). Default OFF until the pilot is validated. */
  hourlySyncEnabled: boolean;
  /** Hourly rows older than this (report date) are pruned by the retention run; today / yesterday are never pruned. */
  hourlyRetentionDays: number;
  hourlyFreshTargetMinutes: number;
  hourlyStaleMinutes: number;
  /** Shop-local "HH:MM" when YESTERDAY's hourly rows are re-read once (all campaigns) and reconciled with the daily facts. */
  hourlyFinalizeTime: string;
  /** ADS_PRODUCT_ENRICHMENT_ENABLED (ADS-3A.2): product metadata reads for Ads-referenced items. Default OFF until the pilot is validated. */
  productEnrichmentEnabled: boolean;
  /** A cached item is re-read only after this many hours (ADS_PRODUCT_ENRICHMENT_TTL_HOURS). */
  productEnrichmentTtlHours: number;
}

const intEnv = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const boolEnv = (v: string | undefined, fallback: boolean) => {
  const s = v?.trim().toLowerCase();
  if (!s) return fallback;
  if (["1", "true", "on", "yes"].includes(s)) return true;
  if (["0", "false", "off", "no"].includes(s)) return false;
  return fallback;
};
const timesEnv = (v: string | undefined, fallback: string[]) => {
  const list = (v ?? "").split(/[,\s]+/).filter(Boolean);
  return list.length && list.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) ? [...new Set(list)].sort() : fallback;
};

export function getAdsSyncConfig(env: Record<string, string | undefined> = process.env): AdsSyncConfig {
  return {
    restatementDays: intEnv(env.ADS_PERFORMANCE_RESTATEMENT_DAYS, 7, 0, 30),
    initialBackfillDays: intEnv(env.ADS_INITIAL_BACKFILL_DAYS, 30, 1, 90),
    campaignStaleMinutes: intEnv(env.ADS_CAMPAIGN_STALE_MINUTES, 360, 5, 7 * 24 * 60),
    warmRestatementDays: intEnv(env.ADS_WARM_RESTATEMENT_DAYS, 3, 0, 14),
    hotIntervalMinutes: intEnv(env.ADS_HOT_INTERVAL_MINUTES, 15, 10, 120),
    campaignHotIntervalMinutes: intEnv(env.ADS_CAMPAIGN_HOT_INTERVAL_MINUTES, 15, 10, 180),
    warmIntervalMinutes: intEnv(env.ADS_WARM_INTERVAL_MINUTES, 60, 30, 24 * 60),
    coldTimes: timesEnv(env.ADS_COLD_RESTATEMENT_TIMES, ["03:00", "15:00"]),
    coldTimeZone: env.ADS_COLD_TIMEZONE?.trim() || "Asia/Ho_Chi_Minh",
    metadataIntervalMinutes: intEnv(env.ADS_CAMPAIGN_METADATA_INTERVAL_MINUTES, 360, 60, 24 * 60),
    metadataStaleMinutes: intEnv(env.ADS_CAMPAIGN_METADATA_STALE_MINUTES, 480, 60, 7 * 24 * 60),
    globalApiConcurrency: intEnv(env.ADS_GLOBAL_API_CONCURRENCY, 2, 1, 5),
    perShopApiConcurrency: intEnv(env.ADS_PER_SHOP_API_CONCURRENCY, 1, 1, 1),
    autoSyncEnabled: boolEnv(env.ADS_AUTO_SYNC_ENABLED, false),
    manualDedupeMinutes: intEnv(env.ADS_MANUAL_DEDUPE_MINUTES, 5, 0, 60),
    jitterSeconds: intEnv(env.ADS_SCHEDULER_JITTER_SECONDS, 20, 0, 60),
    batchesPerSlice: intEnv(env.ADS_BATCHES_PER_SLICE, 3, 1, 50),
    hotRecentStatusHours: intEnv(env.ADS_HOT_RECENT_STATUS_HOURS, 36, 1, 7 * 24),
    hourlySyncEnabled: boolEnv(env.ADS_HOURLY_SYNC_ENABLED, false),
    hourlyRetentionDays: intEnv(env.ADS_HOURLY_RETENTION_DAYS, 14, 2, 90),
    hourlyFreshTargetMinutes: intEnv(env.ADS_HOURLY_FRESH_TARGET_MINUTES, 25, 5, 240),
    hourlyStaleMinutes: intEnv(env.ADS_HOURLY_STALE_MINUTES, 35, 10, 480),
    hourlyFinalizeTime: timesEnv(env.ADS_HOURLY_FINALIZE_TIME, ["02:30"])[0],
    productEnrichmentEnabled: boolEnv(env.ADS_PRODUCT_ENRICHMENT_ENABLED, false),
    productEnrichmentTtlHours: intEnv(env.ADS_PRODUCT_ENRICHMENT_TTL_HOURS, 24, 1, 30 * 24),
  };
}

/** Defaults + overrides (tests pass a few fields). */
export function resolveAdsSyncConfig(config?: Partial<AdsSyncConfig>): AdsSyncConfig {
  return { ...getAdsSyncConfig(), ...(config ?? {}) };
}

/** finalize (ADS-3A.1): yesterday's hourly rows re-read once after the day rollover (all campaigns) + reconciliation. */
/** enrichment (ADS-3A.2): product metadata of Ads-referenced items (unknown / stale / admin refresh). */
export const ADS_STRATEGIES = ["hot", "warm", "cold", "backfill", "manual", "metadata", "repair", "finalize", "enrichment"] as const;
export type AdsStrategy = (typeof ADS_STRATEGIES)[number];
/** Queue lane per strategy (one active job per shop + type + lane). */
export type AdsLane = "ads_hot" | "ads_warm" | "ads_cold" | "ads_backfill" | "ads_meta";
/** Which campaigns a campaign-performance job reads. */
export type AdsCampaignScope = "all" | "hot" | "warm";
/** Which items an enrichment job reads: unknown + stale (default), or every referenced item (admin refresh). */
export type AdsProductScope = "stale" | "all";

/**
 * Claim order (lower first). Current-day data always outranks restatement /
 * backfill; a continued slice goes to the back of its own priority line.
 * ADS-3A.1: hourly reads rank right below the daily HOT reads (hourly never
 * makes daily freshness worse); manual hourly follows every manual daily slice.
 * ADS-3A.2: product enrichment ranks below every performance read (only the
 * first backfill is lower) — metadata never delays HOT / hourly / WARM / COLD.
 */
export const ADS_PRIORITY = {
  manual: 1,
  hotShop: 2,
  metadataInitial: 2,
  manualHourly: 2,
  hotCampaign: 3,
  metadataRepair: 3,
  hotShopHourly: 4,
  hotCampaignHourly: 5,
  warm: 6,
  metadata: 7,
  cold: 8,
  hourlyFinalize: 8,
  productEnrichment: 9,
  backfill: 10,
} as const;

// ------------------------------------------------------------------ dates (pure)

const DAY_MS = 86_400_000;

/** Today's date (YYYY-MM-DD) in the shop's timezone. */
export function shopToday(now: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")}`;
}

/** Current hour (0–23) in the shop's timezone — the provider's reporting hour (never UTC). */
export function shopHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", hour: "2-digit" }).formatToParts(now).find((x) => x.type === "hour")?.value;
  return Number(h ?? 0) % 24;
}

export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** UTC instant of 00:00 of a shop-local date. */
export function zonedMidnightUtc(iso: string, timeZone: string): number {
  const guess = Date.parse(`${iso}T00:00:00Z`);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(guess));
  const v = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const asLocal = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return guess - (asLocal - guess);
}

/** HOT: today only (never inherits a restatement window). */
export function adsHotRange(now: Date, timeZone: string): AdsDateRange {
  const today = shopToday(now, timeZone);
  return { from: today, to: today };
}

/** WARM: yesterday back `warmRestatementDays` completed days; null when disabled. */
export function adsWarmRange(now: Date, timeZone: string, config: Pick<AdsSyncConfig, "warmRestatementDays">): AdsDateRange | null {
  if (config.warmRestatementDays <= 0) return null;
  const today = shopToday(now, timeZone);
  return { from: addDaysIso(today, -config.warmRestatementDays), to: addDaysIso(today, -1) };
}

/** COLD: the previous `restatementDays` completed days + today. */
export function adsColdRange(now: Date, timeZone: string, config: Pick<AdsSyncConfig, "restatementDays">): AdsDateRange {
  const today = shopToday(now, timeZone);
  return { from: addDaysIso(today, -config.restatementDays), to: today };
}

/** BACKFILL: `initialBackfillDays` + today. */
export function adsBackfillRange(now: Date, timeZone: string, config: Pick<AdsSyncConfig, "initialBackfillDays">): AdsDateRange {
  const today = shopToday(now, timeZone);
  return { from: addDaysIso(today, -config.initialBackfillDays), to: today };
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

// ------------------------------------------------------------------ data quality (pure)

/** Rows that are allowed but worth watching (never refused; negatives are refused by the mapper). */
export function adsAnomalyCodes(p: AdsPerformancePrimitives): string[] {
  const out: string[] = [];
  if (p.broadOrder < p.directOrder) out.push("broad_order_lt_direct");
  if (Number(p.broadGmv) < Number(p.directGmv)) out.push("broad_gmv_lt_direct");
  if (p.broadOrder > 0 && Number(p.broadGmv) === 0) out.push("order_without_gmv");
  return out;
}

const PRIMITIVE_COLUMNS = ["expense", "impression", "clicks", "direct_order", "broad_order", "direct_gmv", "broad_gmv", "direct_item_sold", "broad_item_sold"] as const;
type StoredFact = Record<(typeof PRIMITIVE_COLUMNS)[number], string | number> & { report_date: string; last_synced_at: string };

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

/** Fields whose stored value differs from the new one (exact decimal compare, no float math). */
export function changedPrimitives(stored: StoredFact, next: AdsPerformancePrimitives): Array<(typeof PRIMITIVE_COLUMNS)[number]> {
  const n = factColumns(next) as Record<string, string | number>;
  return PRIMITIVE_COLUMNS.filter((c) => Number(stored[c]) !== Number(n[c]));
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

// ------------------------------------------------------------------ canonical writes (bulk upserts, ≤ 500 rows per request)

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

/** Hourly shop rows: one per (shop, date, hour); a re-read of the same hour updates that row (idempotent). */
export async function upsertAdsShopHourlyFacts(db: SupabaseClient, shopId: string, rows: AdsHourlyPrimitives[], syncedAt: string) {
  for (const part of chunk(rows, UPSERT_CHUNK)) {
    const { error } = await db
      .from("shopee_ads_shop_hourly_performance")
      .upsert(part.map((r) => ({ shop_id: shopId, ...factColumns(r), report_hour: r.reportHour, last_synced_at: syncedAt })), { onConflict: "shop_id,report_date,report_hour" });
    if (error) throw new Error(`Không lưu được hiệu quả theo giờ cấp shop: ${error.message}`);
  }
}

export async function upsertAdsCampaignHourlyFacts(db: SupabaseClient, rows: Array<{ shopId: string; campaignId: string; facts: AdsHourlyPrimitives }>, syncedAt: string) {
  for (const part of chunk(rows, UPSERT_CHUNK)) {
    const { error } = await db
      .from("shopee_ads_campaign_hourly_performance")
      .upsert(part.map((r) => ({ shop_id: r.shopId, campaign_id: r.campaignId, ...factColumns(r.facts), report_hour: r.facts.reportHour, last_synced_at: syncedAt })), { onConflict: "campaign_id,report_date,report_hour" });
    if (error) throw new Error(`Không lưu được hiệu quả chiến dịch theo giờ: ${error.message}`);
  }
}

// ------------------------------------------------------------------ restatement log (completed days only)

interface RestatementSample {
  date: string;
  campaignId: string | null;
  fields: Record<string, [string, string]>;
  storedAt: string;
}

/**
 * A completed day whose stored value was read AFTER that day had ended and
 * now differs = a real provider restatement (late attribution). Values read
 * while the day was still running are partial, not restated. Counted in
 * job stats (restatedRows) with ≤ 5 samples — the evidence used to tune
 * ADS_WARM_RESTATEMENT_DAYS / ADS_PERFORMANCE_RESTATEMENT_DAYS.
 */
function recordRestatements(progress: JobProgress<unknown>, timeZone: string, today: string, pairs: Array<{ stored: StoredFact | undefined; next: AdsPerformancePrimitives; campaignId: string | null }>) {
  const samples = ((progress.meta.restatedSamples as RestatementSample[] | undefined) ?? []).slice(0, 5);
  let n = 0;
  for (const { stored, next, campaignId } of pairs) {
    if (!stored || next.reportDate >= today) continue;
    if (Date.parse(stored.last_synced_at) < zonedMidnightUtc(addDaysIso(next.reportDate, 1), timeZone)) continue;
    const fields = changedPrimitives(stored, next);
    if (!fields.length) continue;
    n++;
    if (samples.length < 5) {
      const nf = factColumns(next) as Record<string, string | number>;
      samples.push({ date: next.reportDate, campaignId, storedAt: stored.last_synced_at, fields: Object.fromEntries(fields.map((f) => [f, [String(stored[f]), String(nf[f])]])) });
    }
  }
  if (n > 0) {
    progress.incr("restatedRows", n);
    progress.meta.restatedSamples = samples;
  }
}

function recordAnomalies(progress: JobProgress<unknown>, rows: AdsPerformancePrimitives[]) {
  for (const r of rows) for (const code of adsAnomalyCodes(r)) progress.incrIn("anomalies", code);
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

const isBackfillJob = (job: SyncJobRow) => job.metadata?.strategy === "backfill" || job.mode === "backfill";

/**
 * Shopee refuses the WHOLE campaign batch when one id is not a product-ads
 * campaign: "campaign_id_list: has invalid product ads campaign ids- 20932764;".
 * Returns the refused ids that belong to the batch (empty = another error).
 */
export function invalidAdsCampaignIds(err: unknown, batch: string[]): string[] {
  if (!(err instanceof ShopeeApiError)) return [];
  const m = /invalid product ads campaign ids?\s*-?\s*([\d\s,;]+)/i.exec(err.message);
  if (!m) return [];
  const inBatch = new Set(batch);
  return [...new Set(m[1].match(/\d+/g) ?? [])].filter((id) => inBatch.has(id));
}

/** Per-type "the 30-day backfill has finished" markers (a HOT success is not a backfill). */
export async function adsBackfillStatus(db: SupabaseClient, shopId: string): Promise<{ shop: boolean; campaign: boolean }> {
  const { data, error } = await db.from("shopee_ads_shop_settings").select("shop_backfill_completed_at, campaign_backfill_completed_at").eq("shop_id", shopId).maybeSingle<{ shop_backfill_completed_at: string | null; campaign_backfill_completed_at: string | null }>();
  if (error) throw new Error(`Không đọc được trạng thái backfill Ads: ${error.message}`);
  return { shop: !!data?.shop_backfill_completed_at, campaign: !!data?.campaign_backfill_completed_at };
}

async function markAdsBackfillCompleted(db: SupabaseClient, shopId: string, column: "shop_backfill_completed_at" | "campaign_backfill_completed_at", at: Date) {
  const { error } = await db.from("shopee_ads_shop_settings").upsert({ shop_id: shopId, [column]: at.toISOString() }, { onConflict: "shop_id" });
  if (error) throw new Error(`Không lưu được trạng thái backfill Ads: ${error.message}`);
}

function jobScope(job: SyncJobRow): AdsCampaignScope {
  const s = job.metadata?.adsScope;
  return s === "hot" || s === "warm" ? s : "all";
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
  /** Product links inserted by this job (ADS-3A.2 new-item fast path). */
  linksInserted?: number;
}

interface RunnerDeps {
  db: SupabaseClient;
  provider: ShopeeAdsProvider;
  config?: Partial<AdsSyncConfig>;
}

export class AdsCampaignReadRunner implements SyncJobRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
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
      cp.linksInserted = (cp.linksInserted ?? 0) + links.inserted;
      for (const f of parsed.failures) failures.push({ externalId: f.id, reason: f.reason });
      progress.meta.adsFailures = failures.slice(0, 20);
      cp.settingsIndex++;
      if (await save()) return { kind: "cancelled" };
    }
    progress.meta.campaignsSeen = cp.ids.length;
    // ADS-3A.2 new-item fast path: a newly advertised item gets its name without waiting for the next enrichment slot.
    // Never fails the catalogue read (the scheduler's enrichment slot is the safety net).
    if ((cp.linksInserted ?? 0) > 0) {
      try {
        const r = await maybeEnqueueAdsProductEnrichment(this.deps.db, { shopId: shop.id, now: now(), config: this.deps.config });
        progress.meta.productEnrichment = r ? { jobId: r.jobId, created: r.created } : "not_needed";
      } catch (err) {
        progress.meta.productEnrichment = { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) };
      }
    }
    return doneOutcome(null, failures.length, failures[0]?.reason ?? null, now());
  }
}

interface PerformanceCheckpoint {
  windows: AdsDateRange[];
  windowIndex: number;
  batchIndex: number;
  /** Provider campaign ids of this job, frozen on the first slice (batches never shift between slices). */
  ids?: string[];
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

async function pagedProviderIds(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, pick: (row: Record<string, unknown>) => string | null): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`Không đọc được danh sách chiến dịch ứng viên: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = pick(r);
      if (id) out.add(id);
    }
    if (rows.length < 1000) return out;
  }
}

/**
 * Which campaigns a performance job reads (DB-derived, before any provider call):
 *   all   every known campaign (COLD / backfill / manual)
 *   hot   provider_status = ongoing, + status changed / ended within
 *         hotRecentStatusHours, + already non-zero in the range. Only while
 *         campaign metadata is fresh — otherwise ALL (accuracy > optimization).
 *   warm  ongoing, + status changed / ended since the window start, + non-zero
 *         stored performance in the window.
 * Non-candidates are still refreshed by COLD (all campaigns, 1–2×/day).
 */
export async function selectAdsCampaignScope(
  db: SupabaseClient,
  input: { shopId: string; scope: AdsCampaignScope; range: AdsDateRange; timeZone: string; now: Date; config: AdsSyncConfig; idMap: Map<string, string> },
): Promise<{ ids: string[]; fallback: string | null; unsupported: number }> {
  // campaigns Shopee refused as "not a product-ads campaign" are never sent again (they fail the whole batch)
  const refused = await pagedProviderIds(
    (from, to) => db.from("shopee_ads_campaigns").select("provider_campaign_id").eq("shop_id", input.shopId).not("performance_unsupported_at", "is", null).order("provider_campaign_id").range(from, to),
    (r) => String(r.provider_campaign_id),
  );
  const all = [...input.idMap.keys()].filter((id) => !refused.has(id));
  const unsupported = input.idMap.size - all.length;
  if (input.scope === "all") return { ids: all, fallback: null, unsupported };
  if (input.scope === "hot") {
    const { data: state, error } = await db.from("channel_sync_states").select("last_success_at").eq("shop_id", input.shopId).eq("sync_type", "ads_campaign_read").maybeSingle<{ last_success_at: string | null }>();
    if (error) throw new Error(`Không đọc được trạng thái danh mục chiến dịch: ${error.message}`);
    const fresh = !!state?.last_success_at && input.now.getTime() - Date.parse(state.last_success_at) < input.config.metadataStaleMinutes * 60_000;
    if (!fresh) return { ids: all, fallback: "metadata_stale", unsupported };
  }
  const sinceMs = input.scope === "hot" ? input.now.getTime() - input.config.hotRecentStatusHours * 3_600_000 : zonedMidnightUtc(input.range.from, input.timeZone);
  const since = new Date(sinceMs).toISOString();
  const nowIso = input.now.toISOString();
  const byStatus = await pagedProviderIds(
    (from, to) =>
      db
        .from("shopee_ads_campaigns")
        .select("provider_campaign_id")
        .eq("shop_id", input.shopId)
        .or(`provider_status.eq.ongoing,status_changed_at.gte.${since},and(provider_end_at.gte.${since},provider_end_at.lte.${nowIso})`)
        .order("provider_campaign_id")
        .range(from, to),
    (r) => String(r.provider_campaign_id),
  );
  const uuidToProvider = new Map([...input.idMap.entries()].map(([p, u]) => [u, p]));
  const active = await pagedProviderIds(
    (from, to) =>
      db
        .from("shopee_ads_campaign_daily_performance")
        .select("campaign_id")
        .eq("shop_id", input.shopId)
        .gte("report_date", input.range.from)
        .lte("report_date", input.range.to)
        .or("expense.gt.0,impression.gt.0,clicks.gt.0,broad_order.gt.0")
        .order("campaign_id")
        .range(from, to),
    (r) => uuidToProvider.get(String(r.campaign_id)) ?? null,
  );
  const wanted = new Set([...byStatus, ...active]);
  return { ids: all.filter((id) => wanted.has(id)), fallback: null, unsupported };
}

async function storedCampaignFacts(db: SupabaseClient, campaignIds: string[], range: AdsDateRange): Promise<Map<string, StoredFact>> {
  const out = new Map<string, StoredFact>();
  if (!campaignIds.length) return out;
  const { data, error } = await db
    .from("shopee_ads_campaign_daily_performance")
    .select(`campaign_id, report_date, last_synced_at, ${PRIMITIVE_COLUMNS.join(", ")}`)
    .in("campaign_id", campaignIds)
    .gte("report_date", range.from)
    .lte("report_date", range.to);
  if (error) throw new Error(`Không đọc được hiệu quả chiến dịch đã lưu: ${error.message}`);
  for (const r of (data ?? []) as unknown as Array<StoredFact & { campaign_id: string }>) out.set(`${r.campaign_id}|${r.report_date}`, r);
  return out;
}

export class AdsCampaignPerformanceReadRunner implements SyncJobRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const config = resolveAdsSyncConfig(this.deps.config);
    const progress = input.progress as SliceInput<PerformanceCheckpoint>["progress"];
    const shop = await loadAdsShop(this.deps.db, job.shop_id);
    const ctx: AdsProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    const range = jobRange(job);
    const idMap = await loadAdsCampaignIds(this.deps.db, shop.id);
    if (!progress.checkpoint) {
      // The catalogue is written page by page: until ads_campaign_read has finished once, a partial
      // catalogue would freeze a partial id list (850 of 1135 campaigns, 2026-10-29) → wait (retry with backoff, no provider call).
      const { data: catalogue, error: catalogueError } = await this.deps.db.from("channel_sync_states").select("last_success_at").eq("shop_id", shop.id).eq("sync_type", "ads_campaign_read").maybeSingle<{ last_success_at: string | null }>();
      if (catalogueError) throw new Error(`Không đọc được trạng thái danh mục chiến dịch: ${catalogueError.message}`);
      if (!catalogue?.last_success_at) throw new AdsDependencyPendingError();
      const scope = await selectAdsCampaignScope(this.deps.db, { shopId: shop.id, scope: jobScope(job), range, timeZone: shop.timezone, now: now(), config, idMap });
      progress.checkpoint = { windows: splitAdsRange(range, ADS_CAMPAIGN_RANGE_DAYS), windowIndex: 0, batchIndex: 0, ids: scope.ids };
      progress.meta.campaignScope = { scope: jobScope(job), candidates: scope.ids.length, known: idMap.size, fallback: scope.fallback, unsupported: scope.unsupported };
    }
    const cp = progress.checkpoint;
    let batches = chunk(cp.ids ?? [...idMap.keys()], ADS_ID_BATCH);
    const failures = (progress.meta.adsFailures as FailureList | undefined) ?? [];
    const today = shopToday(now(), shop.timezone);
    let callsThisSlice = 0;

    while (cp.windowIndex < cp.windows.length) {
      while (cp.batchIndex < batches.length) {
        if (!budget.canSpend(1)) return continuation(budget, "more_records");
        // rotate: after N batches the job goes to the back of its priority line (other shops get a turn)
        if (callsThisSlice >= config.batchesPerSlice) return { kind: "more", reason: "batch_limit", remaining: "more_records" };
        const window = cp.windows[cp.windowIndex];
        const batch = batches[cp.batchIndex];
        let payload: ProviderPayload;
        try {
          payload = await this.deps.provider.getProductCampaignDailyPerformance(ctx, { campaignIds: batch, range: window });
        } catch (err) {
          const refused = invalidAdsCampaignIds(err, batch);
          if (!refused.length) throw err;
          // one non-product-ads id fails the whole batch: drop it (remembered for later jobs) and re-read the same batch
          callsThisSlice++;
          const refusedSet = new Set(refused);
          cp.ids = (cp.ids ?? [...idMap.keys()]).filter((id) => !refusedSet.has(id));
          batches = chunk(cp.ids, ADS_ID_BATCH);
          await markAdsCampaignsUnsupported(this.deps.db, shop.id, refused, now());
          const dropped = (progress.meta.unsupportedCampaignIds as string[] | undefined) ?? [];
          progress.meta.unsupportedCampaignIds = [...dropped, ...refused].slice(0, 50);
          if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
          continue;
        }
        callsThisSlice++;
        const syncedAt = now().toISOString();
        await saveAdsSnapshot(this.deps.db, { shopId: shop.id, payload, key: `campaign_daily:${window.from}:${window.to}:${batch[0]}:${batch.length}`, sourceMode: this.deps.provider.mode, syncedAt });
        const parsed = parseCampaignDailyPerformance(payload.raw);
        let unknown = 0;
        const rows = parsed.rows.flatMap((r) => {
          const campaignId = idMap.get(r.providerCampaignId);
          if (!campaignId) {
            unknown++;
            failures.push({ externalId: r.providerCampaignId, reason: "Chiến dịch chưa có trong danh mục (đã yêu cầu đọc lại danh mục)." });
            return [];
          }
          return [{ shopId: shop.id, campaignId, facts: r }];
        });
        if (window.from < today) {
          const stored = await storedCampaignFacts(this.deps.db, rows.map((r) => r.campaignId), window);
          recordRestatements(progress, shop.timezone, today, rows.map((r) => ({ stored: stored.get(`${r.campaignId}|${r.facts.reportDate}`), next: r.facts, campaignId: r.facts.providerCampaignId })));
        }
        await upsertAdsCampaignFacts(this.deps.db, rows, syncedAt);
        recordAnomalies(progress, rows.map((r) => r.facts));
        if (unknown > 0 && !progress.meta.metadataRepairJobId) {
          // fast path: never wait for the 6-hour metadata cycle
          const repair = await enqueueAdsJob(this.deps.db, { shopId: shop.id, syncType: "ads_campaign_read", strategy: "repair", priority: ADS_PRIORITY.metadataRepair, now: now() });
          progress.meta.metadataRepairJobId = repair.jobId;
        }
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
    if (isBackfillJob(job)) await markAdsBackfillCompleted(this.deps.db, shop.id, "campaign_backfill_completed_at", now());
    return doneOutcome(range, failures.length, failures[0]?.reason ?? null, now());
  }
}

async function markAdsCampaignsUnsupported(db: SupabaseClient, shopId: string, providerIds: string[], at: Date) {
  const { error } = await db.from("shopee_ads_campaigns").update({ performance_unsupported_at: at.toISOString() }).eq("shop_id", shopId).in("provider_campaign_id", providerIds);
  if (error) throw new Error(`Không lưu được chiến dịch Shopee từ chối: ${error.message}`);
}

export class AdsShopPerformanceReadRunner implements SyncJobRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const progress = input.progress as SliceInput<{ windows: AdsDateRange[]; windowIndex: number }>["progress"];
    const shop = await loadAdsShop(this.deps.db, job.shop_id);
    const ctx: AdsProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    const range = jobRange(job);
    const today = shopToday(now(), shop.timezone);
    progress.checkpoint ??= { windows: splitAdsRange(range, ADS_SHOP_RANGE_DAYS), windowIndex: 0 };
    const cp = progress.checkpoint;
    while (cp.windowIndex < cp.windows.length) {
      if (!budget.canSpend(1)) return continuation(budget, "more_records");
      const window = cp.windows[cp.windowIndex];
      const payload = await this.deps.provider.getAllCpcAdsDailyPerformance(ctx, { range: window });
      const syncedAt = now().toISOString();
      await saveAdsSnapshot(this.deps.db, { shopId: shop.id, payload, key: `shop_daily:${window.from}:${window.to}`, sourceMode: this.deps.provider.mode, syncedAt });
      const parsed = parseShopDailyPerformance(payload.raw);
      if (window.from < today) {
        const { data: stored, error } = await this.deps.db
          .from("shopee_ads_shop_daily_performance")
          .select(`report_date, last_synced_at, ${PRIMITIVE_COLUMNS.join(", ")}`)
          .eq("shop_id", shop.id)
          .gte("report_date", window.from)
          .lte("report_date", window.to);
        if (error) throw new Error(`Không đọc được hiệu quả cấp shop đã lưu: ${error.message}`);
        const byDate = new Map(((stored ?? []) as unknown as StoredFact[]).map((r) => [r.report_date, r]));
        recordRestatements(progress, shop.timezone, today, parsed.rows.map((r) => ({ stored: byDate.get(r.reportDate), next: r, campaignId: null })));
      }
      await upsertAdsShopFacts(this.deps.db, shop.id, parsed.rows, syncedAt);
      recordAnomalies(progress, parsed.rows);
      progress.counters.fetched += parsed.rows.length;
      progress.counters.updated += parsed.rows.length;
      progress.incr("missingFields", parsed.missingFields);
      cp.windowIndex++;
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }
    progress.meta.lastReportDate = range.to;
    if (isBackfillJob(job)) await markAdsBackfillCompleted(this.deps.db, shop.id, "shop_backfill_completed_at", now());
    return doneOutcome(range, 0, null, now());
  }
}

// ------------------------------------------------------------------ hourly runners (ADS-3A.1)

/** An hourly job reads at most this many dates (normally 1: today, or yesterday for finalize). */
const ADS_HOURLY_MAX_DATES = 3;

function hourlyDates(range: AdsDateRange, today: string): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to && d <= today; d = addDaysIso(d, 1)) out.push(d);
  if (out.length > ADS_HOURLY_MAX_DATES) throw new Error(`Job theo giờ: tối đa ${ADS_HOURLY_MAX_DATES} ngày (nhận ${out.length}).`);
  return out;
}

/**
 * Rows of one hourly payload that may be stored: the requested date only, and
 * for TODAY only the hours that have started (≤ current shop-local hour) — a
 * later hour cannot hold data yet and is never stored as a "0" hour.
 * Counted, never silently dropped (futureHours is also the production evidence
 * of what Shopee returns for hours that have not happened yet).
 */
export function storableHourlyRows<T extends AdsHourlyPrimitives>(rows: T[], input: { date: string; today: string; currentHour: number }): { rows: T[]; futureHours: number; otherDates: number } {
  let futureHours = 0;
  let otherDates = 0;
  const kept = rows.filter((r) => {
    if (r.reportDate !== input.date) return (otherDates++, false);
    if (r.reportDate === input.today && r.reportHour > input.currentHour) return (futureHours++, false);
    return true;
  });
  return { rows: kept, futureHours, otherDates };
}

/** Hours (of the hours that should exist) the provider did not return — counted, never fabricated. */
function missingHours(hours: Iterable<number>, date: string, today: string, currentHour: number): number {
  const expected = date === today ? currentHour + 1 : 24;
  const have = new Set([...hours].filter((h) => h < expected));
  return expected - have.size;
}

/** After a completed day was re-read: hourly Σ vs daily facts, kept on the job (data-quality flag). */
async function recordHourlyReconciliation(db: SupabaseClient, progress: JobProgress<unknown>, shopId: string, dates: string[], today: string) {
  const completed = dates.filter((d) => d < today);
  if (!completed.length) return;
  const rows = await loadAdsHourlyReconciliation(db, [shopId], { from: completed[0], to: completed.at(-1)! });
  const out = rows.map((r) => adsHourlyReconciliation(r, today));
  for (const r of out) progress.incrIn("reconciliation", r.status);
  progress.meta.reconciliation = out.map((r) => ({ date: r.date, status: r.status, shopExpenseDelta: r.shop.expenseDelta, reasons: r.reasons.slice(0, 5) }));
}

export class AdsShopHourlyReadRunner implements SyncJobRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const progress = input.progress as SliceInput<{ dates: string[]; index: number }>["progress"];
    const shop = await loadAdsShop(this.deps.db, job.shop_id);
    const ctx: AdsProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    const range = jobRange(job);
    const today = shopToday(now(), shop.timezone);
    progress.checkpoint ??= { dates: hourlyDates(range, today), index: 0 };
    const cp = progress.checkpoint;
    while (cp.index < cp.dates.length) {
      if (!budget.canSpend(1)) return continuation(budget, "more_records");
      const date = cp.dates[cp.index];
      const payload = await this.deps.provider.getAllCpcAdsHourlyPerformance(ctx, { date });
      const syncedAt = now().toISOString();
      await saveAdsSnapshot(this.deps.db, { shopId: shop.id, payload, key: `shop_hourly:${date}`, sourceMode: this.deps.provider.mode, syncedAt });
      const parsed = parseShopHourlyPerformance(payload.raw);
      // the current hour is read at the moment of the call (a later slice must not reuse an older "now")
      const stored = storableHourlyRows(parsed.rows, { date, today: shopToday(now(), shop.timezone), currentHour: shopHour(now(), shop.timezone) });
      await upsertAdsShopHourlyFacts(this.deps.db, shop.id, stored.rows, syncedAt);
      recordAnomalies(progress, stored.rows);
      progress.counters.fetched += parsed.rows.length;
      progress.counters.updated += stored.rows.length;
      progress.incr("missingFields", parsed.missingFields);
      progress.incr("futureHours", stored.futureHours);
      progress.incr("otherDateRows", stored.otherDates);
      progress.incr("missingHours", missingHours(stored.rows.map((r) => r.reportHour), date, shopToday(now(), shop.timezone), shopHour(now(), shop.timezone)));
      cp.index++;
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }
    progress.meta.lastReportDate = range.to;
    if (job.metadata?.strategy === "finalize") await recordHourlyReconciliation(this.deps.db, progress, shop.id, cp.dates, today);
    return doneOutcome(range, 0, null, now());
  }
}

interface HourlyCampaignCheckpoint {
  dates: string[];
  dateIndex: number;
  batchIndex: number;
  ids: string[];
}

export class AdsCampaignHourlyReadRunner implements SyncJobRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const config = resolveAdsSyncConfig(this.deps.config);
    const progress = input.progress as SliceInput<HourlyCampaignCheckpoint>["progress"];
    const shop = await loadAdsShop(this.deps.db, job.shop_id);
    const ctx: AdsProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    const range = jobRange(job);
    const today = shopToday(now(), shop.timezone);
    const idMap = await loadAdsCampaignIds(this.deps.db, shop.id);
    if (!progress.checkpoint) {
      // same rule as the daily read: never freeze the ids of a catalogue that is still being written
      const { data: catalogue, error: catalogueError } = await this.deps.db.from("channel_sync_states").select("last_success_at").eq("shop_id", shop.id).eq("sync_type", "ads_campaign_read").maybeSingle<{ last_success_at: string | null }>();
      if (catalogueError) throw new Error(`Không đọc được trạng thái danh mục chiến dịch: ${catalogueError.message}`);
      if (!catalogue?.last_success_at) throw new AdsDependencyPendingError();
      // HOT candidates for today (same DB-derived rule as the daily HOT read); finalize / manual read ALL campaigns
      const scope = await selectAdsCampaignScope(this.deps.db, { shopId: shop.id, scope: jobScope(job), range, timeZone: shop.timezone, now: now(), config, idMap });
      progress.checkpoint = { dates: hourlyDates(range, today), dateIndex: 0, batchIndex: 0, ids: scope.ids };
      progress.meta.campaignScope = { scope: jobScope(job), candidates: scope.ids.length, known: idMap.size, fallback: scope.fallback, unsupported: scope.unsupported };
    }
    const cp = progress.checkpoint;
    let batches = chunk(cp.ids, ADS_ID_BATCH);
    const failures = (progress.meta.adsFailures as FailureList | undefined) ?? [];
    let callsThisSlice = 0;

    while (cp.dateIndex < cp.dates.length) {
      while (cp.batchIndex < batches.length) {
        if (!budget.canSpend(1)) return continuation(budget, "more_records");
        if (callsThisSlice >= config.batchesPerSlice) return { kind: "more", reason: "batch_limit", remaining: "more_records" };
        const date = cp.dates[cp.dateIndex];
        const batch = batches[cp.batchIndex];
        let payload: ProviderPayload;
        try {
          payload = await this.deps.provider.getProductCampaignHourlyPerformance(ctx, { campaignIds: batch, date });
        } catch (err) {
          const refused = invalidAdsCampaignIds(err, batch);
          if (!refused.length) throw err;
          callsThisSlice++;
          const refusedSet = new Set(refused);
          cp.ids = cp.ids.filter((id) => !refusedSet.has(id));
          batches = chunk(cp.ids, ADS_ID_BATCH);
          await markAdsCampaignsUnsupported(this.deps.db, shop.id, refused, now());
          progress.meta.unsupportedCampaignIds = [...((progress.meta.unsupportedCampaignIds as string[] | undefined) ?? []), ...refused].slice(0, 50);
          if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
          continue;
        }
        callsThisSlice++;
        const syncedAt = now().toISOString();
        await saveAdsSnapshot(this.deps.db, { shopId: shop.id, payload, key: `campaign_hourly:${date}:${batch[0]}:${batch.length}`, sourceMode: this.deps.provider.mode, syncedAt });
        const parsed = parseCampaignHourlyPerformance(payload.raw);
        const stored = storableHourlyRows(parsed.rows, { date, today: shopToday(now(), shop.timezone), currentHour: shopHour(now(), shop.timezone) });
        let unknown = 0;
        const rows = stored.rows.flatMap((r) => {
          const campaignId = idMap.get(r.providerCampaignId);
          if (!campaignId) {
            unknown++;
            if (!failures.some((f) => f.externalId === r.providerCampaignId)) failures.push({ externalId: r.providerCampaignId, reason: "Chiến dịch chưa có trong danh mục (đã yêu cầu đọc lại danh mục)." });
            return [];
          }
          return [{ shopId: shop.id, campaignId, facts: r }];
        });
        await upsertAdsCampaignHourlyFacts(this.deps.db, rows, syncedAt);
        recordAnomalies(progress, rows.map((r) => r.facts));
        if (unknown > 0 && !progress.meta.metadataRepairJobId) {
          const repair = await enqueueAdsJob(this.deps.db, { shopId: shop.id, syncType: "ads_campaign_read", strategy: "repair", priority: ADS_PRIORITY.metadataRepair, now: now() });
          progress.meta.metadataRepairJobId = repair.jobId;
        }
        progress.counters.fetched += parsed.rows.length;
        progress.counters.updated += rows.length;
        progress.counters.failed += parsed.failures.length;
        progress.incr("missingFields", parsed.missingFields);
        progress.incr("futureHours", stored.futureHours);
        progress.incr("otherDateRows", stored.otherDates);
        for (const f of parsed.failures) failures.push({ externalId: f.id, reason: f.reason });
        progress.meta.adsFailures = failures.slice(0, 20);
        cp.batchIndex++;
        if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
      }
      cp.batchIndex = 0;
      cp.dateIndex++;
    }
    progress.meta.lastReportDate = range.to;
    if (job.metadata?.strategy === "finalize") await recordHourlyReconciliation(this.deps.db, progress, shop.id, cp.dates, today);
    return doneOutcome(range, failures.length, failures[0]?.reason ?? null, now());
  }
}

/** Retryable: the campaign catalogue is not there yet (backoff, then the job runs again). */
// ------------------------------------------------------------------ ADS-3A.2 product enrichment (READ ONLY, cache-first)

/** get_item_base_info fields kept in the snapshot: a projection (no description / attributes / logistics / promotion data). */
const ITEM_SNAPSHOT_FIELDS = ["item_id", "item_name", "item_sku", "item_status", "image", "has_model", "update_time"];

export function projectItemBaseInfo(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const envelope = raw as Record<string, unknown>;
  const response = envelope.response && typeof envelope.response === "object" ? (envelope.response as Record<string, unknown>) : null;
  if (!response || !Array.isArray(response.item_list)) return raw;
  const item_list = response.item_list.map((it) =>
    it && typeof it === "object" ? Object.fromEntries(Object.entries(it as Record<string, unknown>).filter(([k]) => ITEM_SNAPSHOT_FIELDS.includes(k))) : it,
  );
  return { ...envelope, response: { ...response, item_list } };
}

/** Items last checked before this instant are stale (ADS_PRODUCT_ENRICHMENT_TTL_HOURS). */
export function adsProductStaleBefore(now: Date, config: Pick<AdsSyncConfig, "productEnrichmentTtlHours">): string {
  return new Date(now.getTime() - config.productEnrichmentTtlHours * 3_600_000).toISOString();
}

export interface AdsProductEnrichmentStatus {
  shopId: string;
  /** Distinct items referenced by the shop's Ads campaigns. */
  referenced: number;
  enriched: number;
  notReturned: number;
  /** Referenced but never read. */
  missing: number;
  /** Read before the TTL. */
  stale: number;
  withImage: number;
  withSku: number;
  lastEnrichedAt: string | null;
}

export async function loadAdsProductEnrichmentStatus(db: SupabaseClient, shopIds: string[], staleBefore: string): Promise<AdsProductEnrichmentStatus[]> {
  if (!shopIds.length) return [];
  const { data, error } = await db.rpc("ads_product_enrichment_summary", { p_shop_ids: shopIds, p_stale_before: staleBefore });
  if (error) throw new Error(`Không đọc được trạng thái thông tin sản phẩm: ${error.message}`);
  type Row = { shop_id: string; referenced: number; enriched: number; not_returned: number; missing: number; stale: number; with_image: number; with_sku: number; last_enriched_at: string | null };
  return ((data ?? []) as Row[]).map((r) => ({
    shopId: r.shop_id,
    referenced: Number(r.referenced),
    enriched: Number(r.enriched),
    notReturned: Number(r.not_returned),
    missing: Number(r.missing),
    stale: Number(r.stale),
    withImage: Number(r.with_image),
    withSku: Number(r.with_sku),
    lastEnrichedAt: r.last_enriched_at,
  }));
}

/** Per-shop enrichment switch (shopee_ads_shop_settings.ads_product_enrichment_enabled, default OFF). */
export async function adsProductEnrichmentEnabled(db: SupabaseClient, shopId: string): Promise<boolean> {
  const { data, error } = await db.from("shopee_ads_shop_settings").select("ads_product_enrichment_enabled").eq("shop_id", shopId).maybeSingle<{ ads_product_enrichment_enabled: boolean }>();
  if (error) throw new Error(`Không đọc được cấu hình thông tin sản phẩm: ${error.message}`);
  return !!data?.ads_product_enrichment_enabled;
}

/** PostgREST returns ≤ 1000 rows: one job reads at most this many items; the next slot continues (unknown items first). */
const ENRICHMENT_MAX_ITEMS_PER_JOB = 1000;

/**
 * Enqueues an enrichment job only when it would read something: global flag +
 * shop switch on, and (unless an admin forces every item) at least one
 * referenced item is unknown or stale. Fresh cache → no job, no provider call.
 */
export async function maybeEnqueueAdsProductEnrichment(
  db: SupabaseClient,
  input: { shopId: string; now?: Date; config?: Partial<AdsSyncConfig>; scope?: AdsProductScope; createdBy?: string | null; notBefore?: Date | null; mode?: SyncMode },
): Promise<AdsEnqueueResult | null> {
  const now = input.now ?? new Date();
  const config = resolveAdsSyncConfig(input.config);
  if (!config.productEnrichmentEnabled || !(await adsProductEnrichmentEnabled(db, input.shopId))) return null;
  const scope = input.scope ?? "stale";
  if (scope === "stale") {
    const [status] = await loadAdsProductEnrichmentStatus(db, [input.shopId], adsProductStaleBefore(now, config));
    if (!status || status.missing + status.stale === 0) return null;
  }
  return enqueueAdsJob(db, { shopId: input.shopId, syncType: "ads_product_enrichment_read", strategy: "enrichment", priority: ADS_PRIORITY.productEnrichment, scope, now, notBefore: input.notBefore ?? null, createdBy: input.createdBy ?? null, mode: input.mode });
}

/**
 * Returned items → current metadata (a rename simply updates the row; campaign
 * history is untouched). Returns how many rows were new / changed.
 */
export async function upsertAdsProducts(db: SupabaseClient, shopId: string, items: AdsProductWrite[], checkedAt: string): Promise<{ created: number; changed: number; renamed: number }> {
  if (!items.length) return { created: 0, changed: 0, renamed: 0 };
  const { data: existing, error } = await db
    .from("shopee_ads_products")
    .select("provider_item_id, product_name, image_url, item_sku, provider_status, enrichment_status")
    .eq("shop_id", shopId)
    .in("provider_item_id", items.map((i) => i.providerItemId));
  if (error) throw new Error(`Không đọc được thông tin sản phẩm: ${error.message}`);
  type Row = { provider_item_id: string; product_name: string | null; image_url: string | null; item_sku: string | null; provider_status: string | null; enrichment_status: string };
  const have = new Map(((existing ?? []) as Row[]).map((r) => [r.provider_item_id, r]));
  let created = 0;
  let changed = 0;
  let renamed = 0;
  for (const i of items) {
    const old = have.get(i.providerItemId);
    if (!old) created++;
    else if (old.product_name !== i.productName || old.image_url !== i.imageUrl || old.item_sku !== i.itemSku || old.provider_status !== i.providerStatus || old.enrichment_status !== "enriched") changed++;
    if (old && old.product_name !== null && old.product_name !== i.productName) renamed++;
  }
  for (const part of chunk(items, UPSERT_CHUNK)) {
    const { error: upError } = await db.from("shopee_ads_products").upsert(
      part.map((i) => ({
        shop_id: shopId,
        provider_item_id: i.providerItemId,
        product_name: i.productName,
        image_url: i.imageUrl,
        item_sku: i.itemSku,
        provider_status: i.providerStatus,
        enrichment_status: "enriched",
        last_enriched_at: checkedAt,
        last_checked_at: checkedAt,
      })),
      { onConflict: "shop_id,provider_item_id" },
    );
    if (upError) throw new Error(`Không lưu được thông tin sản phẩm: ${upError.message}`);
  }
  return { created, changed, renamed };
}

/**
 * Items the provider did not return: only the status + check time change —
 * metadata of an earlier read is kept, nothing is deleted (meaning unverified).
 */
export async function markAdsProductsNotReturned(db: SupabaseClient, shopId: string, itemIds: string[], checkedAt: string): Promise<void> {
  for (const part of chunk(itemIds, UPSERT_CHUNK)) {
    const { error } = await db
      .from("shopee_ads_products")
      .upsert(part.map((id) => ({ shop_id: shopId, provider_item_id: id, enrichment_status: "not_returned", last_checked_at: checkedAt })), { onConflict: "shop_id,provider_item_id" });
    if (error) throw new Error(`Không lưu được trạng thái sản phẩm: ${error.message}`);
  }
}

interface EnrichmentCheckpoint {
  /** Item ids of this job, frozen on the first slice (batches never shift between slices). */
  ids: string[];
  batchIndex: number;
}

export class AdsProductEnrichmentReadRunner implements SyncJobRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const config = resolveAdsSyncConfig(this.deps.config);
    const progress = input.progress as SliceInput<EnrichmentCheckpoint>["progress"];
    const shop = await loadAdsShop(this.deps.db, job.shop_id);
    const ctx: AdsProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    if (!progress.checkpoint) {
      // switched off since the job was queued → finish without any provider call
      if (!config.productEnrichmentEnabled || !(await adsProductEnrichmentEnabled(this.deps.db, shop.id))) {
        progress.meta.skipped = "disabled";
        return doneOutcome(null, 0, null, now());
      }
      const force = job.metadata?.adsScope === "all";
      const staleBefore = adsProductStaleBefore(now(), config);
      const [status] = await loadAdsProductEnrichmentStatus(this.deps.db, [shop.id], staleBefore);
      const { data, error } = await this.deps.db.rpc("ads_product_enrichment_candidates", { p_shop_id: shop.id, p_stale_before: staleBefore, p_force: force, p_limit: ENRICHMENT_MAX_ITEMS_PER_JOB });
      if (error) throw new Error(`Không đọc được danh sách sản phẩm cần bổ sung: ${error.message}`);
      const candidates = (data ?? []) as Array<{ provider_item_id: string; reason: string }>;
      progress.checkpoint = { ids: [...new Set(candidates.map((c) => c.provider_item_id))], batchIndex: 0 };
      const referenced = status?.referenced ?? 0;
      progress.meta.productScope = {
        scope: force ? "all" : "stale",
        referenced,
        candidates: progress.checkpoint.ids.length,
        missing: candidates.filter((c) => c.reason === "missing").length,
        stale: candidates.filter((c) => c.reason === "stale").length,
        // product_enrichment_cache_hit_rate: referenced items served from the canonical cache (no provider call)
        cacheHits: Math.max(0, referenced - progress.checkpoint.ids.length),
        cacheHitRate: referenced > 0 ? Math.round((Math.max(0, referenced - progress.checkpoint.ids.length) / referenced) * 10_000) / 10_000 : null,
        ttlHours: config.productEnrichmentTtlHours,
      };
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint;
    const batches = chunk(cp.ids, ADS_ITEM_BATCH);
    const failures = (progress.meta.adsFailures as FailureList | undefined) ?? [];
    let callsThisSlice = 0;
    while (cp.batchIndex < batches.length) {
      if (!budget.canSpend(1)) return continuation(budget, "more_records");
      // bounded work: large need-sets yield to performance jobs between slices
      if (callsThisSlice >= config.batchesPerSlice) return { kind: "more", reason: "batch_limit", remaining: "more_records" };
      const batch = batches[cp.batchIndex];
      const payload = await this.deps.provider.getItemBaseInfo(ctx, { itemIds: batch });
      callsThisSlice++;
      const checkedAt = now().toISOString();
      await saveAdsSnapshot(this.deps.db, { shopId: shop.id, payload: { ...payload, raw: projectItemBaseInfo(payload.raw) }, key: `item_base_info:${batch[0]}:${batch.length}`, sourceMode: this.deps.provider.mode, syncedAt: checkedAt });
      const parsed = parseItemBaseInfo(payload.raw, batch);
      const written = await upsertAdsProducts(this.deps.db, shop.id, parsed.items, checkedAt);
      await markAdsProductsNotReturned(this.deps.db, shop.id, parsed.notReturned, checkedAt);
      progress.counters.fetched += parsed.items.length;
      progress.counters.created += written.created;
      progress.counters.updated += written.changed;
      progress.counters.failed += parsed.failures.length;
      progress.incr("itemsRequested", batch.length);
      progress.incr("itemsReturned", parsed.items.length);
      progress.incr("itemsNotReturned", parsed.notReturned.length);
      progress.incr("imagesRejected", parsed.imagesRejected);
      progress.incr("productsRenamed", written.renamed);
      for (const f of parsed.failures) failures.push({ externalId: f.id, reason: f.reason });
      progress.meta.adsFailures = failures.slice(0, 20);
      cp.batchIndex++;
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }
    return doneOutcome(null, failures.length, failures[0]?.reason ?? null, now());
  }
}

export class AdsDependencyPendingError extends Error {
  readonly code = "ads_campaigns_pending";
  constructor() {
    super("Chưa có danh mục chiến dịch — chờ đồng bộ chiến dịch (ads_campaign_read) xong.");
    this.name = "AdsDependencyPendingError";
  }
}

export function createAdsRunner(job: SyncJobRow, deps: RunnerDeps): SyncJobRunner {
  switch (job.sync_type) {
    case "ads_campaign_read":
      return new AdsCampaignReadRunner(deps);
    case "ads_campaign_performance_read":
      return new AdsCampaignPerformanceReadRunner(deps);
    case "ads_shop_performance_read":
      return new AdsShopPerformanceReadRunner(deps);
    case "ads_shop_hourly_read":
      return new AdsShopHourlyReadRunner(deps);
    case "ads_campaign_hourly_read":
      return new AdsCampaignHourlyReadRunner(deps);
    case "ads_product_enrichment_read":
      return new AdsProductEnrichmentReadRunner(deps);
    default:
      throw new Error(`Không phải job Ads: ${job.sync_type}`);
  }
}

// ------------------------------------------------------------------ enqueue (dedupe + coalescing in the DB)

// finalize reads a COMPLETED day only → the WARM lane (never counted as today's freshness, never blocks HOT)
const LANE_OF: Record<AdsStrategy, AdsLane> = { hot: "ads_hot", manual: "ads_hot", warm: "ads_warm", cold: "ads_cold", backfill: "ads_backfill", metadata: "ads_meta", repair: "ads_meta", finalize: "ads_warm", enrichment: "ads_meta" };

/** Catalogue and product metadata always run in the metadata lane (one active job per shop + type). */
export function adsLaneFor(syncType: AdsSyncType, strategy: AdsStrategy): AdsLane {
  return syncType === "ads_campaign_read" || syncType === "ads_product_enrichment_read" ? "ads_meta" : LANE_OF[strategy];
}

export interface AdsEnqueueInput {
  shopId: string;
  syncType: AdsSyncType;
  strategy: AdsStrategy;
  priority: number;
  range?: AdsDateRange | null;
  scope?: AdsCampaignScope | AdsProductScope;
  /** Not claimable before this instant (stagger jitter). */
  notBefore?: Date | null;
  createdBy?: string | null;
  now?: Date;
  /** false = never reuse a broader job (tests). */
  coalesce?: boolean;
  /** Override the queue mode (user-initiated jobs are "manual": they run even while the shop's automatic sync is paused). */
  mode?: SyncMode;
}

export interface AdsEnqueueResult {
  jobId: string;
  created: boolean;
  /** Reused an active job that already covers this request (or widened a queued one). */
  coalesced: boolean;
  status: string;
  lane: string;
  priority: number;
}

/**
 * Canonical job identity = shop + sync_type + lane (+ range / scope in
 * metadata). The DB function decides atomically: reuse a covering active job
 * (raising its priority), insert, or widen a queued job of the same lane.
 */
export async function enqueueAdsJob(db: SupabaseClient, input: AdsEnqueueInput): Promise<AdsEnqueueResult> {
  const mode: SyncMode = input.mode ?? (input.strategy === "manual" ? "manual" : input.strategy === "backfill" ? "backfill" : "incremental");
  const metadata: Record<string, unknown> = { strategy: input.strategy, requestedAt: (input.now ?? new Date()).toISOString() };
  if (input.syncType === "ads_campaign_performance_read" || input.syncType === "ads_campaign_hourly_read") metadata.adsScope = input.scope ?? "all";
  // enrichment: "stale" (unknown + TTL-expired items) unless an admin asked for every referenced item ("all" covers "stale")
  if (input.syncType === "ads_product_enrichment_read") metadata.adsScope = input.scope === "all" ? "all" : "stale";
  const ranged = input.syncType !== "ads_campaign_read" && input.syncType !== "ads_product_enrichment_read";
  if (ranged && !input.range) throw new Error("Job hiệu quả Ads cần khoảng ngày.");
  const { data, error } = await db
    .rpc("enqueue_ads_sync_job", {
      p_shop_id: input.shopId,
      p_sync_type: input.syncType,
      p_lane: adsLaneFor(input.syncType, input.strategy),
      p_mode: mode,
      p_priority: input.priority,
      p_metadata: metadata,
      p_from: ranged ? input.range!.from : null,
      p_to: ranged ? input.range!.to : null,
      p_not_before: input.notBefore?.toISOString() ?? null,
      p_created_by: input.createdBy ?? null,
      p_coalesce: input.coalesce ?? true,
    })
    .single<{ job_id: string; created: boolean; status: string; coalesced: boolean; job_lane: string; job_priority: number }>();
  if (error || !data) throw new Error(`Không tạo được job Ads: ${error?.message ?? "unknown"}`);
  return { jobId: data.job_id, created: data.created, coalesced: data.coalesced, status: data.status, lane: data.job_lane, priority: data.job_priority };
}

// ------------------------------------------------------------------ freshness (DB only)

/**
 * When TODAY's shop total and campaign facts were last read (latest successful
 * read whose window includes today; WARM never counts). Same RPC as the
 * dashboard freshness, so "Dữ liệu vừa được đồng bộ" matches what the page shows.
 */
export async function adsTodayFreshness(db: SupabaseClient, shopId: string): Promise<{ shop: string | null; campaign: string | null }> {
  const { data, error } = await db.rpc("ads_sync_freshness", { p_shop_ids: [shopId] });
  if (error) throw new Error(`Không đọc được độ mới dữ liệu Ads: ${error.message}`);
  const row = ((data ?? []) as Array<{ shop_today_at: string | null; campaign_today_at: string | null }>)[0];
  return { shop: row?.shop_today_at ?? null, campaign: row?.campaign_today_at ?? null };
}

// ------------------------------------------------------------------ manual "Làm mới dữ liệu"

export interface AdsRefreshResult {
  shopId: string;
  /** poll = the button waits for it; background jobs (WARM catch-up) are not awaited. */
  jobs: Array<{ syncType: AdsSyncType; strategy: AdsStrategy; jobId: string; created: boolean; coalesced: boolean; status: string; poll: boolean }>;
  range: AdsDateRange;
  initial: boolean;
  /** HOT data is newer than manualDedupeMinutes → nothing enqueued. */
  fresh: boolean;
}

/**
 * Same queue as the scheduler, highest priority:
 *   never synced     → metadata + 30-day backfill
 *   recently synced  → nothing ("Dữ liệu vừa được đồng bộ") unless `force`
 *   otherwise        → today (shop + ALL campaigns), metadata when stale,
 *                      plus a background WARM catch-up when no WARM ran
 *                      within its interval (e.g. auto sync still off)
 */
export async function requestAdsRefresh(
  db: SupabaseClient,
  input: { shopId: string; now?: Date; createdBy?: string | null; config?: Partial<AdsSyncConfig>; force?: boolean },
): Promise<AdsRefreshResult> {
  const now = input.now ?? new Date();
  const config = resolveAdsSyncConfig(input.config);
  const shop = await loadAdsShop(db, input.shopId);
  const { data: states, error } = await db.from("channel_sync_states").select("sync_type, last_success_at").eq("shop_id", shop.id).in("sync_type", ["ads_campaign_read", "ads_campaign_performance_read", "ads_shop_performance_read"]);
  if (error) throw new Error(`Không đọc được trạng thái đồng bộ Ads: ${error.message}`);
  const last = new Map(((states ?? []) as Array<{ sync_type: string; last_success_at: string | null }>).map((s) => [s.sync_type, s.last_success_at]));
  // a HOT success is not a backfill: a shop whose 30-day backfill failed is still "initial" for that type
  const backfilled = await adsBackfillStatus(db, shop.id);
  const initial = !backfilled.shop || !backfilled.campaign;
  const range = initial ? adsBackfillRange(now, shop.timezone, config) : adsHotRange(now, shop.timezone);
  const recent = (iso: string | null) => !!iso && now.getTime() - Date.parse(iso) < config.manualDedupeMinutes * 60_000;

  const jobs: AdsRefreshResult["jobs"] = [];
  const add = async (e: Omit<AdsEnqueueInput, "shopId" | "now" | "createdBy">, poll: boolean) => {
    const r = await enqueueAdsJob(db, { ...e, shopId: shop.id, now, createdBy: input.createdBy ?? null, mode: "manual" });
    jobs.push({ syncType: e.syncType, strategy: e.strategy, jobId: r.jobId, created: r.created, coalesced: r.coalesced, status: r.status, poll });
  };
  // ADS-3A.1: today's hourly rows too (shop switch + global flag), AFTER the daily jobs (lower priority, not awaited by the button)
  const addHourly = async () => {
    if (!config.hourlySyncEnabled || !(await adsHourlyEnabled(db, shop.id))) return;
    if (!input.force && config.manualDedupeMinutes > 0 && recent(await adsHourlyTodayFreshness(db, shop.id, adsHotRange(now, shop.timezone).from))) return;
    const today = adsHotRange(now, shop.timezone);
    await add({ syncType: "ads_shop_hourly_read", strategy: "manual", priority: ADS_PRIORITY.manualHourly, range: today }, false);
    await add({ syncType: "ads_campaign_hourly_read", strategy: "manual", priority: ADS_PRIORITY.manualHourly, range: today, scope: "all" }, false);
  };

  // ADS-3A.2: product metadata only for unknown / stale items (cache hit → nothing); lowest priority, not awaited
  const addEnrichment = async () => {
    try {
      const r = await maybeEnqueueAdsProductEnrichment(db, { shopId: shop.id, now, config, createdBy: input.createdBy ?? null, mode: "manual" });
      if (r) jobs.push({ syncType: "ads_product_enrichment_read", strategy: "enrichment", jobId: r.jobId, created: r.created, coalesced: r.coalesced, status: r.status, poll: false });
    } catch (err) {
      console.warn(JSON.stringify({ source: "ads-refresh", event: "product_enrichment_enqueue_failed", shopId: shop.id, message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) }));
    }
  };

  if (!initial && !input.force && config.manualDedupeMinutes > 0) {
    const f = await adsTodayFreshness(db, shop.id);
    if (recent(f.shop) && recent(f.campaign)) {
      await addHourly();
      await addEnrichment();
      return { shopId: shop.id, jobs, range, initial, fresh: true };
    }
  }

  const campaignLast = last.get("ads_campaign_read");
  const campaignStale = !campaignLast || now.getTime() - Date.parse(campaignLast) >= config.campaignStaleMinutes * 60_000;
  if (campaignStale) await add({ syncType: "ads_campaign_read", strategy: "manual", priority: ADS_PRIORITY.manual }, true);
  if (initial) {
    // the type already backfilled only needs today
    await add(backfilled.campaign ? { syncType: "ads_campaign_performance_read", strategy: "manual", priority: ADS_PRIORITY.manual, range: adsHotRange(now, shop.timezone), scope: "all" } : { syncType: "ads_campaign_performance_read", strategy: "backfill", priority: ADS_PRIORITY.manual, range, scope: "all" }, true);
    await add(backfilled.shop ? { syncType: "ads_shop_performance_read", strategy: "manual", priority: ADS_PRIORITY.manual, range: adsHotRange(now, shop.timezone) } : { syncType: "ads_shop_performance_read", strategy: "backfill", priority: ADS_PRIORITY.manual, range }, true);
    await addHourly();
    await addEnrichment();
    return { shopId: shop.id, jobs, range, initial, fresh: false };
  }
  await add({ syncType: "ads_campaign_performance_read", strategy: "manual", priority: ADS_PRIORITY.manual, range, scope: "all" }, true);
  await add({ syncType: "ads_shop_performance_read", strategy: "manual", priority: ADS_PRIORITY.manual, range }, true);

  const warm = adsWarmRange(now, shop.timezone, config);
  if (warm) {
    const { data: lastWarm, error: warmError } = await db
      .from("channel_sync_jobs")
      .select("finished_at")
      .eq("shop_id", shop.id)
      .eq("lane", "ads_warm")
      .eq("status", "success")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ finished_at: string | null }>();
    if (warmError) throw new Error(`Không đọc được lần đồng bộ WARM gần nhất: ${warmError.message}`);
    const warmDue = !lastWarm?.finished_at || now.getTime() - Date.parse(lastWarm.finished_at) >= config.warmIntervalMinutes * 60_000;
    if (warmDue) {
      await add({ syncType: "ads_shop_performance_read", strategy: "warm", priority: ADS_PRIORITY.warm, range: warm }, false);
      await add({ syncType: "ads_campaign_performance_read", strategy: "warm", priority: ADS_PRIORITY.warm, range: warm, scope: "warm" }, false);
    }
  }
  await addHourly();
  await addEnrichment();
  return { shopId: shop.id, jobs, range, initial, fresh: false };
}

/** Per-shop hourly switch (shopee_ads_shop_settings.ads_hourly_enabled, default OFF). */
export async function adsHourlyEnabled(db: SupabaseClient, shopId: string): Promise<boolean> {
  const { data, error } = await db.from("shopee_ads_shop_settings").select("ads_hourly_enabled").eq("shop_id", shopId).maybeSingle<{ ads_hourly_enabled: boolean }>();
  if (error) throw new Error(`Không đọc được cấu hình theo giờ: ${error.message}`);
  return !!data?.ads_hourly_enabled;
}

/** When today's shop hourly rows were last written (DB only). */
export async function adsHourlyTodayFreshness(db: SupabaseClient, shopId: string, today: string): Promise<string | null> {
  const { data, error } = await db.from("shopee_ads_shop_hourly_performance").select("last_synced_at").eq("shop_id", shopId).eq("report_date", today).order("last_synced_at", { ascending: false }).limit(1).maybeSingle<{ last_synced_at: string }>();
  if (error) throw new Error(`Không đọc được độ mới dữ liệu theo giờ: ${error.message}`);
  return data?.last_synced_at ?? null;
}
