// ============================================================
// PHASE SHOPEE-0: minimal read repository for the channel module.
//
// Server-only, service-role client — the caller must authorize first via
// src/lib/auth/session.ts (channel:view for shops, channel:manage for
// connection status). Connection queries list their columns explicitly and
// NEVER select *_token_encrypted: tokens are read only by the server-only
// token module of SHOPEE-1.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { isChannel, isConnectionStatus, type Shop, type ShopConnectionStatus } from "./types.ts";

const SHOP_COLUMNS = "id, channel, external_shop_id, shop_name, currency, region, is_active, data_source, created_at, updated_at";

// Keep in sync with the column GRANT in migration 00038 (no token columns).
const CONNECTION_STATUS_COLUMNS =
  "id, shop_id, provider, connection_status, access_token_expires_at, last_token_refresh_at, " +
  "last_successful_api_call_at, last_error_at, last_error_code, last_error_message";

type ShopRow = {
  id: string;
  channel: string;
  external_shop_id: string;
  shop_name: string;
  currency: string | null;
  region: string | null;
  is_active: boolean;
  data_source: string;
  created_at: string;
  updated_at: string;
};

type ConnectionRow = {
  id: string;
  shop_id: string;
  provider: string;
  connection_status: string;
  access_token_expires_at: string | null;
  last_token_refresh_at: string | null;
  last_successful_api_call_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

function toShop(row: ShopRow): Shop {
  if (!isChannel(row.channel)) throw new Error(`Kênh bán không hợp lệ: ${row.channel}`);
  return {
    id: row.id,
    channel: row.channel,
    externalShopId: row.external_shop_id,
    shopName: row.shop_name,
    currency: row.currency,
    region: row.region,
    isActive: row.is_active,
    dataSource: row.data_source === "fixture" ? "fixture" : "live",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toConnectionStatus(row: ConnectionRow): ShopConnectionStatus {
  if (!isChannel(row.provider)) throw new Error(`Provider không hợp lệ: ${row.provider}`);
  if (!isConnectionStatus(row.connection_status)) {
    throw new Error(`Trạng thái kết nối không hợp lệ: ${row.connection_status}`);
  }
  return {
    id: row.id,
    shopId: row.shop_id,
    provider: row.provider,
    connectionStatus: row.connection_status,
    accessTokenExpiresAt: row.access_token_expires_at,
    lastTokenRefreshAt: row.last_token_refresh_at,
    lastSuccessfulApiCallAt: row.last_successful_api_call_at,
    lastErrorAt: row.last_error_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  };
}

export async function listShops(options: { activeOnly?: boolean } = {}): Promise<Shop[]> {
  const supabase = createAdminClient();
  let query = supabase.from("shops").select(SHOP_COLUMNS).order("shop_name");
  if (options.activeOnly) query = query.eq("is_active", true);
  const { data, error } = await query.returns<ShopRow[]>();
  if (error) throw error;
  return data.map(toShop);
}

export async function getShopById(id: string): Promise<Shop | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.from("shops").select(SHOP_COLUMNS).eq("id", id).maybeSingle<ShopRow>();
  if (error) throw error;
  return data ? toShop(data) : null;
}

export async function listShopConnectionStatuses(): Promise<ShopConnectionStatus[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("shop_connections")
    .select(CONNECTION_STATUS_COLUMNS)
    .returns<ConnectionRow[]>();
  if (error) throw error;
  return data.map(toConnectionStatus);
}
