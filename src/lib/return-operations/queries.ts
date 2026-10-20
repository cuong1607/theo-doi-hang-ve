// ============================================================
// PHASE SHOPEE-6B: daily return-operation read services. Read the canonical
// DB only (v_return_operations + RPCs, migration 00060) — never Shopee.
// Every "how many / which" question (page, export, notification, future
// ask/query use cases) goes through these functions.
//
// DB client injected (service-role on the server, real local DB in tests);
// no "server-only" marker so integration tests can drive it.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ReturnOperationType } from "./classify.ts";
import { buildDailySummary, type DailySummary, type SummaryRow } from "./summary.ts";
import type { DeliveryWindow } from "./windows.ts";

export interface DailyFilters {
  /** YYYY-MM-DD business date. */
  date: string;
  shopId?: string | null;
  /** null/undefined = all; "" = unknown carrier. */
  carrier?: string | null;
  operationType?: ReturnOperationType | null;
  /** window uuid | "outside" */
  deliveryWindowId?: string | null;
}

export interface ListFilters extends DailyFilters {
  status?: string | null;
  search?: string | null;
  /** delivered (default) = delivered on `date`; open = not delivered yet (any date). */
  view?: "delivered" | "open";
  page?: number;
  pageSize?: number;
}

export interface ReturnOperationItem {
  name: string;
  model: string | null;
  sku: string | null;
  quantity: string;
}

export interface ReturnOperationRow {
  id: string;
  shopId: string;
  shopName: string;
  channelOrderId: string;
  externalOrderSn: string;
  returnId: string | null;
  operationType: ReturnOperationType;
  returnSn: string | null;
  trackingNumber: string | null;
  rtsTrackingNumber: string | null;
  carrier: string | null;
  providerStatus: string | null;
  canonicalStatus: string;
  sourceSegment: string | null;
  deliveredToSellerAt: string | null;
  deliveredAtSource: string | null;
  businessDate: string | null;
  windowId: string | null;
  lastStatusAt: string | null;
  lastSyncedAt: string;
  assignedReceiverId: string | null;
  receivedConfirmedAt: string | null;
  receivedConfirmedBy: string | null;
  needsAttention: boolean;
  attentionReason: string | null;
  itemQuantity: string;
  items: ReturnOperationItem[];
  /** Hoàn Trả: Shopee reason code + buyer text; Hoàn Hủy: order cancel_reason (00062). */
  returnReason: string | null;
  returnTextReason: string | null;
  cancelReason: string | null;
}

const shopIdsOf = (shopId: string | null | undefined) => (shopId ? [shopId] : null);

export async function loadDeliveryWindows(db: SupabaseClient): Promise<DeliveryWindow[]> {
  const { data, error } = await db.from("return_delivery_windows").select("id, shop_id, carrier, name, start_time, end_time, sort_order, enabled").order("sort_order").order("start_time");
  if (error) throw new Error(`Không đọc được cấu hình ca giao: ${error.message}`);
  return (data ?? []).map((w) => ({
    id: w.id as string,
    shopId: (w.shop_id as string | null) ?? null,
    carrier: (w.carrier as string | null) ?? null,
    name: w.name as string,
    startTime: String(w.start_time).slice(0, 5),
    endTime: String(w.end_time).slice(0, 5),
    sortOrder: w.sort_order as number,
    enabled: w.enabled as boolean,
  }));
}

/** getDailyReturnOperationsSummary — carrier groups → delivery windows (+ outside) → totals, aggregated in SQL. */
export async function getDailyReturnOperationsSummary(db: SupabaseClient, filters: DailyFilters, options: { scopeShopIds?: string[]; windows?: DeliveryWindow[] } = {}): Promise<DailySummary> {
  const [{ data, error }, windows] = await Promise.all([
    db.rpc("get_return_operations_daily_summary", {
      p_date: filters.date,
      p_shop_ids: shopIdsOf(filters.shopId),
      p_carrier: filters.carrier ?? null,
      p_type: filters.operationType ?? null,
      p_window: filters.deliveryWindowId ?? null,
    }),
    options.windows ? Promise.resolve(options.windows) : loadDeliveryWindows(db),
  ]);
  if (error) throw new Error(`Không tổng hợp được hàng hoàn: ${error.message}`);
  const shopIds = filters.shopId ? [filters.shopId] : (options.scopeShopIds ?? []);
  const summary = buildDailySummary({ date: filters.date, rows: (data ?? []) as SummaryRow[], windows, shopIds });
  if (filters.deliveryWindowId) {
    // a window filter keeps only that bucket (the configured-but-empty ones would be noise)
    for (const g of summary.carrierGroups) g.deliveryWindows = g.deliveryWindows.filter((w) => w.windowId === filters.deliveryWindowId);
  }
  return summary;
}

interface ListRpcRow {
  id: string;
  shop_id: string;
  shop_name: string;
  channel_order_id: string;
  external_order_sn: string;
  return_id: string | null;
  operation_type: ReturnOperationType;
  return_sn: string | null;
  tracking_number: string | null;
  rts_tracking_number: string | null;
  carrier: string | null;
  provider_status: string | null;
  canonical_status: string;
  source_segment: string | null;
  delivered_to_seller_at: string | null;
  delivered_at_source: string | null;
  business_date: string | null;
  window_id: string | null;
  last_status_at: string | null;
  last_synced_at: string;
  assigned_receiver_id: string | null;
  received_confirmed_at: string | null;
  received_confirmed_by: string | null;
  needs_attention: boolean;
  attention_reason: string | null;
  item_qty: string;
  items: ReturnOperationItem[];
  return_reason: string | null;
  return_text_reason: string | null;
  cancel_reason: string | null;
  total_count: number | string;
}

export const MAX_EXPORT_ROWS = 5000;

/** getDailyReturnOperationsList — server-side pagination, sorted by delivered time ASC. */
export async function getDailyReturnOperationsList(db: SupabaseClient, filters: ListFilters): Promise<{ rows: ReturnOperationRow[]; total: number }> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? 50, 1), MAX_EXPORT_ROWS);
  const page = Math.max(filters.page ?? 1, 1);
  const { data, error } = await db.rpc("list_return_operations", {
    p_date: filters.date,
    p_shop_ids: shopIdsOf(filters.shopId),
    p_carrier: filters.carrier ?? null,
    p_type: filters.operationType ?? null,
    p_window: filters.deliveryWindowId ?? null,
    p_status: filters.status ?? null,
    p_search: filters.search?.trim() || null,
    p_view: filters.view ?? "delivered",
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (error) throw new Error(`Không đọc được danh sách hàng hoàn: ${error.message}`);
  const rows = (data ?? []) as ListRpcRow[];
  return {
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    rows: rows.map((r) => ({
      id: r.id,
      shopId: r.shop_id,
      shopName: r.shop_name,
      channelOrderId: r.channel_order_id,
      externalOrderSn: r.external_order_sn,
      returnId: r.return_id,
      operationType: r.operation_type,
      returnSn: r.return_sn,
      trackingNumber: r.tracking_number,
      rtsTrackingNumber: r.rts_tracking_number,
      carrier: r.carrier,
      providerStatus: r.provider_status,
      canonicalStatus: r.canonical_status,
      sourceSegment: r.source_segment,
      deliveredToSellerAt: r.delivered_to_seller_at,
      deliveredAtSource: r.delivered_at_source,
      businessDate: r.business_date,
      windowId: r.window_id,
      lastStatusAt: r.last_status_at,
      lastSyncedAt: r.last_synced_at,
      assignedReceiverId: r.assigned_receiver_id,
      receivedConfirmedAt: r.received_confirmed_at,
      receivedConfirmedBy: r.received_confirmed_by,
      needsAttention: r.needs_attention,
      attentionReason: r.attention_reason,
      itemQuantity: r.item_qty,
      items: r.items ?? [],
      returnReason: r.return_reason,
      returnTextReason: r.return_text_reason,
      cancelReason: r.cancel_reason,
    })),
  };
}

export async function getReturnOperationCounters(db: SupabaseClient, date: string, shopId?: string | null): Promise<{ open: number; attention: number; unconfirmedToday: number }> {
  const { data, error } = await db.rpc("get_return_operations_counters", { p_date: date, p_shop_ids: shopIdsOf(shopId) });
  if (error) throw new Error(`Không đọc được bộ đếm hàng hoàn: ${error.message}`);
  const d = (data ?? {}) as { open?: number; attention?: number; unconfirmed_today?: number };
  return { open: d.open ?? 0, attention: d.attention ?? 0, unconfirmedToday: d.unconfirmed_today ?? 0 };
}

/** Carriers seen in return operations (filter dropdown). */
export async function listReturnCarriers(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from("channel_return_operations").select("logistics_provider").not("logistics_provider", "is", null).order("logistics_provider").limit(1000);
  if (error) throw new Error(error.message);
  const seen = new Map<string, string>();
  for (const r of data ?? []) {
    const c = String(r.logistics_provider).trim();
    if (c && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
  }
  return [...seen.values()];
}

export const RETURN_SYNC_FRESHNESS_TYPES = [
  { syncType: "return", label: "Trả hàng (Return API)" },
  { syncType: "return_logistics", label: "Vận chuyển Hoàn Trả" },
  { syncType: "failed_delivery", label: "Vận chuyển Hoàn Hủy" },
] as const;

export interface ReturnSyncFreshness {
  syncType: string;
  label: string;
  /** Oldest "last finished job" (success or partial) across the scoped shops; null = never. */
  lastSyncedAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
}

/**
 * Freshness per return sync type. A partial job (one broken return) still
 * refreshed everything else, so the time of the last FINISHED job counts
 * (success or partial), not only clean successes.
 */
export async function getReturnSyncFreshness(db: SupabaseClient, shopIds: string[], staleMinutes: number, now: Date = new Date()): Promise<ReturnSyncFreshness[]> {
  if (shopIds.length === 0) return RETURN_SYNC_FRESHNESS_TYPES.map((t) => ({ ...t, lastSyncedAt: null, ageMinutes: null, stale: true }));
  const { data, error } = await db.from("channel_sync_states").select("shop_id, sync_type, last_success_at, metadata").in("shop_id", shopIds).in("sync_type", RETURN_SYNC_FRESHNESS_TYPES.map((t) => t.syncType));
  if (error) throw new Error(`Không đọc được trạng thái đồng bộ: ${error.message}`);
  const rows = (data ?? []) as Array<{ shop_id: string; sync_type: string; last_success_at: string | null; metadata: Record<string, unknown> | null }>;
  return RETURN_SYNC_FRESHNESS_TYPES.map((t) => {
    let oldest: number | null = null;
    let missing = false;
    for (const shopId of shopIds) {
      const s = rows.find((r) => r.shop_id === shopId && r.sync_type === t.syncType);
      const finished = typeof s?.metadata?.lastJobFinishedAt === "string" && (s.metadata.lastJobStatus === "success" || s.metadata.lastJobStatus === "partial") ? new Date(s.metadata.lastJobFinishedAt).getTime() : 0;
      const at = Math.max(s?.last_success_at ? new Date(s.last_success_at).getTime() : 0, finished);
      if (!at) missing = true;
      else oldest = oldest === null ? at : Math.min(oldest, at);
    }
    const lastSyncedAt = missing || oldest === null ? null : new Date(oldest).toISOString();
    const ageMinutes = lastSyncedAt ? Math.floor((now.getTime() - oldest!) / 60_000) : null;
    return { ...t, lastSyncedAt, ageMinutes, stale: ageMinutes === null || ageMinutes > staleMinutes };
  });
}

export interface ReturnOperationSettings {
  confirmationEnabled: boolean;
  confirmAttentionHours: number;
  stuckTransitDays: number;
  trackingMissingHours: number;
  syncStaleWarnMinutes: number;
  trackingLookbackDays: number;
}

export async function loadReturnOperationSettings(db: SupabaseClient): Promise<ReturnOperationSettings> {
  const { data, error } = await db.from("return_operation_settings").select("*").eq("id", true).single();
  if (error) throw new Error(`Không đọc được cấu hình hàng hoàn: ${error.message}`);
  return {
    confirmationEnabled: data.confirmation_enabled,
    confirmAttentionHours: data.confirm_attention_hours,
    stuckTransitDays: data.stuck_transit_days,
    trackingMissingHours: data.tracking_missing_hours,
    syncStaleWarnMinutes: data.sync_stale_warn_minutes,
    trackingLookbackDays: data.tracking_lookback_days,
  };
}
