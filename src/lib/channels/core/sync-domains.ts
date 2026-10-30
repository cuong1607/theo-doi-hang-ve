// ============================================================
// SHOPEE-ADS-0: which sync job types may run, by domain.
//
//   legacy  every job type built in SHOPEE-2 … SHOPEE-6B (products, orders,
//           escrow, returns, return logistics, failed delivery, income,
//           payout) — runs only with SHOPEE_LEGACY_MODULES_ENABLED=true
//   ads     planned names only (SHOPEE-ADS-1 will add handlers + the DB
//           sync_type values); NOT runnable yet
// The queue / worker / scheduler themselves stay — only the allowed type
// list changes. Pure.
// ============================================================
import type { ShopeeFlags } from "../../feature-flags.ts";
import { RUNNABLE_SYNC_TYPES, type RunnableSyncType } from "./sync-jobs.ts";

export const LEGACY_SYNC_TYPES: readonly RunnableSyncType[] = RUNNABLE_SYNC_TYPES;

/**
 * SHOPEE-ADS-1B: Ads job types (mirror of shopee/ads/read-only-policy.ts
 * ADS_SYNC_TYPES and of the DB check). READ-ONLY POLICY: read/sync jobs only
 * (ads_<what>_read) — never *_update / *_set / budget / bid / status writes.
 */
export const ADS_SYNC_TYPES = ["ads_campaign_read", "ads_campaign_performance_read", "ads_shop_performance_read", "ads_shop_hourly_read", "ads_campaign_hourly_read", "ads_product_enrichment_read"] as const;
export type AdsSyncType = (typeof ADS_SYNC_TYPES)[number];

/** Legacy job types the scheduler may enqueue and the worker may claim right now. */
export function activeSyncTypes(flags: ShopeeFlags): RunnableSyncType[] {
  return flags.legacyModulesEnabled ? [...LEGACY_SYNC_TYPES] : [];
}

/**
 * Ads read job types the worker may claim. Only in REAL mode — they are
 * enqueued by the manual "Làm mới dữ liệu" action and (SHOPEE-ADS-2) by the
 * Ads scheduler when ADS_AUTO_SYNC_ENABLED=true for enabled shops.
 */
export function activeAdsSyncTypes(flags: ShopeeFlags): AdsSyncType[] {
  return flags.adsEnabled && flags.adsDataSource === "real" ? [...ADS_SYNC_TYPES] : [];
}

/** Job types that exist in the queue but are retired (pending / retry ones are cancelled by the scheduler). */
export function retiredSyncTypes(flags: ShopeeFlags): RunnableSyncType[] {
  return flags.legacyModulesEnabled ? [] : [...LEGACY_SYNC_TYPES];
}

export const LEGACY_DISABLED_CODE = "legacy_module_disabled";
