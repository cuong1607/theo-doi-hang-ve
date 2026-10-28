// ============================================================
// SHOPEE-ADS-0: keep shop tokens alive while no domain calls Shopee.
//
// Tokens were only refreshed on demand (getValidAccessToken before an API
// call). With the legacy sync retired and Ads not built yet, nothing calls
// Shopee — the access token expires after a few hours, and an unused
// refresh token expires too (Shopee: ~30 days) → the shop would need a
// manual reconnect before Ads can start. So, once per `maxIdleHours`, an
// idle connected shop goes through the SAME getValidAccessToken path
// (single-flight in-process + DB refresh lease of SHOPEE-1, encrypted
// atomic update). A shop whose token is still fresh is not touched.
// One refresh call per shop per day at most. Never throws.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { TOKEN_REFRESH_BUFFER_SECONDS } from "./constants.ts";

export interface KeepaliveResult {
  checked: number;
  refreshed: string[];
  failed: Array<{ shopId: string; message: string }>;
}

const USABLE = ["connected", "error"];

export async function keepShopeeTokensAlive(
  db: SupabaseClient,
  tokens: { getValidAccessToken(shopId: string): Promise<string> },
  options: { maxIdleHours?: number; now?: Date } = {},
): Promise<KeepaliveResult> {
  const now = options.now ?? new Date();
  const maxIdleMs = (options.maxIdleHours ?? 24) * 3_600_000;
  const result: KeepaliveResult = { checked: 0, refreshed: [], failed: [] };
  const { data, error } = await db
    .from("shop_connections")
    .select("shop_id, connection_status, access_token_expires_at, last_token_refresh_at, created_at, shops!inner(is_active, data_source)")
    .eq("shops.is_active", true)
    .eq("shops.data_source", "live")
    .in("connection_status", USABLE);
  if (error) {
    result.failed.push({ shopId: "*", message: error.message.slice(0, 200) });
    return result;
  }
  for (const c of (data ?? []) as Array<{ shop_id: string; access_token_expires_at: string | null; last_token_refresh_at: string | null; created_at: string }>) {
    result.checked++;
    const lastRefresh = new Date(c.last_token_refresh_at ?? c.created_at).getTime();
    const accessFresh = c.access_token_expires_at && new Date(c.access_token_expires_at).getTime() - now.getTime() > TOKEN_REFRESH_BUFFER_SECONDS * 1000;
    if (now.getTime() - lastRefresh < maxIdleMs || accessFresh) continue;
    try {
      await tokens.getValidAccessToken(c.shop_id); // refreshes (expired / near-expiry access token)
      result.refreshed.push(c.shop_id);
    } catch (err) {
      result.failed.push({ shopId: c.shop_id, message: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
  }
  return result;
}
