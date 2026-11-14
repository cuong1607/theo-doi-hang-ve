// ============================================================
// APP-SHELL-1: Shopee connection / sync health for the hub card and the
// Shopee landing. Pure classification of values the database already holds
// (shop_connections, product_analytics_freshness, ads_sync_freshness) — no
// Shopee call, no new metric. Missing data is "none", never "ok".
// ============================================================

export type SyncState = "ok" | "stale" | "none" | "off";

export interface ShopSyncInput {
  shopId: string;
  shopName: string;
  /** shop_connections.connection_status (null = no connection row). */
  connectionStatus: string | null;
  /** Ads read jobs run only with SHOPEE_ADS_DATA_SOURCE=real. */
  adsReal: boolean;
  adsAt: string | null;
  salesEnabled: boolean;
  salesAt: string | null;
}

export interface ShopSyncHealth extends ShopSyncInput {
  connected: boolean;
  ads: SyncState;
  adsMinutes: number | null;
  sales: SyncState;
  salesMinutes: number | null;
  /** Something a person should look at (disconnected or stale). */
  attention: boolean;
}

export interface SyncThresholds {
  adsStaleMinutes: number;
  salesStaleMinutes: number;
}

const minutesSince = (iso: string | null, now: Date) => (iso ? Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000)) : null);

function state(enabled: boolean, minutes: number | null, staleAfter: number): SyncState {
  if (!enabled) return "off";
  if (minutes === null) return "none";
  return minutes > staleAfter ? "stale" : "ok";
}

export function classifyShopSync(input: ShopSyncInput, t: SyncThresholds, now: Date): ShopSyncHealth {
  const adsMinutes = minutesSince(input.adsAt, now);
  const salesMinutes = minutesSince(input.salesAt, now);
  const connected = input.connectionStatus === "connected";
  const ads = state(input.adsReal, adsMinutes, t.adsStaleMinutes);
  const sales = state(input.salesEnabled, salesMinutes, t.salesStaleMinutes);
  return { ...input, connected, ads, adsMinutes, sales, salesMinutes, attention: !connected || ads === "stale" || sales === "stale" };
}

export interface ConnectionSummary {
  shops: number;
  connected: number;
}

/** Hub card line, from connection status only (what the hub can read cheaply). */
export function connectionSummaryText(s: ConnectionSummary): { text: string; tone: "ok" | "warning" | "muted" } {
  if (s.shops === 0) return { text: "Chưa kết nối shop nào", tone: "muted" };
  const missing = s.shops - s.connected;
  if (missing > 0) return { text: `${missing}/${s.shops} shop cần kết nối lại`, tone: "warning" };
  return { text: "Kết nối bình thường", tone: "ok" };
}

export const SYNC_STATE_LABEL: Record<SyncState, string> = {
  ok: "Bình thường",
  stale: "Chậm cập nhật",
  none: "Chưa có dữ liệu",
  off: "Chưa bật",
};
