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

export type SaleResult = "calculated" | "calculated_negative" | "no_cost" | "unmapped" | "ineligible" | "already" | "not_found";
export type ReversalResult = "reversed" | "already" | "nothing_posted" | "not_found";

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
  no_cost: "skippedNoCost",
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
    return state;
  }

  async rebuildAll(triggeredBy: string | null = null): Promise<number> {
    const count = await this.rpc<number>("cost_rebuild_all", { p_triggered_by: triggeredBy });
    this.log({ event: "COST_REBUILD", result: `all:${count}` });
    return count;
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
