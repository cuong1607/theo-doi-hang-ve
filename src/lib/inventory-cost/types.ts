// ============================================================
// PHASE SHOPEE-0: Internal Cost Engine — boundary only.
//
// The future source of COGS for channel order lines: unit cost derived from
// OUR purchase history (receipts/invoices), as of the order date. Never the
// channel selling price, never products.current_price (that is today's
// price, not a historical cost). Not implemented in SHOPEE-0.
// ============================================================
import type { CostMethod, Decimal, Timestamp, Uuid } from "../channels/core/types.ts";

export interface UnitCostQuery {
  internalProductId: Uuid;
  quantity: Decimal;
  /** Cost is resolved as of this moment (order creation/pickup time). */
  asOf: Timestamp;
}

export interface UnitCostResult {
  costMethod: CostMethod;
  /** Frozen into channel_order_items.cost_per_unit_snapshot. */
  costPerUnit: Decimal;
  totalCost: Decimal;
}

export interface CostResolver {
  resolveUnitCost(query: UnitCostQuery): Promise<UnitCostResult | null>;
}
