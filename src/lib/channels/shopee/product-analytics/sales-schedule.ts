// ============================================================
// PRODUCT-ANALYTICS-2: scheduler for the isolated product analytics reads.
// Called from the existing pg_cron heartbeat (/api/internal/shopee/sync-scheduler)
// ONLY when PRODUCT_SALES_SYNC_ENABLED / PRODUCT_EXTRA_INFO_SYNC_ENABLED is on,
// and only for shops whose product_analytics_shop_settings switch is on.
//
//   BACKFILL  until sales_backfill_done_at is set: one try per hour (prio 10)
//   HOT       every 30 min (+ the shop's stable minute offset)       (prio 6)
//   COLD      04:00 / 16:00 VN once the backfill is done             (prio 8)
//   EXTRA     06:00 / 18:00 VN (extra_info_enabled)                  (prio 9)
//
// Every priority is BELOW the Ads daily / hourly HOT reads (2–5). A slot is
// claimed with a conditional UPDATE before anything is enqueued, so repeated
// cron ticks never schedule the same slot twice. Never calls Shopee.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { adsJitterMs, adsShopOffsets, latestAdsSlot, latestColdSlot } from "../ads/schedule.ts";
import type { ProductAnalyticsSyncConfig } from "../../../product-analytics/config.ts";

import { enqueueProductAnalyticsJob, PRODUCT_EXTRA_INFO_SYNC_TYPE, PRODUCT_SALES_SYNC_TYPE, type ProductAnalyticsSyncType, type ProductSalesStrategy } from "./sales-sync.ts";

export type ProductAnalyticsSlotColumn = "last_sales_hot_slot_at" | "last_sales_cold_slot_at" | "last_sales_backfill_slot_at" | "last_extra_info_slot_at";

export interface ProductAnalyticsPlannedSlot {
  kind: "hot" | "cold" | "backfill" | "extra";
  column: ProductAnalyticsSlotColumn;
  slotAt: Date;
  syncType: ProductAnalyticsSyncType;
  strategy: ProductSalesStrategy | "extra";
}

export interface ProductAnalyticsShopState {
  salesEnabled: boolean;
  extraInfoEnabled: boolean;
  backfillDone: boolean;
  slots: Partial<Record<ProductAnalyticsSlotColumn, string | null>>;
}

/** What is due for ONE shop at `now` (pure). */
export function planProductAnalyticsShop(input: { now: Date; offsetMinutes: number; state: ProductAnalyticsShopState; config: ProductAnalyticsSyncConfig }): ProductAnalyticsPlannedSlot[] {
  const { now, offsetMinutes: off, state, config } = input;
  const out: ProductAnalyticsPlannedSlot[] = [];
  const add = (slot: Omit<ProductAnalyticsPlannedSlot, "slotAt">, slotAt: Date | null) => {
    const last = state.slots[slot.column];
    if (slotAt && (!last || Date.parse(last) < slotAt.getTime())) out.push({ ...slot, slotAt });
  };
  if (config.salesSyncEnabled && state.salesEnabled) {
    // +3 min: never in the same minute as the shop's Ads HOT slot
    add({ kind: "hot", column: "last_sales_hot_slot_at", syncType: PRODUCT_SALES_SYNC_TYPE, strategy: "hot" }, latestAdsSlot(now, config.hotIntervalMinutes, off + 3));
    if (!state.backfillDone) {
      add({ kind: "backfill", column: "last_sales_backfill_slot_at", syncType: PRODUCT_SALES_SYNC_TYPE, strategy: "backfill" }, latestAdsSlot(now, config.backfillRetryMinutes, off + 4));
    } else {
      add({ kind: "cold", column: "last_sales_cold_slot_at", syncType: PRODUCT_SALES_SYNC_TYPE, strategy: "cold" }, latestColdSlot(now, config.coldTimes, config.timeZone, off * 2));
    }
  }
  if (config.extraInfoSyncEnabled && state.extraInfoEnabled) {
    add({ kind: "extra", column: "last_extra_info_slot_at", syncType: PRODUCT_EXTRA_INFO_SYNC_TYPE, strategy: "extra" }, latestColdSlot(now, config.extraInfoTimes, config.timeZone, off * 2));
  }
  return out;
}

export interface ProductAnalyticsTickResult {
  disabled: boolean;
  shops: number;
  enqueued: Array<{ shopId: string; kind: ProductAnalyticsPlannedSlot["kind"]; jobId: string; created: boolean }>;
  skippedShops: Array<{ shopId: string; reason: string }>;
  errors: Array<{ shopId: string; message: string }>;
  durationMs: number;
}

const UNUSABLE_CONNECTIONS = new Set(["disconnected", "expired", "revoked"]);

interface SettingsRow {
  shop_id: string;
  sales_sync_enabled: boolean;
  extra_info_enabled: boolean;
  sales_backfill_done_at: string | null;
  last_sales_hot_slot_at: string | null;
  last_sales_cold_slot_at: string | null;
  last_sales_backfill_slot_at: string | null;
  last_extra_info_slot_at: string | null;
}

export async function runProductAnalyticsSchedulerTick(db: SupabaseClient, options: { config: ProductAnalyticsSyncConfig; now?: Date }): Promise<ProductAnalyticsTickResult> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const { config } = options;
  const result: ProductAnalyticsTickResult = { disabled: false, shops: 0, enqueued: [], skippedShops: [], errors: [], durationMs: 0 };
  if (!config.salesSyncEnabled && !config.extraInfoSyncEnabled) {
    result.disabled = true;
    return result;
  }
  const { data: settings, error } = await db
    .from("product_analytics_shop_settings")
    .select("shop_id, sales_sync_enabled, extra_info_enabled, sales_backfill_done_at, last_sales_hot_slot_at, last_sales_cold_slot_at, last_sales_backfill_slot_at, last_extra_info_slot_at")
    .or("sales_sync_enabled.eq.true,extra_info_enabled.eq.true");
  if (error) throw new Error(`Không đọc được cấu hình Product Analytics: ${error.message}`);
  const enabled = (settings ?? []) as SettingsRow[];
  if (!enabled.length) {
    result.durationMs = Date.now() - started;
    return result;
  }
  const ids = enabled.map((s) => s.shop_id);
  const { data: shops, error: shopError } = await db.from("shops").select("id, is_active, channel, data_source, shop_connections(connection_status)").in("id", ids);
  if (shopError) throw new Error(`Không đọc được shop: ${shopError.message}`);
  const { data: controls } = await db.from("channel_shop_sync_controls").select("shop_id, sync_enabled, paused_until").in("shop_id", ids);
  const controlOf = new Map(((controls ?? []) as Array<{ shop_id: string; sync_enabled: boolean; paused_until: string | null }>).map((c) => [c.shop_id, c]));
  type ShopRow = { id: string; is_active: boolean; channel: string; data_source: string; shop_connections: Array<{ connection_status: string }> | { connection_status: string } | null };
  const shopOf = new Map(((shops ?? []) as ShopRow[]).map((s) => [s.id, s]));
  const offsets = adsShopOffsets(enabled.map((s) => ({ id: s.shop_id, syncSlot: null })));

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
    if (reason) {
      result.skippedShops.push({ shopId: s.shop_id, reason });
      continue;
    }
    result.shops++;
    try {
      const offset = offsets.get(s.shop_id) ?? 0;
      const plan = planProductAnalyticsShop({
        now,
        offsetMinutes: offset,
        config,
        state: { salesEnabled: s.sales_sync_enabled, extraInfoEnabled: s.extra_info_enabled, backfillDone: !!s.sales_backfill_done_at, slots: s },
      });
      const notBefore = new Date(now.getTime() + adsJitterMs(s.shop_id, latestAdsSlot(now, config.hotIntervalMinutes, offset), 20));
      for (const slot of plan) {
        const iso = slot.slotAt.toISOString();
        const { data: claimed, error: claimError } = await db
          .from("product_analytics_shop_settings")
          .update({ [slot.column]: iso })
          .eq("shop_id", s.shop_id)
          .or(`${slot.column}.is.null,${slot.column}.lt.${iso}`)
          .select("shop_id");
        if (claimError) throw new Error(`Không giữ được slot: ${claimError.message}`);
        if (!claimed?.length) continue;
        try {
          const r = await enqueueProductAnalyticsJob(db, { shopId: s.shop_id, syncType: slot.syncType, strategy: slot.strategy, notBefore, now });
          result.enqueued.push({ shopId: s.shop_id, kind: slot.kind, jobId: r.jobId, created: r.created });
        } catch (err) {
          // give the slot back: the next heartbeat retries it
          await db.from("product_analytics_shop_settings").update({ [slot.column]: s[slot.column] }).eq("shop_id", s.shop_id).eq(slot.column, iso);
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
