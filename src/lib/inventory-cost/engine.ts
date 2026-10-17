// ============================================================
// PHASE SHOPEE-4: CostEngine — channel-neutral facade over the PostgreSQL
// cost engine (migration 00043).
//
// The arithmetic (Moving Weighted Average, rounding, replay) lives in SQL,
// inside transactions with row locks, on exact NUMERIC values. This class
// only calls those functions and passes ids / decimal STRINGS — it never
// does money math in JavaScript.
//
// Shopee is just one source of sale events: nothing here is Shopee-specific
// (sale lines are "channel order items").
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Decimal } from "../channels/core/types.ts";
import { consoleCostLogger, type CostLogger } from "./log.ts";

/**
 * cost_pending     posted while VAT-pending purchases are in the position (no COGS yet)
 * calculated_late  a pending sale got its FIRST snapshot once the VAT invoice was linked
 */
export type SaleResult = "calculated" | "calculated_negative" | "calculated_late" | "cost_pending" | "no_cost" | "unmapped" | "ineligible" | "already" | "not_found";
/** withdrawn_pending: a cancelled sale that never had a COGS (VAT pending) — its sale event is removed, nothing reversed. */
export type ReversalResult = "reversed" | "withdrawn_pending" | "already" | "nothing_posted" | "not_found";

/** One costed order line whose snapshot differs from the current ledger reconstruction (dry-run row). */
export interface RestatementCandidate {
  orderItemId: string;
  orderId: string;
  externalOrderSn: string;
  orderStatus: string;
  createdAtChannel: string | null;
  productId: string;
  sku: string | null;
  productName: string | null;
  quantity: Decimal;
  oldCostPerUnit: Decimal;
  /** NULL = the current reconstruction has no cost (VAT pending) → not restatable. */
  newCostPerUnit: Decimal | null;
  oldTotalCogs: Decimal;
  newTotalCogs: Decimal | null;
  difference: Decimal | null;
  oldCostVersion: string | null;
  restatable: boolean;
}

export interface RestatementSummary {
  affectedLines: number;
  affectedOrders: number;
  restatableLines: number;
  pendingLines: number;
  oldTotalCogs: Decimal;
  newTotalCogs: Decimal;
  difference: Decimal;
}

export interface RestatementResult {
  batchId: string | null;
  restated: number;
  skipped: number;
  orders: number;
  oldTotal: Decimal;
  newTotal: Decimal;
}

/** One line of a per-product restatement dry-run, with its order's estimated profit before / after (§41/§43). */
export interface RestatementPreviewLine {
  orderItemId: string;
  orderId: string;
  externalOrderSn: string;
  orderStatus: string;
  createdAtChannel: string | null;
  quantity: Decimal;
  oldCostPerUnit: Decimal;
  newCostPerUnit: Decimal | null;
  oldTotalCogs: Decimal;
  newTotalCogs: Decimal | null;
  difference: Decimal | null;
  restatable: boolean;
  estimatedOrderRevenue: Decimal | null;
  oldOrderInternalCogs: Decimal | null;
  oldOrderEstimatedProfit: Decimal | null;
  /** NULL = unknown (VAT pending line in the order, or no estimate / internal COGS yet). */
  newOrderInternalCogs: Decimal | null;
  newOrderEstimatedProfit: Decimal | null;
}

export interface RestatementPreview {
  productId: string;
  /** Distinct orders with at least one differing line. */
  ordersAffected: number;
  lines: RestatementPreviewLine[];
}

export interface ProductCostState {
  productId: string;
  quantityOnHand: Decimal;
  movingAverageCost: Decimal | null;
  inventoryValue: Decimal;
  lastEventTime: string | null;
  needsRebuild: boolean;
  lastError: string | null;
}

export interface BackfillCogsResult {
  ordersProcessed: number;
  scanned: number;
  calculated: number;
  calculatedNegative: number;
  skippedUnmapped: number;
  skippedNoCost: number;
  skippedIneligible: number;
  alreadyCalculated: number;
  reversed: number;
  failed: number;
  errors: Array<{ orderId: string; message: string }>;
}

const SALE_KEYS: Record<string, keyof BackfillCogsResult> = {
  calculated: "calculated",
  calculated_negative: "calculatedNegative",
  calculated_late: "calculated",
  no_cost: "skippedNoCost",
  cost_pending: "skippedNoCost",
  withdrawn_pending: "reversed",
  unmapped: "skippedUnmapped",
  ineligible: "skippedIneligible",
  already: "alreadyCalculated",
  reversed: "reversed",
  nothing_posted: "skippedIneligible",
};

export class CostEngine {
  private readonly db: SupabaseClient;
  private readonly log: CostLogger;

  constructor(deps: { db: SupabaseClient; logger?: CostLogger }) {
    this.db = deps.db;
    this.log = deps.logger ?? consoleCostLogger;
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }

  /** Purchase from a receipt item (idempotent; receipts also post automatically via DB triggers). */
  async postPurchase(receiptItemId: string): Promise<string> {
    const result = await this.rpc<string>("cost_post_receipt_item", { p_receipt_item_id: receiptItemId });
    this.log({ event: "COST_PURCHASE_POSTED", sourceId: receiptItemId, result });
    return result;
  }

  /** Sale of one channel order item → sale_out + immutable COGS snapshot (idempotent). */
  async postSale(orderItemId: string): Promise<SaleResult> {
    const result = await this.rpc<SaleResult>("cost_apply_order_item", { p_order_item_id: orderItemId });
    if (result === "calculated" || result === "calculated_negative") this.log({ event: "COGS_SALE_POSTED", sourceId: orderItemId, result });
    return result;
  }

  /** Alias kept for the spec's naming: calculating an item's COGS IS posting its sale. */
  calculateOrderItemCogs(orderItemId: string): Promise<SaleResult> {
    return this.postSale(orderItemId);
  }

  /** Cancellation reversal at the item's original snapshot cost (idempotent). */
  async postSaleReversal(orderItemId: string): Promise<ReversalResult> {
    const result = await this.rpc<ReversalResult>("cost_reverse_order_item", { p_order_item_id: orderItemId });
    if (result === "reversed") this.log({ event: "COGS_REVERSAL", sourceId: orderItemId, result });
    return result;
  }

  /** Posts/reverses every line of an order according to its status; refreshes order_financials.internal_cogs. */
  async processOrder(orderId: string): Promise<Record<string, number>> {
    return this.rpc<Record<string, number>>("cost_process_order", { p_order_id: orderId });
  }

  async getCurrentCost(productId: string): Promise<ProductCostState | null> {
    const { data, error } = await this.db
      .from("product_cost_state")
      .select("product_id, quantity_on_hand::text, moving_average_cost::text, inventory_value::text, last_event_time, needs_rebuild, last_error")
      .eq("product_id", productId)
      .maybeSingle<{
        product_id: string;
        quantity_on_hand: string;
        moving_average_cost: string | null;
        inventory_value: string;
        last_event_time: string | null;
        needs_rebuild: boolean;
        last_error: string | null;
      }>();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      productId: data.product_id,
      quantityOnHand: data.quantity_on_hand,
      movingAverageCost: data.moving_average_cost,
      inventoryValue: data.inventory_value,
      lastEventTime: data.last_event_time,
      needsRebuild: data.needs_rebuild,
      lastError: data.last_error,
    };
  }

  /** Re-derives purchases from receipts and replays the product. Never touches order COGS snapshots. */
  async rebuildProduct(productId: string, options: { reason?: string; triggeredBy?: string | null } = {}) {
    const state = await this.rpc<Record<string, unknown>>("cost_rebuild_product", {
      p_product_id: productId,
      p_reason: options.reason ?? "manual_rebuild",
      p_triggered_by: options.triggeredBy ?? null,
    });
    this.log({ event: "COST_REBUILD", productId, result: "ok" });
    // §47: how the purchases of this product were costed (raw / invoice_vat / vat_pending).
    const { data: bases } = await this.db.from("inventory_cost_ledger").select("cost_basis").eq("product_id", productId).eq("event_type", "purchase_in");
    const counts: Record<string, number> = {};
    for (const b of (bases ?? []) as Array<{ cost_basis: string | null }>) counts[b.cost_basis ?? "none"] = (counts[b.cost_basis ?? "none"] ?? 0) + 1;
    if (counts.invoice_vat || counts.provisional_vat || counts.vat_pending) {
      this.log({ event: "purchase_cost_adjusted_vat", productId, result: Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") });
    }
    return state;
  }

  async rebuildAll(triggeredBy: string | null = null): Promise<number> {
    const count = await this.rpc<number>("cost_rebuild_all", { p_triggered_by: triggeredBy });
    this.log({ event: "COST_REBUILD", result: `all:${count}` });
    return count;
  }

  // ---------------------------------------------------------- restatement
  // Historical COGS snapshots never change by themselves (rebuild included).
  // Restating is an explicit admin step: dry-run → review → apply with a
  // reason; every restated line keeps old/new values + version in
  // cogs_restatements.

  /** Dry-run: lines whose locked COGS differs from the current reconstruction. */
  async restatementCandidates(limit = 500): Promise<RestatementCandidate[]> {
    type Row = {
      order_item_id: string;
      order_id: string;
      external_order_sn: string;
      order_status: string;
      created_at_channel: string | null;
      product_id: string;
      sku: string | null;
      product_name: string | null;
      quantity: string;
      old_cost_per_unit: string;
      new_cost_per_unit: string | null;
      old_total_cogs: string;
      new_total_cogs: string | null;
      difference: string | null;
      old_cost_version: string | null;
      restatable: boolean;
    };
    const rows = await this.rpc<Row[]>("cost_restatement_candidates", { p_limit: limit });
    return (rows ?? []).map((r) => ({
      orderItemId: r.order_item_id,
      orderId: r.order_id,
      externalOrderSn: r.external_order_sn,
      orderStatus: r.order_status,
      createdAtChannel: r.created_at_channel,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      quantity: r.quantity,
      oldCostPerUnit: r.old_cost_per_unit,
      newCostPerUnit: r.new_cost_per_unit,
      oldTotalCogs: r.old_total_cogs,
      newTotalCogs: r.new_total_cogs,
      difference: r.difference,
      oldCostVersion: r.old_cost_version,
      restatable: r.restatable,
    }));
  }

  /**
   * Dry-run for ONE product (migration 00053): which historical lines would
   * change if restated to the current (VAT-adjusted) reconstruction, and the
   * old vs new estimated profit of their orders. Never writes.
   */
  async previewHistoricalCogsRestatement(productId: string): Promise<RestatementPreview> {
    type Row = {
      order_item_id: string;
      order_id: string;
      external_order_sn: string;
      order_status: string;
      created_at_channel: string | null;
      quantity: string;
      old_cost_per_unit: string;
      new_cost_per_unit: string | null;
      old_total_cogs: string;
      new_total_cogs: string | null;
      difference: string | null;
      restatable: boolean;
      estimated_order_revenue: string | null;
      order_internal_cogs: string | null;
      order_estimated_profit: string | null;
      new_order_internal_cogs: string | null;
      new_order_estimated_profit: string | null;
    };
    const rows = (await this.rpc<Row[]>("cost_restatement_preview_product", { p_product_id: productId })) ?? [];
    const lines = rows.map((r) => ({
      orderItemId: r.order_item_id,
      orderId: r.order_id,
      externalOrderSn: r.external_order_sn,
      orderStatus: r.order_status,
      createdAtChannel: r.created_at_channel,
      quantity: r.quantity,
      oldCostPerUnit: r.old_cost_per_unit,
      newCostPerUnit: r.new_cost_per_unit,
      oldTotalCogs: r.old_total_cogs,
      newTotalCogs: r.new_total_cogs,
      difference: r.difference,
      restatable: r.restatable,
      estimatedOrderRevenue: r.estimated_order_revenue,
      oldOrderInternalCogs: r.order_internal_cogs,
      oldOrderEstimatedProfit: r.order_estimated_profit,
      newOrderInternalCogs: r.new_order_internal_cogs,
      newOrderEstimatedProfit: r.new_order_estimated_profit,
    }));
    const ordersAffected = new Set(lines.map((l) => l.orderId)).size;
    this.log({ event: "cost_rebuild_preview", productId, result: `lines=${lines.length} orders=${ordersAffected} pending=${lines.filter((l) => !l.restatable).length}` });
    return { productId, ordersAffected, lines };
  }

  async restatementSummary(): Promise<RestatementSummary> {
    const rows = await this.rpc<
      Array<{ affected_lines: number | string; affected_orders: number | string; restatable_lines: number | string; pending_lines: number | string; old_total_cogs: string; new_total_cogs: string; difference: string }>
    >("cost_restatement_summary", {});
    const r = rows[0];
    return {
      affectedLines: Number(r.affected_lines),
      affectedOrders: Number(r.affected_orders),
      restatableLines: Number(r.restatable_lines),
      pendingLines: Number(r.pending_lines),
      oldTotalCogs: r.old_total_cogs,
      newTotalCogs: r.new_total_cogs,
      difference: r.difference,
    };
  }

  /** Apply: restates the given lines (re-validated in SQL) and refreshes their orders' internal COGS / profit. */
  async restateOrderCogs(orderItemIds: string[], reason: string, adjustedBy: string | null = null): Promise<RestatementResult> {
    const r = await this.rpc<{ batch_id: string | null; restated: number; skipped: number; orders: number; old_total: string; new_total: string }>("cost_restate_order_cogs", {
      p_item_ids: orderItemIds,
      p_reason: reason,
      p_by: adjustedBy,
    });
    this.log({ event: "COGS_RESTATED", result: `restated=${r.restated} skipped=${r.skipped}` });
    return { batchId: r.batch_id, restated: r.restated, skipped: r.skipped, orders: r.orders, oldTotal: r.old_total, newTotal: r.new_total };
  }

  /**
   * COGS for orders that are missing it (default onlyMissing). Existing
   * snapshots are never overwritten — the SQL functions refuse to.
   */
  async backfillOrderCogs(options: { shopId?: string; orderIds?: string[]; onlyMissing?: boolean } = {}): Promise<BackfillCogsResult> {
    const onlyMissing = options.onlyMissing ?? true;
    let orderIds = options.orderIds ?? null;
    if (!orderIds) {
      let query = this.db.from("v_channel_order_summary").select("order_id").order("order_id");
      if (options.shopId) query = query.eq("shop_id", options.shopId);
      if (onlyMissing) query = query.neq("cogs_readiness", "complete");
      const ids: string[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await query.range(from, from + 999);
        if (error) throw new Error(error.message);
        ids.push(...(data ?? []).map((r: { order_id: string }) => r.order_id));
        if (!data || data.length < 1000) break;
      }
      orderIds = ids;
    }
    const result: BackfillCogsResult = {
      ordersProcessed: 0,
      scanned: 0,
      calculated: 0,
      calculatedNegative: 0,
      skippedUnmapped: 0,
      skippedNoCost: 0,
      skippedIneligible: 0,
      alreadyCalculated: 0,
      reversed: 0,
      failed: 0,
      errors: [],
    };
    for (const orderId of orderIds) {
      try {
        const counts = await this.processOrder(orderId);
        result.ordersProcessed++;
        for (const [key, n] of Object.entries(counts)) {
          result.scanned += n;
          const target = SALE_KEYS[key];
          if (target && typeof result[target] === "number") (result[target] as number) += n;
        }
      } catch (err) {
        result.failed++;
        result.errors.push({ orderId, message: (err as Error).message.slice(0, 300) });
      }
    }
    this.log({ event: "COGS_BACKFILL", result: `orders=${result.ordersProcessed} calculated=${result.calculated + result.calculatedNegative} failed=${result.failed}` });
    return result;
  }
}
