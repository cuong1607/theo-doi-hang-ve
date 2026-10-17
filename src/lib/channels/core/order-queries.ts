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
  /** SHOPEE-5 (NULL = not known yet, never 0). */
  shopeeNetIncome: string | null;
  internalCogs: string | null;
  profitAfterCogs: string | null;
  reconciliationStatus: "matched" | "warning" | "mismatch" | null;
  settlementState: "missing" | "available";
  profitState: "profit" | "loss" | "break_even" | null;
  /**
   * Estimated profit = Shopee estimated order revenue − internal COGS
   * (NUMERIC, in the view — 00052). NULL when either side is unknown.
   */
  estimatedProfit: string | null;
  /** estimatedProfit / channel_total_amount × 100, 1 decimal; NULL when the total is ≤ 0 / unknown. */
  estimatedMarginPct: string | null;
  estimatedProfitState: EstimatedProfitState;
  /** Shopee "Doanh thu đơn hàng ước tính" (escrow_amount), NULL = not fetched yet. */
  estimatedOrderRevenue: string | null;
  estimatedRevenueSource: EstimatedRevenueSource | null;
  /** At least one costed line uses a provisional (default-VAT) cost — "Tạm tính" (00054). */
  cogsProvisional: boolean;
}

export type EstimatedProfitState = "profit" | "loss" | "insufficient";
/** escrow_estimate = fetched while the order was open · escrow_settlement = first known at settlement. */
export type EstimatedRevenueSource = "escrow_estimate" | "escrow_settlement";

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
  /** SHOPEE-5 financial filters (all view-derived). */
  profitState?: "profit" | "loss" | "break_even";
  reconciliation?: "matched" | "warning" | "mismatch";
  settlementState?: "missing" | "available";
  cogsReadiness?: CogsReadiness;
  /** internal_cogs unknown (incomplete OR partial lines), same rule as the summary count. */
  cogsMissing?: boolean;
  /** PATCH: estimated profit state (view-derived). */
  estimatedState?: EstimatedProfitState;
}

export interface OrderFinancialSummary {
  orderCount: number;
  withIncome: number;
  incomeSum: string;
  withCogs: number;
  cogsSum: string;
  withProfit: number;
  profitSum: string;
  missingSettlement: number;
  missingCogs: number;
  mismatchCount: number;
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
  shopee_net_income: string | null;
  internal_cogs: string | null;
  profit_after_cogs: string | null;
  reconciliation_status: "matched" | "warning" | "mismatch" | null;
  settlement_state: "missing" | "available";
  profit_state: "profit" | "loss" | "break_even" | null;
  estimated_profit: string | null;
  estimated_margin_pct: string | null;
  estimated_profit_state: EstimatedProfitState;
  estimated_order_revenue: string | null;
  estimated_revenue_source: EstimatedRevenueSource | null;
  cogs_provisional: boolean;
};

const COLUMNS =
  "order_id, shop_id, shop_name, data_source, external_order_sn, order_status, financial_status, currency, channel_total_amount, " +
  "created_at_channel, updated_at_channel, last_synced_at, line_count, mapped_lines, total_item_quantity, item_gross_value, " +
  "original_item_value, mapping_readiness, cogs_readiness, financial_sync_eligible, costed_lines, total_cogs, partial_cogs_sum, reversed_lines, " +
  "shopee_net_income, internal_cogs, profit_after_cogs, reconciliation_status, settlement_state, profit_state, " +
  "estimated_profit, estimated_margin_pct, estimated_profit_state, estimated_order_revenue, estimated_revenue_source, cogs_provisional";

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
    shopeeNetIncome: r.shopee_net_income,
    internalCogs: r.internal_cogs,
    profitAfterCogs: r.profit_after_cogs,
    reconciliationStatus: r.reconciliation_status,
    settlementState: r.settlement_state,
    profitState: r.profit_state,
    estimatedProfit: r.estimated_profit,
    estimatedMarginPct: r.estimated_margin_pct,
    estimatedProfitState: r.estimated_profit_state,
    estimatedOrderRevenue: r.estimated_order_revenue,
    estimatedRevenueSource: r.estimated_revenue_source,
    cogsProvisional: r.cogs_provisional === true,
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
  // Line-derived filter (mapping readiness) → count through the view. Otherwise
  // count channel_orders directly: same rows (every order has its shop), but
  // without aggregating lines for the whole filtered set just to count it.
  const countOnBase = !filters.mappingReadiness && !filters.profitState && !filters.reconciliation && !filters.settlementState && !filters.cogsReadiness && !filters.cogsMissing && !filters.estimatedState;
  const db = createAdminClient();
  let query = db
    .from("v_channel_order_summary")
    .select(COLUMNS, countOnBase ? undefined : { count: "exact" })
    .order("created_at_channel", { ascending: false, nullsFirst: false })
    .order("external_order_sn")
    .range(from, from + pageSize - 1);
  let countQuery = db.from("channel_orders").select("id", { count: "exact", head: true });
  const dateTo = filters.dateTo ? new Date(new Date(vnDayStart(filters.dateTo)).getTime() + 86_400_000).toISOString() : null;
  const sn = filters.orderSn ? `%${escapeIlikeTerm(filters.orderSn)}%` : null;
  if (filters.shopId) {
    query = query.eq("shop_id", filters.shopId);
    countQuery = countQuery.eq("shop_id", filters.shopId);
  }
  if (filters.dateFrom) {
    query = query.gte("created_at_channel", vnDayStart(filters.dateFrom));
    countQuery = countQuery.gte("created_at_channel", vnDayStart(filters.dateFrom));
  }
  if (dateTo) {
    query = query.lt("created_at_channel", dateTo);
    countQuery = countQuery.lt("created_at_channel", dateTo);
  }
  if (filters.orderStatus) {
    query = query.eq("order_status", filters.orderStatus);
    countQuery = countQuery.eq("order_status", filters.orderStatus);
  }
  if (filters.financialStatus) {
    query = query.eq("financial_status", filters.financialStatus);
    countQuery = countQuery.eq("financial_status", filters.financialStatus);
  }
  if (sn) {
    query = query.ilike("external_order_sn", sn);
    countQuery = countQuery.ilike("external_order_sn", sn);
  }
  if (restrictIds) {
    query = query.in("order_id", restrictIds);
    countQuery = countQuery.in("id", restrictIds);
  }
  if (filters.mappingReadiness) query = query.eq("mapping_readiness", filters.mappingReadiness);
  if (filters.profitState) query = query.eq("profit_state", filters.profitState);
  if (filters.reconciliation) query = query.eq("reconciliation_status", filters.reconciliation);
  if (filters.settlementState) query = query.eq("settlement_state", filters.settlementState);
  if (filters.cogsReadiness) query = query.eq("cogs_readiness", filters.cogsReadiness);
  if (filters.cogsMissing) query = query.is("internal_cogs", null);
  if (filters.estimatedState) query = query.eq("estimated_profit_state", filters.estimatedState);
  const [list, counted] = await Promise.all([query.returns<SummaryRow[]>(), countOnBase ? countQuery : null]);
  if (list.error) throw new Error(list.error.message);
  if (counted?.error) throw new Error(counted.error.message);
  return { rows: (list.data ?? []).map(toRow), total: (countOnBase ? counted?.count : list.count) ?? 0 };
}

/**
 * DB-side totals for the filtered list (SHOPEE-5). Only authoritative values
 * are summed (income / COGS / profit present); the counts of what is missing
 * are returned instead of treating it as 0.
 */
export async function getOrderFinancialSummary(filters: ChannelOrderFilters): Promise<OrderFinancialSummary> {
  let orderIds: string[] | null = null;
  if (filters.sku) {
    orderIds = await orderIdsMatchingSku(filters.sku);
    if (orderIds.length === 0) return { orderCount: 0, withIncome: 0, incomeSum: "0", withCogs: 0, cogsSum: "0", withProfit: 0, profitSum: "0", missingSettlement: 0, missingCogs: 0, mismatchCount: 0 };
  }
  const { data, error } = await createAdminClient()
    .rpc("get_channel_order_financial_summary", {
      p_shop_id: filters.shopId ?? null,
      p_date_from: filters.dateFrom ? vnDayStart(filters.dateFrom) : null,
      p_date_to: filters.dateTo ? new Date(new Date(vnDayStart(filters.dateTo)).getTime() + 86_400_000).toISOString() : null,
      p_order_status: filters.orderStatus ?? null,
      p_financial_status: filters.financialStatus ?? null,
      p_mapping: filters.mappingReadiness ?? null,
      p_order_sn: filters.orderSn ? escapeIlikeTerm(filters.orderSn) : null,
      p_profit_state: filters.profitState ?? null,
      p_reconciliation: filters.reconciliation ?? null,
      p_settlement_state: filters.settlementState ?? null,
      p_cogs_readiness: filters.cogsReadiness ?? null,
      p_cogs_missing: filters.cogsMissing ?? null,
      p_estimated_state: filters.estimatedState ?? null,
      p_order_ids: orderIds,
    })
    .single<{
      order_count: number | string;
      with_income: number | string;
      income_sum: string;
      with_cogs: number | string;
      cogs_sum: string;
      with_profit: number | string;
      profit_sum: string;
      missing_settlement: number | string;
      missing_cogs: number | string;
      mismatch_count: number | string;
    }>();
  if (error || !data) throw new Error(error?.message ?? "Không đọc được tổng hợp tài chính.");
  return {
    orderCount: Number(data.order_count),
    withIncome: Number(data.with_income),
    incomeSum: data.income_sum,
    withCogs: Number(data.with_cogs),
    cogsSum: data.cogs_sum,
    withProfit: Number(data.with_profit),
    profitSum: data.profit_sum,
    missingSettlement: Number(data.missing_settlement),
    missingCogs: Number(data.missing_cogs),
    mismatchCount: Number(data.mismatch_count),
  };
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
  /** Sale posted while VAT-pending purchases were in stock: COGS waits for the supplier invoice. */
  costPending: boolean;
  /** COGS taken at a provisional (default-VAT) cost; trued up automatically when the invoice is linked. */
  costProvisional: boolean;
  /** Costing version of the snapshot (NULL = before moving-average-v2-vat). */
  costVersion: string | null;
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
          "total_cogs::text, cost_method, cost_per_unit_snapshot::text, cogs_reversed_at, cost_version, cost_provisional, products(sku, name)",
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
    cost_version: string | null;
    cost_provisional: boolean;
    products: { sku: string; name: string } | null;
  };
  const rows = (items ?? []) as unknown as ItemRow[];
  const [units, { data: sales }] = await Promise.all([
    getChannelModelsByIds(rows.map((r) => r.channel_model_id).filter((id): id is string => !!id)),
    db
      .from("inventory_cost_ledger")
      .select("source_id, qty_after::text, metadata")
      .eq("source_type", "channel_order_item")
      .eq("event_type", "sale_out")
      .in("source_id", rows.length ? rows.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"]),
  ]);
  const saleRows = (sales ?? []) as Array<{ source_id: string; qty_after: string; metadata: { cost_pending?: boolean } | null }>;
  const negative = new Set(saleRows.filter((s) => s.qty_after.startsWith("-")).map((s) => s.source_id));
  const pending = new Set(saleRows.filter((s) => s.metadata?.cost_pending === true).map((s) => s.source_id));
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
      costPending: r.total_cogs === null && pending.has(r.id),
      costProvisional: r.cost_provisional === true && r.total_cogs !== null,
      costVersion: r.cost_version,
      unit: r.channel_model_id ? units.get(r.channel_model_id) ?? null : null,
    })),
  };
}
