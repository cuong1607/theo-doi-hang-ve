// APP-SHELL-1: the small, trusted summaries the launcher and the Shopee
// landing show. Database reads only (never a Shopee call, never an analytics
// RPC on the hub). A failed read returns null → the UI omits the status
// rather than inventing one.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getShopeeFlags } from "@/lib/feature-flags";
import { PRODUCT_SIGNAL_THRESHOLDS } from "@/lib/product-analytics/config";
import { loadShopFreshness } from "@/lib/product-analytics/read-model";

import { classifyShopSync, type ConnectionSummary, type ShopSyncHealth } from "./sync-health";

interface LiveShop {
  id: string;
  shop_name: string;
}

async function liveShops(db: SupabaseClient): Promise<LiveShop[] | null> {
  // same scope as the Ads / product-analytics pages: live, active Shopee shops
  const { data, error } = await db.from("shops").select("id, shop_name").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true).order("shop_name");
  return error ? null : ((data ?? []) as LiveShop[]);
}

async function connectionStatuses(db: SupabaseClient, shopIds: string[]): Promise<Map<string, string> | null> {
  if (!shopIds.length) return new Map();
  const { data, error } = await db.from("shop_connections").select("shop_id, connection_status").in("shop_id", shopIds);
  if (error) return null;
  return new Map(((data ?? []) as Array<{ shop_id: string; connection_status: string }>).map((r) => [r.shop_id, r.connection_status]));
}

/** Hub card: 2 tiny indexed reads. */
export async function loadShopeeConnectionSummary(db: SupabaseClient): Promise<ConnectionSummary | null> {
  const shops = await liveShops(db);
  if (!shops) return null;
  const status = await connectionStatuses(db, shops.map((s) => s.id));
  if (!status) return null;
  return { shops: shops.length, connected: shops.filter((s) => status.get(s.id) === "connected").length };
}

/** Shopee landing: connection + Ads / sales freshness per live shop (the same freshness RPCs the product page reads). */
export async function loadShopeeSyncHealth(db: SupabaseClient, now: Date = new Date()): Promise<ShopSyncHealth[] | null> {
  const shops = await liveShops(db);
  if (!shops) return null;
  const ids = shops.map((s) => s.id);
  const [status, freshness] = await Promise.all([connectionStatuses(db, ids), loadShopFreshness(db, ids).catch(() => null)]);
  if (!status || !freshness) return null;
  const adsReal = getShopeeFlags().adsDataSource === "real";
  return shops.map((s) => {
    const f = freshness.get(s.id);
    return classifyShopSync(
      { shopId: s.id, shopName: s.shop_name, connectionStatus: status.get(s.id) ?? null, adsReal, adsAt: f?.ads_campaign_today_at ?? null, salesEnabled: !!f?.sales_enabled, salesAt: f?.sales_last_success_at ?? null },
      PRODUCT_SIGNAL_THRESHOLDS,
      now,
    );
  });
}
