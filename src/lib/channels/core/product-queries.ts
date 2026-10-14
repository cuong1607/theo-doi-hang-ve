// ============================================================
// PHASE SHOPEE-2: read queries for the channel product mapping screens.
//
// Server-only, service-role — callers authorize first (channel:view).
// Everything reads v_channel_model_listing (one row per sellable unit with
// item, shop and internal product already joined → no N+1). NUMERIC values
// arrive as text from the view and stay strings.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";

import type { Decimal, MappingStatus } from "./types.ts";

export interface ChannelModelListRow {
  channelModelId: string;
  shopId: string;
  shopName: string;
  dataSource: string;
  externalItemId: string;
  itemName: string;
  itemSku: string | null;
  itemStatus: string | null;
  isKit: boolean | null;
  externalModelId: string;
  isSynthetic: boolean;
  modelName: string | null;
  modelSku: string | null;
  modelStatus: string | null;
  channelSku: string | null;
  channelCurrentPrice: Decimal | null;
  channelOriginalPrice: Decimal | null;
  availableStock: Decimal | null;
  reservedStock: Decimal | null;
  mappingStatus: MappingStatus;
  mappingReviewRequired: boolean;
  mappedAt: string | null;
  removedAt: string | null;
  isActive: boolean;
  internalProductId: string | null;
  internalSku: string | null;
  internalProductName: string | null;
  lastSyncedAt: string | null;
  /** Order lines resolved through this unit — > 0 locks unmap / free remap (migration 00041). */
  orderItemCount: number;
}

export interface ChannelModelFilters {
  shopId?: string;
  mappingStatus?: MappingStatus | "review";
  itemStatus?: string;
  itemName?: string;
  channelSku?: string;
  internalSku?: string;
}

const COLUMNS =
  "channel_model_id, shop_id, shop_name, data_source, external_item_id, item_name, item_sku, item_status, is_kit, " +
  "external_model_id, is_synthetic, model_name, model_sku, model_status, channel_sku, channel_current_price, " +
  "channel_original_price, available_stock, reserved_stock, mapping_status, mapping_review_required, mapped_at, " +
  "removed_at, is_active, internal_product_id, internal_sku, internal_product_name, last_synced_at, order_item_count";

type ViewRow = {
  channel_model_id: string;
  shop_id: string;
  shop_name: string;
  data_source: string;
  external_item_id: string;
  item_name: string;
  item_sku: string | null;
  item_status: string | null;
  is_kit: boolean | null;
  external_model_id: string;
  is_synthetic: boolean;
  model_name: string | null;
  model_sku: string | null;
  model_status: string | null;
  channel_sku: string | null;
  channel_current_price: string | null;
  channel_original_price: string | null;
  available_stock: string | null;
  reserved_stock: string | null;
  mapping_status: MappingStatus;
  mapping_review_required: boolean;
  mapped_at: string | null;
  removed_at: string | null;
  is_active: boolean;
  internal_product_id: string | null;
  internal_sku: string | null;
  internal_product_name: string | null;
  last_synced_at: string | null;
  order_item_count: number | string;
};

function toRow(r: ViewRow): ChannelModelListRow {
  return {
    channelModelId: r.channel_model_id,
    shopId: r.shop_id,
    shopName: r.shop_name,
    dataSource: r.data_source,
    externalItemId: r.external_item_id,
    itemName: r.item_name,
    itemSku: r.item_sku,
    itemStatus: r.item_status,
    isKit: r.is_kit,
    externalModelId: r.external_model_id,
    isSynthetic: r.is_synthetic,
    modelName: r.model_name,
    modelSku: r.model_sku,
    modelStatus: r.model_status,
    channelSku: r.channel_sku,
    channelCurrentPrice: r.channel_current_price,
    channelOriginalPrice: r.channel_original_price,
    availableStock: r.available_stock,
    reservedStock: r.reserved_stock,
    mappingStatus: r.mapping_status,
    mappingReviewRequired: r.mapping_review_required,
    mappedAt: r.mapped_at,
    removedAt: r.removed_at,
    isActive: r.is_active,
    internalProductId: r.internal_product_id,
    internalSku: r.internal_sku,
    internalProductName: r.internal_product_name,
    lastSyncedAt: r.last_synced_at,
    orderItemCount: Number(r.order_item_count ?? 0), // a count, not money
  };
}

export async function getShopeeProducts(filters: ChannelModelFilters, page: number, pageSize: number) {
  const db = createAdminClient();
  const from = (page - 1) * pageSize;
  let query = db
    .from("v_channel_model_listing")
    .select(COLUMNS, { count: "exact" })
    .eq("channel", "shopee")
    .order("shop_name")
    .order("item_name")
    .order("external_model_id")
    .range(from, from + pageSize - 1);
  if (filters.shopId) query = query.eq("shop_id", filters.shopId);
  if (filters.mappingStatus === "review") query = query.eq("mapping_review_required", true);
  else if (filters.mappingStatus) query = query.eq("mapping_status", filters.mappingStatus);
  if (filters.itemStatus) query = query.eq("item_status", filters.itemStatus);
  if (filters.itemName) query = query.ilike("item_name", `%${escapeIlikeTerm(filters.itemName)}%`);
  if (filters.channelSku) query = query.ilike("channel_sku", `%${escapeIlikeTerm(filters.channelSku)}%`);
  if (filters.internalSku) query = query.ilike("internal_sku", `%${escapeIlikeTerm(filters.internalSku)}%`);
  const { data, error, count } = await query.returns<ViewRow[]>();
  if (error) throw new Error(error.message);
  return { rows: (data ?? []).map(toRow), total: count ?? 0 };
}

export interface MappingSummary {
  totalModels: number;
  activeModels: number;
  activeMapped: number;
  activeUnmapped: number;
  activeConflict: number;
  reviewRequired: number;
  inactiveModels: number;
}

export async function getShopeeProductMappingSummary(shopId?: string): Promise<MappingSummary> {
  const { data, error } = await createAdminClient().rpc("get_channel_mapping_summary", { p_shop_id: shopId ?? null });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, number | string> | undefined;
  const n = (key: string) => Number(row?.[key] ?? 0); // counts (bigint) — not money
  return {
    totalModels: n("total_models"),
    activeModels: n("active_models"),
    activeMapped: n("active_mapped"),
    activeUnmapped: n("active_unmapped"),
    activeConflict: n("active_conflict"),
    reviewRequired: n("review_required"),
    inactiveModels: n("inactive_models"),
  };
}

export async function getUnmappedShopeeModels(shopId: string, limit = 100): Promise<ChannelModelListRow[]> {
  const { data, error } = await createAdminClient()
    .from("v_channel_model_listing")
    .select(COLUMNS)
    .eq("shop_id", shopId)
    .eq("is_active", true)
    .in("mapping_status", ["unmapped", "mapping_conflict"])
    .order("item_name")
    .limit(limit)
    .returns<ViewRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toRow);
}

export async function getChannelModelsByIds(ids: string[]): Promise<Map<string, ChannelModelListRow>> {
  const result = new Map<string, ChannelModelListRow>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return result;
  const { data, error } = await createAdminClient().from("v_channel_model_listing").select(COLUMNS).in("channel_model_id", unique).returns<ViewRow[]>();
  if (error) throw new Error(error.message);
  for (const r of data ?? []) result.set(r.channel_model_id, toRow(r));
  return result;
}

export async function getChannelModelById(channelModelId: string): Promise<ChannelModelListRow | null> {
  const { data, error } = await createAdminClient()
    .from("v_channel_model_listing")
    .select(COLUMNS)
    .eq("channel_model_id", channelModelId)
    .maybeSingle<ViewRow>();
  if (error) throw new Error(error.message);
  return data ? toRow(data) : null;
}

export interface InternalProductOption {
  id: string;
  sku: string;
  name: string;
  isActive: boolean;
}

export async function searchInternalProducts(term: string, limit = 20): Promise<InternalProductOption[]> {
  const q = term.trim();
  if (!q) return [];
  const escaped = escapeIlikeTerm(q).replace(/[,()]/g, " ");
  const { data, error } = await createAdminClient()
    .from("products")
    .select("id, sku, name, is_active")
    .or(`sku.ilike.%${escaped}%,name.ilike.%${escaped}%`)
    .order("is_active", { ascending: false })
    .order("sku")
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string; sku: string; name: string; is_active: boolean }>).map((p) => ({ id: p.id, sku: p.sku, name: p.name, isActive: p.is_active }));
}
