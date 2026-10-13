// ============================================================
// PHASE SHOPEE-3: read queries for channel orders (server-only, service-role —
// callers authorize first with channel:view).
//
// Lists read v_channel_order_summary (per-order derived metrics computed in
// SQL — no N+1). NUMERIC values arrive as text and stay strings; NULL means
// UNKNOWN (never shown as 0).
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";

import type { ChannelModelListRow } from "./product-queries.ts";
import { getChannelModelsByIds } from "./product-queries.ts";

export type MappingReadiness = "complete" | "partial" | "unmapped" | "no_items";
/** SHOPEE-4: complete = every line costed · partial = some · incomplete = none. */
export type CogsReadiness = "complete" | "partial" | "incomplete";

export interface ChannelOrderListRow {
  orderId: string;
  shopId: string;
  shopName: string;
  dataSource: string;
  externalOrderSn: string;
  orderStatus: string;
  financialStatus: string;
  currency: string;
  channelTotalAmount: string | null;
  createdAtChannel: string | null;
  updatedAtChannel: string | null;
  lastSyncedAt: string | null;
  lineCount: number;
  mappedLines: number;
  totalItemQuantity: string | null;
  itemGrossValue: string | null;
  originalItemValue: string | null;
  mappingReadiness: MappingReadiness;
  cogsReadiness: CogsReadiness;
  financialSyncEligible: boolean;
  costedLines: number;
  /** Authoritative only when every line is costed (else NULL). Excludes reversed lines. */
  totalCogs: string | null;
  /** Sum of the lines that ARE costed — diagnostics only, never a total. */
  partialCogsSum: string | null;
  reversedLines: number;
}

export interface ChannelOrderFilters {
  shopId?: string;
  dateFrom?: string; // YYYY-MM-DD (VN calendar day, inclusive)
  dateTo?: string;
  orderStatus?: string;
  mappingReadiness?: MappingReadiness;
  financialStatus?: string;
  orderSn?: string;
  /** Matches Shopee item/model SKU, item name, or the internal SKU of a line. */
  sku?: string;
}

type SummaryRow = {
  order_id: string;
  shop_id: string;
  shop_name: string;
  data_source: string;
  external_order_sn: string;
  order_status: string;
  financial_status: string;
  currency: string;
  channel_total_amount: string | null;
  created_at_channel: string | null;
  updated_at_channel: string | null;
  last_synced_at: string | null;
  line_count: number | string;
  mapped_lines: number | string;
  total_item_quantity: string | null;
  item_gross_value: string | null;
  original_item_value: string | null;
  mapping_readiness: MappingReadiness;
  cogs_readiness: CogsReadiness;
  financial_sync_eligible: boolean;
  costed_lines: number | string;
  total_cogs: string | null;
  partial_cogs_sum: string | null;
  reversed_lines: number | string;
};

const COLUMNS =
  "order_id, shop_id, shop_name, data_source, external_order_sn, order_status, financial_status, currency, channel_total_amount, " +
  "created_at_channel, updated_at_channel, last_synced_at, line_count, mapped_lines, total_item_quantity, item_gross_value, " +
  "original_item_value, mapping_readiness, cogs_readiness, financial_sync_eligible, costed_lines, total_cogs, partial_cogs_sum, reversed_lines";

function toRow(r: SummaryRow): ChannelOrderListRow {
  return {
    orderId: r.order_id,
    shopId: r.shop_id,
    shopName: r.shop_name,
    dataSource: r.data_source,
    externalOrderSn: r.external_order_sn,
    orderStatus: r.order_status,
    financialStatus: r.financial_status,
    currency: r.currency,
    channelTotalAmount: r.channel_total_amount,
    createdAtChannel: r.created_at_channel,
    updatedAtChannel: r.updated_at_channel,
    lastSyncedAt: r.last_synced_at,
    lineCount: Number(r.line_count), // counts, not money
    mappedLines: Number(r.mapped_lines),
    totalItemQuantity: r.total_item_quantity,
    itemGrossValue: r.item_gross_value,
    originalItemValue: r.original_item_value,
    mappingReadiness: r.mapping_readiness,
    cogsReadiness: r.cogs_readiness,
    financialSyncEligible: r.financial_sync_eligible,
    costedLines: Number(r.costed_lines),
    totalCogs: r.total_cogs,
    partialCogsSum: r.partial_cogs_sum,
    reversedLines: Number(r.reversed_lines),
  };
}

/** VN calendar day → UTC instant (Asia/Ho_Chi_Minh is UTC+7, no DST). */
function vnDayStart(day: string): string {
  return new Date(`${day}T00:00:00+07:00`).toISOString();
}

async function orderIdsMatchingSku(term: string): Promise<string[]> {
  const db = createAdminClient();
  const like = `%${escapeIlikeTerm(term).replace(/[,()]/g, " ")}%`;
  const [byChannel, byInternal] = await Promise.all([
    db.from("channel_order_items").select("order_id").or(`item_sku.ilike.${like},model_sku.ilike.${like},item_name.ilike.${like}`).limit(1000),
    db.from("channel_order_items").select("order_id, products!inner(sku)").ilike("products.sku", like).limit(1000),
  ]);
  if (byChannel.error) throw new Error(byChannel.error.message);
  if (byInternal.error) throw new Error(byInternal.error.message);
  return [...new Set([...(byChannel.data ?? []), ...(byInternal.data ?? [])].map((r) => (r as { order_id: string }).order_id))];
}

export async function getChannelOrders(filters: ChannelOrderFilters, page: number, pageSize: number) {
  let restrictIds: string[] | null = null;
  if (filters.sku) {
    restrictIds = await orderIdsMatchingSku(filters.sku);
    if (restrictIds.length === 0) return { rows: [] as ChannelOrderListRow[], total: 0 };
  }
  const from = (page - 1) * pageSize;
  let query = createAdminClient()
    .from("v_channel_order_summary")
    .select(COLUMNS, { count: "exact" })
    .order("created_at_channel", { ascending: false, nullsFirst: false })
    .order("external_order_sn")
    .range(from, from + pageSize - 1);
  if (filters.shopId) query = query.eq("shop_id", filters.shopId);
  if (filters.dateFrom) query = query.gte("created_at_channel", vnDayStart(filters.dateFrom));
  if (filters.dateTo) query = query.lt("created_at_channel", new Date(new Date(vnDayStart(filters.dateTo)).getTime() + 86_400_000).toISOString());
  if (filters.orderStatus) query = query.eq("order_status", filters.orderStatus);
  if (filters.mappingReadiness) query = query.eq("mapping_readiness", filters.mappingReadiness);
  if (filters.financialStatus) query = query.eq("financial_status", filters.financialStatus);
  if (filters.orderSn) query = query.ilike("external_order_sn", `%${escapeIlikeTerm(filters.orderSn)}%`);
  if (restrictIds) query = query.in("order_id", restrictIds);
  const { data, error, count } = await query.returns<SummaryRow[]>();
  if (error) throw new Error(error.message);
  return { rows: (data ?? []).map(toRow), total: count ?? 0 };
}

export async function getOrderMappingReadiness(orderId: string): Promise<ChannelOrderListRow | null> {
  const { data, error } = await createAdminClient().from("v_channel_order_summary").select(COLUMNS).eq("order_id", orderId).maybeSingle<SummaryRow>();
  if (error) throw new Error(error.message);
  return data ? toRow(data) : null;
}

export async function getOrdersNeedingMapping(shopId: string, limit = 100): Promise<ChannelOrderListRow[]> {
  const { data, error } = await createAdminClient()
    .from("v_channel_order_summary")
    .select(COLUMNS)
    .eq("shop_id", shopId)
    .in("mapping_readiness", ["partial", "unmapped"])
    .order("created_at_channel", { ascending: false })
    .limit(limit)
    .returns<SummaryRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toRow);
}

/** COMPLETED orders — the input set for escrow/income sync (SHOPEE-5). Nothing is called here. */
export async function getOrdersEligibleForFinancialSync(shopId: string, limit = 500): Promise<ChannelOrderListRow[]> {
  const { data, error } = await createAdminClient()
    .from("v_channel_order_summary")
    .select(COLUMNS)
    .eq("shop_id", shopId)
    .eq("financial_sync_eligible", true)
    .order("updated_at_channel", { ascending: false })
    .limit(limit)
    .returns<SummaryRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toRow);
}

export interface ChannelOrderLine {
  id: string;
  providerLineKey: string | null;
  externalOrderItemId: string | null;
  externalItemId: string;
  externalModelId: string | null;
  itemName: string;
  modelName: string | null;
  itemSku: string | null;
  modelSku: string | null;
  quantity: string;
  originalUnitPrice: string | null;
  discountedUnitPrice: string | null;
  promotionType: string | null;
  channelModelId: string | null;
  internalProductId: string | null;
  internalSku: string | null;
  internalProductName: string | null;
  totalCogs: string | null;
  costMethod: string | null;
  costPerUnitSnapshot: string | null;
  cogsReversedAt: string | null;
  /** The sale_out posted for this line left the costing quantity below zero. */
  negativeInventory: boolean;
  /** Current state of the sellable unit (for the mapping CTA); null = listing not in catalog. */
  unit: ChannelModelListRow | null;
}

export interface ChannelOrderDetail {
  summary: ChannelOrderListRow;
  paidAtChannel: string | null;
  pickupDoneAtChannel: string | null;
  shipByDate: string | null;
  paymentMethod: string | null;
  cod: boolean | null;
  shippingCarrier: string | null;
  estimatedShippingFee: string | null;
  lines: ChannelOrderLine[];
}

export async function getChannelOrderDetail(orderId: string): Promise<ChannelOrderDetail | null> {
  const db = createAdminClient();
  const summary = await getOrderMappingReadiness(orderId);
  if (!summary) return null;
  const [{ data: order, error: orderError }, { data: items, error: itemsError }] = await Promise.all([
    db
      .from("channel_orders")
      .select("paid_at_channel, pickup_done_at_channel, ship_by_date, payment_method, cod, shipping_carrier, estimated_shipping_fee::text")
      .eq("id", orderId)
      .single(),
    db
      .from("channel_order_items")
      .select(
        "id, provider_line_key, external_order_item_id, external_item_id, external_model_id, item_name, model_name, item_sku, model_sku, " +
          "quantity::text, original_unit_price::text, discounted_unit_price::text, promotion_type, channel_model_id, internal_product_id, " +
          "total_cogs::text, cost_method, cost_per_unit_snapshot::text, cogs_reversed_at, products(sku, name)",
      )
      .eq("order_id", orderId)
      .order("provider_line_key"),
  ]);
  if (orderError || !order) throw new Error(orderError?.message ?? "order not found");
  if (itemsError) throw new Error(itemsError.message);

  type ItemRow = {
    id: string;
    provider_line_key: string | null;
    external_order_item_id: string | null;
    external_item_id: string;
    external_model_id: string | null;
    item_name: string;
    model_name: string | null;
    item_sku: string | null;
    model_sku: string | null;
    quantity: string;
    original_unit_price: string | null;
    discounted_unit_price: string | null;
    promotion_type: string | null;
    channel_model_id: string | null;
    internal_product_id: string | null;
    total_cogs: string | null;
    cost_method: string | null;
    cost_per_unit_snapshot: string | null;
    cogs_reversed_at: string | null;
    products: { sku: string; name: string } | null;
  };
  const rows = (items ?? []) as unknown as ItemRow[];
  const [units, { data: sales }] = await Promise.all([
    getChannelModelsByIds(rows.map((r) => r.channel_model_id).filter((id): id is string => !!id)),
    db
      .from("inventory_cost_ledger")
      .select("source_id, qty_after::text")
      .eq("source_type", "channel_order_item")
      .eq("event_type", "sale_out")
      .in("source_id", rows.length ? rows.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"]),
  ]);
  const negative = new Set(((sales ?? []) as Array<{ source_id: string; qty_after: string }>).filter((s) => s.qty_after.startsWith("-")).map((s) => s.source_id));
  const o = order as unknown as {
    paid_at_channel: string | null;
    pickup_done_at_channel: string | null;
    ship_by_date: string | null;
    payment_method: string | null;
    cod: boolean | null;
    shipping_carrier: string | null;
    estimated_shipping_fee: string | null;
  };
  return {
    summary,
    paidAtChannel: o.paid_at_channel,
    pickupDoneAtChannel: o.pickup_done_at_channel,
    shipByDate: o.ship_by_date,
    paymentMethod: o.payment_method,
    cod: o.cod,
    shippingCarrier: o.shipping_carrier,
    estimatedShippingFee: o.estimated_shipping_fee,
    lines: rows.map((r) => ({
      id: r.id,
      providerLineKey: r.provider_line_key,
      externalOrderItemId: r.external_order_item_id,
      externalItemId: r.external_item_id,
      externalModelId: r.external_model_id,
      itemName: r.item_name,
      modelName: r.model_name,
      itemSku: r.item_sku,
      modelSku: r.model_sku,
      quantity: r.quantity,
      originalUnitPrice: r.original_unit_price,
      discountedUnitPrice: r.discounted_unit_price,
      promotionType: r.promotion_type,
      channelModelId: r.channel_model_id,
      internalProductId: r.internal_product_id,
      internalSku: r.products?.sku ?? null,
      internalProductName: r.products?.name ?? null,
      totalCogs: r.total_cogs,
      costMethod: r.cost_method,
      costPerUnitSnapshot: r.cost_per_unit_snapshot,
      cogsReversedAt: r.cogs_reversed_at,
      negativeInventory: negative.has(r.id),
      unit: r.channel_model_id ? units.get(r.channel_model_id) ?? null : null,
    })),
  };
}
