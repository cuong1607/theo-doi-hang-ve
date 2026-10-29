// ============================================================
// SHOPEE-ADS-2: Ads scheduler — decides which READ jobs are due, per shop.
//
//   heartbeat     pg_cron → /api/internal/shopee/sync-scheduler every minute
//                 (the heartbeat is NOT the Shopee cadence)
//   HOT           every 15 min, TODAY only: shop total (prio 2) + active
//                 campaigns (prio 3)
//   WARM          hourly, the previous N completed days (prio 4)
//   COLD          03:00 / 15:00 Asia/Ho_Chi_Minh, 7 days + today, ALL
//                 campaigns (prio 6)
//   METADATA      every 6 h (prio 5); every 15 min until the first success
//   BACKFILL      first sync of a shop: 30 days (prio 7), replaces WARM/COLD
//                 until a performance read has succeeded
//
// Staggering: every shop has a stable minute offset inside each window
// (explicit sync_slot, else (rank × 2) mod 10 among enabled shops sorted by
// id) + a deterministic 0–20 s jitter. A slot is claimed with a conditional
// UPDATE on shopee_ads_shop_settings before anything is enqueued, so
// overlapping / repeated cron ticks never schedule the same slot twice.
// Enqueue itself is dedupe + coalescing (enqueue_ads_sync_job).
//
// Never calls Shopee. Never runs from a page render.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { adsHourlyReconciliation, loadAdsHourlyReconciliation } from "./hourly.ts";
import { ADS_PRIORITY, addDaysIso, adsBackfillRange, adsBackfillStatus, adsColdRange, adsHotRange, adsWarmRange, enqueueAdsJob, shopToday, type AdsCampaignScope, type AdsStrategy, type AdsSyncConfig } from "./sync.ts";
import type { AdsHourlyReconciliationStatus } from "./view-models.ts";
import type { AdsDateRange } from "./provider.ts";
import type { AdsSyncType } from "./read-only-policy.ts";

const MINUTE = 60_000;

// ------------------------------------------------------------------ pure planning

export type AdsSlotColumn =
  | "last_hot_shop_slot_at"
  | "last_hot_campaign_slot_at"
  | "last_warm_slot_at"
  | "last_cold_slot_at"
  | "last_metadata_slot_at"
  | "last_hot_hourly_slot_at"
  | "last_hourly_finalize_slot_at";
export const ADS_SLOT_COLUMNS: readonly AdsSlotColumn[] = [
  "last_hot_shop_slot_at",
  "last_hot_campaign_slot_at",
  "last_warm_slot_at",
  "last_cold_slot_at",
  "last_metadata_slot_at",
  "last_hot_hourly_slot_at",
  "last_hourly_finalize_slot_at",
];

export type AdsSlotState = Partial<Record<AdsSlotColumn, string | null>>;

export interface AdsJobSpec {
  syncType: AdsSyncType;
  strategy: AdsStrategy;
  priority: number;
  range: AdsDateRange | null;
  scope?: AdsCampaignScope;
}

export interface AdsPlannedSlot {
  kind: "hot_shop" | "hot_campaign" | "warm" | "backfill" | "cold" | "metadata" | "hot_hourly" | "hourly_finalize";
  column: AdsSlotColumn;
  slotAt: Date;
  jobs: AdsJobSpec[];
}

/**
 * Stable minute offsets (0–9) inside every 15-minute window: an explicit
 * sync_slot wins; otherwise (rank × 2) mod 10 among the enabled shops sorted
 * by id → 0, 2, 4, 6, 8 for five shops.
 */
export function adsShopOffsets(shops: ReadonlyArray<{ id: string; syncSlot: number | null }>): Map<string, number> {
  const out = new Map<string, number>();
  [...shops].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).forEach((s, rank) => out.set(s.id, s.syncSlot ?? (rank * 2) % 10));
  return out;
}

/** Latest slot boundary ≤ now for a cadence (epoch-aligned: 15 min → :00 :15 :30 :45) shifted by the offset. */
export function latestAdsSlot(now: Date, intervalMinutes: number, offsetMinutes: number): Date {
  const interval = intervalMinutes * MINUTE;
  const offset = (((offsetMinutes * MINUTE) % interval) + interval) % interval;
  return new Date(Math.floor((now.getTime() - offset) / interval) * interval + offset);
}

/** Latest COLD time (HH:MM in timeZone, + offset minutes) ≤ now; looks back two days. */
export function latestColdSlot(now: Date, times: readonly string[], timeZone: string, offsetMinutes: number): Date | null {
  let best: number | null = null;
  for (let back = 0; back <= 2; back++) {
    const day = new Date(now.getTime() - back * 86_400_000);
    const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(day);
    const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    const iso = `${v("year")}-${v("month")}-${v("day")}`;
    for (const t of times) {
      const [h, m] = t.split(":").map(Number);
      const at = zonedTime(iso, h, m, timeZone) + offsetMinutes * MINUTE;
      if (at <= now.getTime() && (best === null || at > best)) best = at;
    }
  }
  return best === null ? null : new Date(best);
}

function zonedTime(iso: string, hour: number, minute: number, timeZone: string): number {
  const guess = Date.parse(`${iso}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(guess));
  const v = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const asLocal = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return guess - (asLocal - guess);
}

/** Deterministic jitter in [0, maxSeconds] s for one shop + slot (FNV-1a). */
export function adsJitterMs(shopId: string, slotAt: Date, maxSeconds: number): number {
  if (maxSeconds <= 0) return 0;
  let h = 0x811c9dc5;
  for (const ch of `${shopId}|${slotAt.toISOString()}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % (maxSeconds + 1)) * 1000;
}

const due = (slots: AdsSlotState, column: AdsSlotColumn, slotAt: Date) => {
  const last = slots[column];
  return !last || Date.parse(last) < slotAt.getTime();
};

/**
 * What is due for ONE shop at `now` (pure). Each planned slot carries the
 * jobs to enqueue once the slot is claimed.
 */
export function planAdsShop(input: {
  now: Date;
  timeZone: string;
  offsetMinutes: number;
  slots: AdsSlotState;
  config: AdsSyncConfig;
  /** Campaign catalogue exists in the DB. */
  hasCampaigns: boolean;
  /** The 30-day backfill of campaign performance AND of shop performance has finished. */
  performanceSynced: boolean;
  /** Per type (when known): only the missing backfill is re-read. */
  backfilled?: { shop: boolean; campaign: boolean };
  /** ADS-3A.1: ADS_HOURLY_SYNC_ENABLED AND the shop's ads_hourly_enabled. */
  hourlyEnabled?: boolean;
  /** A daily HOT read of an EARLIER slot is still waiting: hourly waits too (daily freshness first). */
  dailyHotBacklog?: boolean;
}): AdsPlannedSlot[] {
  const { now, timeZone, offsetMinutes: off, slots, config } = input;
  const out: AdsPlannedSlot[] = [];
  const add = (kind: AdsPlannedSlot["kind"], column: AdsSlotColumn, slotAt: Date | null, jobs: AdsJobSpec[]) => {
    if (slotAt && due(slots, column, slotAt)) out.push({ kind, column, slotAt, jobs });
  };

  // campaign metadata: every 15 min until the catalogue exists, then every 6 h
  const metaSlot = input.hasCampaigns ? latestAdsSlot(now, config.metadataIntervalMinutes, off + 10) : latestAdsSlot(now, config.hotIntervalMinutes, off);
  add("metadata", "last_metadata_slot_at", metaSlot, [{ syncType: "ads_campaign_read", strategy: input.hasCampaigns ? "metadata" : "backfill", priority: input.hasCampaigns ? ADS_PRIORITY.metadata : ADS_PRIORITY.metadataInitial, range: null }]);

  // HOT: today only
  const hot = adsHotRange(now, timeZone);
  add("hot_shop", "last_hot_shop_slot_at", latestAdsSlot(now, config.hotIntervalMinutes, off), [{ syncType: "ads_shop_performance_read", strategy: "hot", priority: ADS_PRIORITY.hotShop, range: hot }]);
  if (input.hasCampaigns) {
    add("hot_campaign", "last_hot_campaign_slot_at", latestAdsSlot(now, config.campaignHotIntervalMinutes, off), [{ syncType: "ads_campaign_performance_read", strategy: "hot", priority: ADS_PRIORITY.hotCampaign, range: hot, scope: "hot" }]);
  }

  // HOURLY (ADS-3A.1): same 15-minute slot as HOT, TODAY only, below the daily HOT priorities.
  // While the daily HOT queue is behind, the slot is left unclaimed (retried next heartbeat).
  if (input.hourlyEnabled && !input.dailyHotBacklog) {
    add("hot_hourly", "last_hot_hourly_slot_at", latestAdsSlot(now, config.hotIntervalMinutes, off), [
      { syncType: "ads_shop_hourly_read", strategy: "hot", priority: ADS_PRIORITY.hotShopHourly, range: hot },
      ...(input.hasCampaigns ? [{ syncType: "ads_campaign_hourly_read" as const, strategy: "hot" as const, priority: ADS_PRIORITY.hotCampaignHourly, range: hot, scope: "hot" as const }] : []),
    ]);
  }
  // yesterday's hourly rows once after the day rollover, ALL campaigns (accuracy pass) + reconciliation
  if (input.hourlyEnabled) {
    const finalizeSlot = latestColdSlot(now, [config.hourlyFinalizeTime], timeZone, off * 2);
    // the day that ended before the slot (a slot at 02:30 on D finalizes D−1, whenever the heartbeat picks it up)
    const day = finalizeSlot ? addDaysIso(shopToday(finalizeSlot, timeZone), -1) : addDaysIso(hot.from, -1);
    const yesterday = { from: day, to: day };
    add("hourly_finalize", "last_hourly_finalize_slot_at", finalizeSlot, [
      { syncType: "ads_shop_hourly_read", strategy: "finalize", priority: ADS_PRIORITY.hourlyFinalize, range: yesterday },
      ...(input.hasCampaigns ? [{ syncType: "ads_campaign_hourly_read" as const, strategy: "finalize" as const, priority: ADS_PRIORITY.hourlyFinalize, range: yesterday, scope: "all" as const }] : []),
    ]);
  }

  // WARM (or the first BACKFILL, which also covers what WARM / COLD would read)
  const warmSlot = latestAdsSlot(now, config.warmIntervalMinutes, off + 5);
  if (!input.performanceSynced) {
    const range = adsBackfillRange(now, timeZone, config);
    add("backfill", "last_warm_slot_at", warmSlot, [
      ...(input.backfilled?.shop ? [] : [{ syncType: "ads_shop_performance_read" as const, strategy: "backfill" as const, priority: ADS_PRIORITY.backfill, range }]),
      ...(input.backfilled?.campaign ? [] : [{ syncType: "ads_campaign_performance_read" as const, strategy: "backfill" as const, priority: ADS_PRIORITY.backfill, range, scope: "all" as const }]),
    ]);
  } else {
    const range = adsWarmRange(now, timeZone, config);
    if (range) {
      add("warm", "last_warm_slot_at", warmSlot, [
        { syncType: "ads_shop_performance_read", strategy: "warm", priority: ADS_PRIORITY.warm, range },
        ...(input.hasCampaigns ? [{ syncType: "ads_campaign_performance_read" as const, strategy: "warm" as const, priority: ADS_PRIORITY.warm, range, scope: "warm" as const }] : []),
      ]);
    }
  }

  // COLD: all campaigns, 7 days + today; staggered 2 min per slot offset. Skipped (slot consumed) before the first backfill.
  const coldSlot = latestColdSlot(now, config.coldTimes, config.coldTimeZone, off * 2);
  const cold = adsColdRange(now, timeZone, config);
  add("cold", "last_cold_slot_at", coldSlot, input.performanceSynced
    ? [
        { syncType: "ads_shop_performance_read", strategy: "cold", priority: ADS_PRIORITY.cold, range: cold },
        ...(input.hasCampaigns ? [{ syncType: "ads_campaign_performance_read" as const, strategy: "cold" as const, priority: ADS_PRIORITY.cold, range: cold, scope: "all" as const }] : []),
      ]
    : []);
  return out;
}

// ------------------------------------------------------------------ DB tick

export interface AdsSchedulerTickResult {
  disabled: boolean;
  shops: number;
  enqueued: Array<{ shopId: string; kind: AdsPlannedSlot["kind"]; syncType: AdsSyncType; jobId: string; created: boolean; coalesced: boolean }>;
  slotsClaimed: number;
  skippedShops: Array<{ shopId: string; reason: string }>;
  errors: Array<{ shopId: string; message: string }>;
  /** ADS-3A.1: shops whose hourly slot waited because a daily HOT read of an earlier slot was still queued. */
  hourlyDeferred: string[];
  durationMs: number;
}

const UNUSABLE_CONNECTIONS = new Set(["disconnected", "expired", "revoked"]);

interface SettingsRow {
  shop_id: string;
  sync_slot: number | null;
  last_hot_shop_slot_at: string | null;
  last_hot_campaign_slot_at: string | null;
  last_warm_slot_at: string | null;
  last_cold_slot_at: string | null;
  last_metadata_slot_at: string | null;
  ads_hourly_enabled: boolean;
  last_hot_hourly_slot_at: string | null;
  last_hourly_finalize_slot_at: string | null;
}

/**
 * One scheduler heartbeat for Ads. Never throws for a single shop (its
 * problem is reported and the others continue). Disabled unless
 * ADS_AUTO_SYNC_ENABLED and the shop's ads_sync_enabled are both on.
 */
export async function runAdsSchedulerTick(db: SupabaseClient, options: { config: AdsSyncConfig; now?: Date; shopIds?: readonly string[] | null }): Promise<AdsSchedulerTickResult> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const config = options.config;
  const result: AdsSchedulerTickResult = { disabled: false, shops: 0, enqueued: [], slotsClaimed: 0, skippedShops: [], errors: [], hourlyDeferred: [], durationMs: 0 };
  if (!config.autoSyncEnabled) {
    result.disabled = true;
    result.durationMs = Date.now() - started;
    return result;
  }

  let q = db
    .from("shopee_ads_shop_settings")
    .select("shop_id, sync_slot, last_hot_shop_slot_at, last_hot_campaign_slot_at, last_warm_slot_at, last_cold_slot_at, last_metadata_slot_at, ads_hourly_enabled, last_hot_hourly_slot_at, last_hourly_finalize_slot_at")
    .eq("ads_sync_enabled", true);
  if (options.shopIds) q = q.in("shop_id", [...options.shopIds]);
  const { data: settings, error } = await q;
  if (error) throw new Error(`Không đọc được cấu hình đồng bộ Ads: ${error.message}`);
  const enabled = (settings ?? []) as SettingsRow[];
  if (!enabled.length) {
    result.durationMs = Date.now() - started;
    return result;
  }

  const ids = enabled.map((s) => s.shop_id);
  const { data: shops, error: shopError } = await db.from("shops").select("id, timezone, is_active, channel, data_source, shop_connections(connection_status)").in("id", ids);
  if (shopError) throw new Error(`Không đọc được shop: ${shopError.message}`);
  const { data: controls, error: controlError } = await db.from("channel_shop_sync_controls").select("shop_id, sync_enabled, paused_until").in("shop_id", ids);
  if (controlError) throw new Error(`Không đọc được trạng thái bật/tắt đồng bộ shop: ${controlError.message}`);
  const controlOf = new Map(((controls ?? []) as Array<{ shop_id: string; sync_enabled: boolean; paused_until: string | null }>).map((c) => [c.shop_id, c]));
  const shopOf = new Map(
    ((shops ?? []) as Array<{ id: string; timezone: string | null; is_active: boolean; channel: string; data_source: string; shop_connections: Array<{ connection_status: string }> | { connection_status: string } | null }>).map((s) => [s.id, s]),
  );

  // offsets over every ENABLED shop (stable while the enabled set is stable)
  const offsets = adsShopOffsets(enabled.map((s) => ({ id: s.shop_id, syncSlot: s.sync_slot })));
  const eligible: SettingsRow[] = [];
  for (const s of enabled) {
    const shop = shopOf.get(s.shop_id);
    const control = controlOf.get(s.shop_id);
    const conns = Array.isArray(shop?.shop_connections) ? shop.shop_connections : shop?.shop_connections ? [shop.shop_connections] : [];
    const reason = !shop || shop.channel !== "shopee"
      ? "shop_not_found"
      : !shop.is_active
        ? "shop_inactive"
        : shop.data_source !== "live"
          ? "data_source_not_live"
          : UNUSABLE_CONNECTIONS.has(conns[0]?.connection_status ?? "disconnected")
            ? `connection_${conns[0]?.connection_status ?? "disconnected"}`
            : control && !control.sync_enabled
              ? "sync_disabled"
              : control?.paused_until && Date.parse(control.paused_until) > now.getTime()
                ? "circuit_breaker_cooldown"
                : null;
    if (reason) result.skippedShops.push({ shopId: s.shop_id, reason });
    else eligible.push(s);
  }
  result.shops = eligible.length;

  for (const s of eligible) {
    try {
      const shop = shopOf.get(s.shop_id)!;
      const facts = await shopFacts(db, s.shop_id);
      const offset = offsets.get(s.shop_id) ?? 0;
      const hourlyEnabled = config.hourlySyncEnabled && !!s.ads_hourly_enabled;
      const dailyHotBacklog = hourlyEnabled ? await adsDailyHotBacklog(db, s.shop_id, latestAdsSlot(now, config.hotIntervalMinutes, offset)) : false;
      if (dailyHotBacklog) result.hourlyDeferred.push(s.shop_id);
      const plan = planAdsShop({ now, timeZone: shop.timezone || "Asia/Ho_Chi_Minh", offsetMinutes: offset, slots: s, config, ...facts, hourlyEnabled, dailyHotBacklog });
      // ONE start offset per shop and tick: every job of the shop becomes claimable together, priority decides the order
      const notBefore = new Date(now.getTime() + adsJitterMs(s.shop_id, latestAdsSlot(now, config.hotIntervalMinutes, offset), config.jitterSeconds));
      for (const slot of plan) {
        if (!(await claimSlot(db, s.shop_id, slot.column, slot.slotAt))) continue;
        result.slotsClaimed++;
        try {
          for (const job of slot.jobs) {
            const r = await enqueueAdsJob(db, { shopId: s.shop_id, syncType: job.syncType, strategy: job.strategy, priority: job.priority, range: job.range, scope: job.scope, notBefore, now });
            result.enqueued.push({ shopId: s.shop_id, kind: slot.kind, syncType: job.syncType, jobId: r.jobId, created: r.created, coalesced: r.coalesced });
          }
        } catch (err) {
          // give the slot back: the next heartbeat retries it
          await releaseSlot(db, s.shop_id, slot.column, slot.slotAt, s[slot.column]);
          throw err;
        }
      }
    } catch (err) {
      result.errors.push({ shopId: s.shop_id, message: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  result.durationMs = Date.now() - started;
  return result;
}

async function shopFacts(db: SupabaseClient, shopId: string): Promise<{ hasCampaigns: boolean; performanceSynced: boolean; backfilled: { shop: boolean; campaign: boolean } }> {
  const { count, error } = await db.from("shopee_ads_campaigns").select("id", { count: "exact", head: true }).eq("shop_id", shopId);
  if (error) throw new Error(`Không đọc được danh mục chiến dịch: ${error.message}`);
  // a HOT success is not a backfill (a failed backfill must be re-run, not forgotten)
  const backfilled = await adsBackfillStatus(db, shopId);
  return { hasCampaigns: (count ?? 0) > 0, performanceSynced: backfilled.shop && backfilled.campaign, backfilled };
}

/**
 * Daily HOT queue falling behind: a daily read in the HOT lane, created before
 * the current slot, is still active (pending / retry / running). Hourly waits
 * — daily canonical freshness always comes first.
 */
export async function adsDailyHotBacklog(db: SupabaseClient, shopId: string, slotAt: Date): Promise<boolean> {
  const { count, error } = await db
    .from("channel_sync_jobs")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("lane", "ads_hot")
    .in("sync_type", ["ads_shop_performance_read", "ads_campaign_performance_read"])
    .in("status", ["pending", "running", "retry"])
    .lt("created_at", slotAt.toISOString());
  if (error) throw new Error(`Không đọc được hàng đợi HOT: ${error.message}`);
  return (count ?? 0) > 0;
}

/** Conditional UPDATE: true only for the ONE tick that moves the slot forward. */
async function claimSlot(db: SupabaseClient, shopId: string, column: string, slotAt: Date): Promise<boolean> {
  const iso = slotAt.toISOString();
  const { data, error } = await db.from("shopee_ads_shop_settings").update({ [column]: iso }).eq("shop_id", shopId).or(`${column}.is.null,${column}.lt.${iso}`).select("shop_id");
  if (error) throw new Error(`Không ghi được lịch đồng bộ Ads: ${error.message}`);
  return (data ?? []).length > 0;
}

async function releaseSlot(db: SupabaseClient, shopId: string, column: string, slotAt: Date, previous: string | null | undefined) {
  await db.from("shopee_ads_shop_settings").update({ [column]: previous ?? null }).eq("shop_id", shopId).eq(column, slotAt.toISOString());
}

// ------------------------------------------------------------------ SLA overview (admin panel, DB only)

export interface AdsShopSyncOverview {
  shopId: string;
  shopName: string;
  enabled: boolean;
  offsetMinutes: number | null;
  campaigns: number;
  /** Latest successful HOT (or manual / COLD) read of today's shop total. */
  shopTodayAt: string | null;
  campaignTodayAt: string | null;
  hot: { runs: number; failed: number; p95QueueWaitMs: number | null; p95TotalMs: number | null; apiCalls: number };
  activeJobs: number;
  /** ADS-3A.1: hourly TODAY layer of the shop. */
  hourly: {
    enabled: boolean;
    /** Latest write of today's shop hourly rows. */
    lastSyncedAt: string | null;
    runs: number;
    failed: number;
    apiCalls: number;
    p95TotalMs: number | null;
    /** Yesterday's hourly Σ vs daily. */
    reconciliation: AdsHourlyReconciliationStatus | null;
  };
}

/** Per shop: switch, stagger offset, campaign count, HOT SLA over the last 24 h. */
export async function loadAdsSyncOverview(db: SupabaseClient, now: Date = new Date()): Promise<AdsShopSyncOverview[]> {
  const { data: shops, error } = await db.from("shops").select("id, shop_name").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true).order("shop_name");
  if (error) throw new Error(`Không đọc được shop: ${error.message}`);
  const list = (shops ?? []) as Array<{ id: string; shop_name: string }>;
  if (!list.length) return [];
  const ids = list.map((s) => s.id);
  const { data: settings, error: sError } = await db.from("shopee_ads_shop_settings").select("shop_id, ads_sync_enabled, sync_slot, ads_hourly_enabled").in("shop_id", ids);
  if (sError) throw new Error(`Không đọc được cấu hình đồng bộ Ads: ${sError.message}`);
  const settingOf = new Map(((settings ?? []) as Array<{ shop_id: string; ads_sync_enabled: boolean; sync_slot: number | null; ads_hourly_enabled: boolean }>).map((s) => [s.shop_id, s]));
  const enabled = list.filter((s) => settingOf.get(s.id)?.ads_sync_enabled);
  const offsets = adsShopOffsets(enabled.map((s) => ({ id: s.id, syncSlot: settingOf.get(s.id)?.sync_slot ?? null })));
  const { data: metrics, error: mError } = await db.rpc("get_ads_sync_metrics", { p_hours: 24 });
  if (mError) throw new Error(`Không đọc được số liệu đồng bộ Ads: ${mError.message}`);
  const { data: fresh, error: fError } = await db.rpc("ads_sync_freshness", { p_shop_ids: ids });
  if (fError) throw new Error(`Không đọc được độ mới dữ liệu: ${fError.message}`);
  const freshOf = new Map(((fresh ?? []) as Array<{ shop_id: string; shop_today_at: string | null; campaign_today_at: string | null; active_jobs: number }>).map((f) => [f.shop_id, f]));
  type M = { shop_id: string; sync_type: string; strategy: string; jobs: number; failed: number; p95_queue_wait_ms: number | null; p95_total_ms: number | null; api_calls: number };
  const HOURLY_TYPES = ["ads_shop_hourly_read", "ads_campaign_hourly_read"];
  const hotOf = (shopId: string, hourly = false) => {
    const rows = ((metrics ?? []) as M[]).filter((m) => m.shop_id === shopId && m.strategy === "hot" && HOURLY_TYPES.includes(m.sync_type) === hourly);
    const max = (pick: (m: M) => number | null) => rows.reduce<number | null>((a, m) => (pick(m) === null ? a : Math.max(a ?? 0, Number(pick(m)))), null);
    return { runs: rows.reduce((a, m) => a + Number(m.jobs), 0), failed: rows.reduce((a, m) => a + Number(m.failed), 0), p95QueueWaitMs: max((m) => m.p95_queue_wait_ms), p95TotalMs: max((m) => m.p95_total_ms), apiCalls: rows.reduce((a, m) => a + Number(m.api_calls ?? 0), 0) };
  };
  // hourly layer (tolerant: an unreadable hourly table never hides the daily overview)
  const tz = "Asia/Ho_Chi_Minh";
  const today = shopToday(now, tz);
  const hourlySynced = new Map<string, string>();
  const reconOf = new Map<string, AdsHourlyReconciliationStatus>();
  try {
    const { data: synced, error: hError } = await db.from("shopee_ads_shop_hourly_performance").select("shop_id, last_synced_at").in("shop_id", ids).eq("report_date", today).order("last_synced_at", { ascending: false }).range(0, 999);
    if (hError) throw hError;
    for (const r of (synced ?? []) as Array<{ shop_id: string; last_synced_at: string }>) if (!hourlySynced.has(r.shop_id)) hourlySynced.set(r.shop_id, r.last_synced_at);
    const yesterday = addDaysIso(today, -1);
    for (const r of await loadAdsHourlyReconciliation(db, ids, { from: yesterday, to: yesterday })) reconOf.set(r.shop_id, adsHourlyReconciliation(r, today).status);
  } catch (err) {
    console.warn(JSON.stringify({ source: "ads-sync-overview", event: "hourly_unavailable", message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) }));
  }
  const out: AdsShopSyncOverview[] = [];
  for (const s of list) {
    const { count, error: cError } = await db.from("shopee_ads_campaigns").select("id", { count: "exact", head: true }).eq("shop_id", s.id);
    if (cError) throw new Error(`Không đọc được danh mục chiến dịch: ${cError.message}`);
    const f = freshOf.get(s.id);
    const hourlyHot = hotOf(s.id, true);
    out.push({
      shopId: s.id,
      shopName: s.shop_name,
      enabled: !!settingOf.get(s.id)?.ads_sync_enabled,
      offsetMinutes: offsets.get(s.id) ?? null,
      campaigns: count ?? 0,
      shopTodayAt: f?.shop_today_at ?? null,
      campaignTodayAt: f?.campaign_today_at ?? null,
      hot: hotOf(s.id),
      activeJobs: Number(f?.active_jobs ?? 0),
      hourly: {
        enabled: !!settingOf.get(s.id)?.ads_hourly_enabled,
        lastSyncedAt: hourlySynced.get(s.id) ?? null,
        runs: hourlyHot.runs,
        failed: hourlyHot.failed,
        apiCalls: hourlyHot.apiCalls,
        p95TotalMs: hourlyHot.p95TotalMs,
        reconciliation: reconOf.get(s.id) ?? null,
      },
    });
  }
  return out;
}

// ------------------------------------------------------------------ per-shop switch (admin)

/** Rollout switch for one shop. Enabling never deletes data; disabling stops new automatic jobs only. */
export async function setAdsShopSyncEnabled(db: SupabaseClient, input: { shopId: string; enabled: boolean; updatedBy?: string | null; syncSlot?: number | null }) {
  const row: Record<string, unknown> = { shop_id: input.shopId, ads_sync_enabled: input.enabled, updated_by: input.updatedBy ?? null };
  if (input.enabled) row.enabled_at = new Date().toISOString();
  if (input.syncSlot !== undefined) row.sync_slot = input.syncSlot;
  const { error } = await db.from("shopee_ads_shop_settings").upsert(row, { onConflict: "shop_id" });
  if (error) throw new Error(`Không lưu được cấu hình đồng bộ Ads: ${error.message}`);
}

/** ADS-3A.1 hourly rollout switch for one shop (pilot first). Only decides whether hourly READ jobs are enqueued. */
export async function setAdsShopHourlyEnabled(db: SupabaseClient, input: { shopId: string; enabled: boolean; updatedBy?: string | null }) {
  const row: Record<string, unknown> = { shop_id: input.shopId, ads_hourly_enabled: input.enabled, updated_by: input.updatedBy ?? null };
  if (input.enabled) row.hourly_enabled_at = new Date().toISOString();
  const { error } = await db.from("shopee_ads_shop_settings").upsert(row, { onConflict: "shop_id" });
  if (error) throw new Error(`Không lưu được cấu hình theo giờ: ${error.message}`);
}
