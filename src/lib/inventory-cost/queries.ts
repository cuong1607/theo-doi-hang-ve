// ============================================================
// PHASE SHOPEE-4: read queries for the cost engine (server-only,
// service-role — callers authorize first with cost:view).
// NUMERIC values stay strings; NULL = unknown (never shown as 0).
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";

import type { CostEventType, CostLedgerEntry, PurchaseCostBasis } from "./types.ts";
import type { ProductCostState } from "./engine.ts";

export interface ProductCostOverviewRow {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  isActive: boolean;
  quantityOnHand: string | null;
  movingAverageCost: string | null;
  inventoryValue: string | null;
  lastEventTime: string | null;
  needsRebuild: boolean;
  lastError: string | null;
  hasHistory: boolean;
  negativeQuantity: boolean;
  missingCost: boolean;
  /** The current position holds purchases waiting for their VAT invoice (average unknown). */
  vatPending: boolean;
}

export type CostWarningFilter = "negative" | "missing_cost" | "no_history" | "needs_rebuild" | "vat_pending";

type OverviewRow = {
  product_id: string;
  sku: string;
  name: string;
  unit: string;
  is_active: boolean;
  quantity_on_hand: string | null;
  moving_average_cost: string | null;
  inventory_value: string | null;
  last_event_time: string | null;
  needs_rebuild: boolean;
  last_error: string | null;
  has_history: boolean;
  negative_quantity: boolean;
  missing_cost: boolean;
  vat_pending: boolean;
};

const toOverview = (r: OverviewRow): ProductCostOverviewRow => ({
  productId: r.product_id,
  sku: r.sku,
  name: r.name,
  unit: r.unit,
  isActive: r.is_active,
  quantityOnHand: r.quantity_on_hand,
  movingAverageCost: r.moving_average_cost,
  inventoryValue: r.inventory_value,
  lastEventTime: r.last_event_time,
  needsRebuild: r.needs_rebuild,
  lastError: r.last_error,
  hasHistory: r.has_history,
  negativeQuantity: r.negative_quantity,
  missingCost: r.missing_cost,
  vatPending: r.vat_pending,
});

export async function getProductCostOverview(filters: { search?: string; warning?: CostWarningFilter }, page: number, pageSize: number) {
  const from = (page - 1) * pageSize;
  let query = createAdminClient().from("v_product_cost_overview").select("*", { count: "exact" }).order("sku").range(from, from + pageSize - 1);
  if (filters.search) {
    const like = `%${escapeIlikeTerm(filters.search).replace(/[,()]/g, " ")}%`;
    query = query.or(`sku.ilike.${like},name.ilike.${like}`);
  }
  if (filters.warning === "negative") query = query.eq("negative_quantity", true);
  if (filters.warning === "missing_cost") query = query.eq("missing_cost", true);
  if (filters.warning === "no_history") query = query.eq("has_history", false);
  if (filters.warning === "needs_rebuild") query = query.eq("needs_rebuild", true);
  if (filters.warning === "vat_pending") query = query.eq("vat_pending", true);
  const { data, error, count } = await query.returns<OverviewRow[]>();
  if (error) throw new Error(error.message);
  return { rows: (data ?? []).map(toOverview), total: count ?? 0 };
}

export async function getProductCostState(productId: string): Promise<(ProductCostOverviewRow & { supplierName: string | null }) | null> {
  const db = createAdminClient();
  const [{ data, error }, { data: product }] = await Promise.all([
    db.from("v_product_cost_overview").select("*").eq("product_id", productId).maybeSingle<OverviewRow>(),
    db.from("products").select("suppliers(name)").eq("id", productId).maybeSingle<{ suppliers: { name: string } | null }>(),
  ]);
  if (error) throw new Error(error.message);
  return data ? { ...toOverview(data), supplierName: product?.suppliers?.name ?? null } : null;
}

export async function getCurrentMovingAverageCost(productId: string): Promise<string | null> {
  const { data } = await createAdminClient().from("product_cost_state").select("moving_average_cost::text").eq("product_id", productId).maybeSingle<{ moving_average_cost: string | null }>();
  return data?.moving_average_cost ?? null;
}

export async function getProductCostLedger(productId: string, filters: { eventType?: CostEventType } = {}, page = 1, pageSize = 100) {
  const from = (page - 1) * pageSize;
  let query = createAdminClient()
    .from("inventory_cost_ledger")
    .select(
      "id, product_id, event_type, source_type, source_id, source_external_id, event_time, quantity_change::text, unit_cost::text, " +
        "movement_cost::text, qty_before::text, qty_after::text, avg_cost_before::text, avg_cost_after::text, note, metadata, " +
        "base_unit_cost::text, vat_rate::text, cost_basis, invoice_id",
      { count: "exact" },
    )
    .eq("product_id", productId)
    .order("event_time", { ascending: false })
    .order("order_key", { ascending: false })
    .range(from, from + pageSize - 1);
  if (filters.eventType) query = query.eq("event_type", filters.eventType);
  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  type Row = {
    id: string;
    product_id: string;
    event_type: CostEventType;
    source_type: string;
    source_id: string | null;
    source_external_id: string | null;
    event_time: string;
    quantity_change: string;
    unit_cost: string | null;
    movement_cost: string | null;
    qty_before: string;
    qty_after: string;
    avg_cost_before: string | null;
    avg_cost_after: string | null;
    note: string | null;
    metadata: { negative_inventory?: boolean; cost_pending?: boolean } | null;
    base_unit_cost: string | null;
    vat_rate: string | null;
    cost_basis: PurchaseCostBasis | null;
    invoice_id: string | null;
  };
  const rows: CostLedgerEntry[] = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    productId: r.product_id,
    eventType: r.event_type,
    sourceType: r.source_type,
    sourceId: r.source_id,
    sourceExternalId: r.source_external_id,
    eventTime: r.event_time,
    quantityChange: r.quantity_change,
    unitCost: r.unit_cost,
    movementCost: r.movement_cost,
    qtyBefore: r.qty_before,
    qtyAfter: r.qty_after,
    avgCostBefore: r.avg_cost_before,
    avgCostAfter: r.avg_cost_after,
    note: r.note,
    negativeInventory: r.metadata?.negative_inventory === true,
    baseUnitCost: r.base_unit_cost,
    vatRate: r.vat_rate,
    costBasis: r.cost_basis,
    invoiceId: r.invoice_id,
    costPending: r.metadata?.cost_pending === true,
  }));
  return { rows, total: count ?? 0 };
}

/** Links for ledger sources (receipt / channel order) — one query each, no N+1. */
export async function getLedgerSourceLinks(entries: CostLedgerEntry[]): Promise<Map<string, string>> {
  const db = createAdminClient();
  const links = new Map<string, string>();
  const receiptItemIds = entries.filter((e) => e.sourceType === "receipt_item" && e.sourceId).map((e) => e.sourceId!);
  const orderItemIds = entries.filter((e) => e.sourceType === "channel_order_item" && e.sourceId).map((e) => e.sourceId!);
  const [receipts, orders] = await Promise.all([
    receiptItemIds.length ? db.from("receipt_items").select("id, receipt_id").in("id", receiptItemIds) : Promise.resolve({ data: [] }),
    orderItemIds.length ? db.from("channel_order_items").select("id, order_id").in("id", orderItemIds) : Promise.resolve({ data: [] }),
  ]);
  for (const r of (receipts.data ?? []) as Array<{ id: string; receipt_id: string }>) links.set(r.id, `/receipts/${r.receipt_id}`);
  for (const o of (orders.data ?? []) as Array<{ id: string; order_id: string }>) links.set(o.id, `/shopee/orders/${o.order_id}`);
  return links;
}

export async function getOrderCogsReadiness(orderId: string) {
  const { data, error } = await createAdminClient()
    .from("v_channel_order_summary")
    .select("cogs_readiness, costed_lines, line_count, total_cogs, partial_cogs_sum")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function getOrdersMissingCogs(options: { shopId?: string; limit?: number } = {}) {
  let query = createAdminClient()
    .from("v_channel_order_summary")
    .select("order_id, external_order_sn, order_status, cogs_readiness, costed_lines, line_count")
    .neq("cogs_readiness", "complete")
    .order("created_at_channel", { ascending: false })
    .limit(options.limit ?? 200);
  if (options.shopId) query = query.eq("shop_id", options.shopId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getNegativeInventoryProducts(): Promise<ProductCostOverviewRow[]> {
  const { data, error } = await createAdminClient().from("v_product_cost_overview").select("*").eq("negative_quantity", true).order("sku").returns<OverviewRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toOverview);
}

export type { ProductCostState };
