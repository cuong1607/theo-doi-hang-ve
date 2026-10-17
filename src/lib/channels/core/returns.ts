// ============================================================
// PHASE SHOPEE-6: returns — disposition service + read models
// (channel-agnostic). The accounting lives in the database (migration
// 00057, one transaction per call):
//
//   setReturnDisposition          set_return_item_disposition: audit row +
//                                 inventory effect + financial recalculation
//   applyReturnInventoryEffect    (inside it) 'restock' → return_in per atomic
//                                 product at the ORIGINAL snapshot cost; combo
//                                 lines explode their historical component
//                                 snapshot; Σ restocked ≤ sold (row-locked)
//   reverseReturnInventoryEffect  (inside it) leaving 'restock' →
//                                 compensating adjustment_out, same qty / cost
//   recalculateReturnAdjustedFinancials  reversed_cogs → net_cogs → actual
//                                 profit, financial_status 'return_adjusted'
//
// refund ≠ restock: nothing here reacts to refund amounts or return status —
// only an explicit disposition moves stock. UI must call these, never write
// the tables directly.
// Takes the DB client as a parameter (service-role on the server, injected
// in tests).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { isReturnDisposition, type ReturnDisposition } from "../shopee/return-status.ts";

export class ReturnDispositionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReturnDispositionError";
    this.code = code;
  }
}

export interface DispositionResult {
  changed: boolean;
  disposition: ReturnDisposition;
  inventoryEffect: "none" | "restocked" | "restock_reversed";
  /** COGS restored (+) or taken back (−) by this change. */
  cogsDelta: string;
  reversedCogs: string | null;
}

export async function setReturnDisposition(
  db: SupabaseClient,
  input: { returnItemId: string; disposition: ReturnDisposition; reason?: string | null; changedBy: string | null },
): Promise<DispositionResult> {
  if (!isReturnDisposition(input.disposition)) throw new ReturnDispositionError("RT010", "Cách xử lý không hợp lệ.");
  const { data, error } = await db.rpc("set_return_item_disposition", {
    p_return_item_id: input.returnItemId,
    p_disposition: input.disposition,
    p_reason: input.reason ?? null,
    p_by: input.changedBy,
  });
  if (error) {
    if (error.code?.startsWith("RT")) throw new ReturnDispositionError(error.code, error.message);
    throw new Error(error.message);
  }
  const r = data as { changed: boolean; disposition: ReturnDisposition; inventory_effect: DispositionResult["inventoryEffect"]; cogs_delta: string; reversed_cogs?: string };
  console.info(
    JSON.stringify({ source: "returns", event: "return_disposition_changed", returnItemId: input.returnItemId, disposition: r.disposition, effect: r.inventory_effect, cogsDelta: r.cogs_delta }),
  );
  return { changed: r.changed, disposition: r.disposition, inventoryEffect: r.inventory_effect, cogsDelta: r.cogs_delta, reversedCogs: r.reversed_cogs ?? null };
}

/** Recalculates reversed / net COGS, actual profit and the return_adjusted status of one order. */
export async function recalculateReturnAdjustedFinancials(db: SupabaseClient, orderId: string): Promise<{ reversedCogs: string; financialStatus: string }> {
  const { data, error } = await db.rpc("recalculate_return_adjusted_financials", { p_order_id: orderId });
  if (error) throw new Error(error.message);
  const r = data as { reversed_cogs: string; financial_status: string };
  return { reversedCogs: r.reversed_cogs, financialStatus: r.financial_status };
}

// ------------------------------------------------------------------ reads

export interface ReturnListRow {
  returnId: string;
  shopId: string;
  shopName: string;
  orderId: string;
  externalOrderSn: string;
  externalReturnSn: string;
  status: string | null;
  isTerminal: boolean;
  reason: string | null;
  refundAmount: string | null;
  sellerCompensationAmount: string | null;
  currency: string | null;
  createdAtChannel: string | null;
  updatedAtChannel: string | null;
  itemRows: number;
  totalQuantity: string | null;
  pendingRows: number;
  restockRows: number;
  unmatchedRows: number;
  dispositions: ReturnDisposition[];
  reversedCogs: string;
  financialStatus: string;
  actualShopeeIncome: string | null;
}

export interface ReturnListFilters {
  shopId?: string;
  status?: string;
  disposition?: ReturnDisposition;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

type SummaryRow = {
  return_id: string;
  shop_id: string;
  shop_name: string;
  order_id: string;
  external_order_sn: string;
  external_return_sn: string;
  status: string | null;
  is_terminal: boolean;
  reason: string | null;
  refund_amount: string | null;
  seller_compensation_amount: string | null;
  currency: string | null;
  created_at_channel: string | null;
  updated_at_channel: string | null;
  item_rows: number;
  total_quantity: string | null;
  pending_rows: number;
  restock_rows: number;
  unmatched_rows: number;
  dispositions: ReturnDisposition[] | null;
  reversed_cogs: string;
  financial_status: string;
  actual_shopee_income: string | null;
};

const toListRow = (r: SummaryRow): ReturnListRow => ({
  returnId: r.return_id,
  shopId: r.shop_id,
  shopName: r.shop_name,
  orderId: r.order_id,
  externalOrderSn: r.external_order_sn,
  externalReturnSn: r.external_return_sn,
  status: r.status,
  isTerminal: r.is_terminal,
  reason: r.reason,
  refundAmount: r.refund_amount,
  sellerCompensationAmount: r.seller_compensation_amount,
  currency: r.currency,
  createdAtChannel: r.created_at_channel,
  updatedAtChannel: r.updated_at_channel,
  itemRows: Number(r.item_rows),
  totalQuantity: r.total_quantity,
  pendingRows: Number(r.pending_rows),
  restockRows: Number(r.restock_rows),
  unmatchedRows: Number(r.unmatched_rows),
  dispositions: r.dispositions ?? [],
  reversedCogs: r.reversed_cogs,
  financialStatus: r.financial_status,
  actualShopeeIncome: r.actual_shopee_income,
});

const VN_OFFSET = "+07:00";

export async function listReturns(db: SupabaseClient, filters: ReturnListFilters, page: number, pageSize: number): Promise<{ rows: ReturnListRow[]; total: number }> {
  const from = (page - 1) * pageSize;
  let q = db.from("v_channel_return_summary").select("*", { count: "exact" }).order("created_at_channel", { ascending: false, nullsFirst: false }).range(from, from + pageSize - 1);
  if (filters.shopId) q = q.eq("shop_id", filters.shopId);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.disposition) q = q.contains("dispositions", [filters.disposition]);
  if (filters.dateFrom) q = q.gte("created_at_channel", `${filters.dateFrom}T00:00:00${VN_OFFSET}`);
  if (filters.dateTo) q = q.lte("created_at_channel", `${filters.dateTo}T23:59:59${VN_OFFSET}`);
  if (filters.search) {
    const term = filters.search.trim().replace(/[,()%*]/g, " ");
    if (term) q = q.or(`external_return_sn.ilike.%${term}%,external_order_sn.ilike.%${term}%`);
  }
  const { data, error, count } = await q;
  if (error) throw new Error(error.message);
  return { rows: ((data ?? []) as SummaryRow[]).map(toListRow), total: count ?? 0 };
}

export interface ReturnItemView {
  id: string;
  externalItemId: string;
  externalModelId: string | null;
  itemName: string | null;
  itemSku: string | null;
  variationSku: string | null;
  quantity: string;
  refundAmount: string | null;
  disposition: ReturnDisposition;
  dispositionChangedAt: string | null;
  /** Original order line (historical mapping + COGS) — null = no matching line. */
  orderLine: {
    id: string;
    quantity: string;
    internalProductId: string | null;
    internalSku: string | null;
    productType: "atomic" | "combo" | null;
    costPerUnitSnapshot: string | null;
    totalCogs: string | null;
    cogsReversedAt: string | null;
    /** combo lines: the historical BOM + component costs used at sale time */
    components: Array<{ componentProductId: string; sku: string; quantityPerCombo: string; costPerUnit: string | null }>;
  } | null;
  /** Active (not reversed) restock episodes. */
  restocks: Array<{ id: string; productId: string; sku: string | null; quantity: string; unitCost: string; totalCost: string; restockedAt: string }>;
  events: Array<{ oldDisposition: string; newDisposition: string; reason: string | null; inventoryEffect: string; cogsDelta: string; changedAt: string; changedByName: string | null }>;
}

export interface ReturnDetailView {
  summary: ReturnListRow;
  textReason: string | null;
  needsLogistics: boolean | null;
  trackingNumber: string | null;
  reverseLogisticsStatus: string | null;
  sellerCompensationStatus: string | null;
  negotiationStatus: string | null;
  returnRefundType: string | null;
  completedAt: string | null;
  lastSyncedAt: string | null;
  items: ReturnItemView[];
  financials: { internalCogs: string | null; reversedCogs: string; netCogs: string | null; actualShopeeIncome: string | null; actualProfit: string | null; refundAmount: string | null; sellerCompensationAmount: string | null } | null;
}

export async function getReturnDetail(db: SupabaseClient, returnId: string): Promise<ReturnDetailView | null> {
  const { data: s, error } = await db.from("v_channel_return_summary").select("*").eq("return_id", returnId).maybeSingle<SummaryRow>();
  if (error) throw new Error(error.message);
  if (!s) return null;
  const { data: r, error: rError } = await db
    .from("channel_returns")
    .select("text_reason, needs_logistics, tracking_number, reverse_logistics_status, seller_compensation_status, negotiation_status, return_refund_type, completed_at, last_synced_at")
    .eq("id", returnId)
    .single();
  if (rError) throw new Error(rError.message);
  const items = await getReturnItems(db, [returnId]);
  const { data: f } = await db
    .from("order_financials")
    .select("internal_cogs::text, reversed_cogs::text, net_cogs::text, actual_shopee_income::text, actual_profit::text, refund_amount::text, seller_compensation_amount::text")
    .eq("order_id", s.order_id)
    .maybeSingle<{ internal_cogs: string | null; reversed_cogs: string; net_cogs: string | null; actual_shopee_income: string | null; actual_profit: string | null; refund_amount: string | null; seller_compensation_amount: string | null }>();
  const rr = r as {
    text_reason: string | null;
    needs_logistics: boolean | null;
    tracking_number: string | null;
    reverse_logistics_status: string | null;
    seller_compensation_status: string | null;
    negotiation_status: string | null;
    return_refund_type: string | null;
    completed_at: string | null;
    last_synced_at: string | null;
  };
  return {
    summary: toListRow(s),
    textReason: rr.text_reason,
    needsLogistics: rr.needs_logistics,
    trackingNumber: rr.tracking_number,
    reverseLogisticsStatus: rr.reverse_logistics_status,
    sellerCompensationStatus: rr.seller_compensation_status,
    negotiationStatus: rr.negotiation_status,
    returnRefundType: rr.return_refund_type,
    completedAt: rr.completed_at,
    lastSyncedAt: rr.last_synced_at,
    items: items.get(returnId) ?? [],
    financials: f
      ? {
          internalCogs: f.internal_cogs,
          reversedCogs: f.reversed_cogs,
          netCogs: f.net_cogs,
          actualShopeeIncome: f.actual_shopee_income,
          actualProfit: f.actual_profit,
          refundAmount: f.refund_amount,
          sellerCompensationAmount: f.seller_compensation_amount,
        }
      : null,
  };
}

/** Items of several returns with their original order line, combo snapshot, restocks and audit (bounded queries). */
export async function getReturnItems(db: SupabaseClient, returnIds: string[]): Promise<Map<string, ReturnItemView[]>> {
  const out = new Map<string, ReturnItemView[]>();
  if (returnIds.length === 0) return out;
  const { data: items, error } = await db
    .from("channel_return_items")
    .select(
      "id, return_id, external_item_id, external_model_id, item_name, item_sku, variation_sku, quantity::text, refund_amount::text, inventory_disposition, disposition_changed_at, channel_order_item_id, " +
        "channel_order_items(id, quantity::text, internal_product_id, cost_per_unit_snapshot::text, total_cogs::text, cogs_reversed_at, products(sku, product_type))",
    )
    .in("return_id", returnIds)
    .order("created_at");
  if (error) throw new Error(error.message);
  type ItemRow = {
    id: string;
    return_id: string;
    external_item_id: string;
    external_model_id: string | null;
    item_name: string | null;
    item_sku: string | null;
    variation_sku: string | null;
    quantity: string;
    refund_amount: string | null;
    inventory_disposition: ReturnDisposition;
    disposition_changed_at: string | null;
    channel_order_item_id: string | null;
    channel_order_items: {
      id: string;
      quantity: string;
      internal_product_id: string | null;
      cost_per_unit_snapshot: string | null;
      total_cogs: string | null;
      cogs_reversed_at: string | null;
      products: { sku: string; product_type: "atomic" | "combo" } | null;
    } | null;
  };
  const rows = (items ?? []) as unknown as ItemRow[];
  const itemIds = rows.map((r) => r.id);
  const lineIds = rows.map((r) => r.channel_order_item_id).filter((x): x is string => !!x);
  const none = ["00000000-0000-0000-0000-000000000000"];
  const [comps, restocks, events] = await Promise.all([
    db
      .from("channel_order_item_cogs_components")
      .select("channel_order_item_id, component_product_id, component_sku_snapshot, component_quantity_per_combo::text, cost_per_unit_snapshot::text")
      .in("channel_order_item_id", lineIds.length ? lineIds : none),
    db
      .from("channel_return_restocks")
      .select("id, return_item_id, product_id, quantity::text, unit_cost::text, total_cost::text, restocked_at, products(sku)")
      .in("return_item_id", itemIds.length ? itemIds : none)
      .is("reversed_at", null),
    db
      .from("channel_return_disposition_events")
      .select("return_item_id, old_disposition, new_disposition, reason, inventory_effect, cogs_delta::text, changed_at, profiles(full_name)")
      .in("return_item_id", itemIds.length ? itemIds : none)
      .order("changed_at", { ascending: false }),
  ]);
  for (const r of [comps, restocks, events]) if (r.error) throw new Error(r.error.message);
  const compsByLine = new Map<string, ReturnItemView["orderLine"] extends infer L ? (L extends { components: infer C } ? C : never) : never>();
  for (const c of (comps.data ?? []) as Array<{ channel_order_item_id: string; component_product_id: string; component_sku_snapshot: string; component_quantity_per_combo: string; cost_per_unit_snapshot: string | null }>) {
    const list = compsByLine.get(c.channel_order_item_id) ?? [];
    list.push({ componentProductId: c.component_product_id, sku: c.component_sku_snapshot, quantityPerCombo: c.component_quantity_per_combo, costPerUnit: c.cost_per_unit_snapshot });
    compsByLine.set(c.channel_order_item_id, list);
  }
  for (const r of rows) {
    const line = r.channel_order_items;
    const view: ReturnItemView = {
      id: r.id,
      externalItemId: r.external_item_id,
      externalModelId: r.external_model_id,
      itemName: r.item_name,
      itemSku: r.item_sku,
      variationSku: r.variation_sku,
      quantity: r.quantity,
      refundAmount: r.refund_amount,
      disposition: r.inventory_disposition,
      dispositionChangedAt: r.disposition_changed_at,
      orderLine: line
        ? {
            id: line.id,
            quantity: line.quantity,
            internalProductId: line.internal_product_id,
            internalSku: line.products?.sku ?? null,
            productType: line.products?.product_type ?? null,
            costPerUnitSnapshot: line.cost_per_unit_snapshot,
            totalCogs: line.total_cogs,
            cogsReversedAt: line.cogs_reversed_at,
            components: compsByLine.get(line.id) ?? [],
          }
        : null,
      restocks: ((restocks.data ?? []) as unknown as Array<{ id: string; return_item_id: string; product_id: string; quantity: string; unit_cost: string; total_cost: string; restocked_at: string; products: { sku: string } | null }>)
        .filter((x) => x.return_item_id === r.id)
        .map((x) => ({ id: x.id, productId: x.product_id, sku: x.products?.sku ?? null, quantity: x.quantity, unitCost: x.unit_cost, totalCost: x.total_cost, restockedAt: x.restocked_at })),
      events: ((events.data ?? []) as unknown as Array<{ return_item_id: string; old_disposition: string; new_disposition: string; reason: string | null; inventory_effect: string; cogs_delta: string; changed_at: string; profiles: { full_name: string | null } | null }>)
        .filter((e) => e.return_item_id === r.id)
        .map((e) => ({ oldDisposition: e.old_disposition, newDisposition: e.new_disposition, reason: e.reason, inventoryEffect: e.inventory_effect, cogsDelta: e.cogs_delta, changedAt: e.changed_at, changedByName: e.profiles?.full_name ?? null })),
    };
    const list = out.get(r.return_id) ?? [];
    list.push(view);
    out.set(r.return_id, list);
  }
  return out;
}

/** Returns of one order (order detail section). */
export async function listOrderReturns(db: SupabaseClient, orderId: string): Promise<ReturnListRow[]> {
  const { data, error } = await db.from("v_channel_return_summary").select("*").eq("order_id", orderId).order("created_at_channel", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as SummaryRow[]).map(toListRow);
}

/** Which of these orders have a (non-cancelled) return — order list indicator, one query. */
export async function getOrdersWithReturns(db: SupabaseClient, orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const { data, error } = await db.from("channel_returns").select("order_id, status").in("order_id", orderIds);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as Array<{ order_id: string; status: string | null }>).filter((r) => r.status !== "CANCELLED").map((r) => r.order_id));
}
