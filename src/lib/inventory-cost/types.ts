// ============================================================
// Internal Cost Engine — shared types (SHOPEE-0 boundary, implemented in
// SHOPEE-4 by ./engine.ts + migration 00043).
//
// COGS of a sale line = moving weighted average cost of the internal product
// at the costing moment, derived from OUR receipts — never the channel
// selling price, never products.current_price.
// ============================================================
import type { CostMethod, Decimal, Timestamp, Uuid } from "../channels/core/types.ts";

export const COST_EVENT_TYPES = [
  "opening_balance",
  "purchase_in",
  "sale_out",
  "sale_reversal_in",
  "return_in",
  "adjustment_in",
  "adjustment_out",
] as const;
export type CostEventType = (typeof COST_EVENT_TYPES)[number];

export const COST_EVENT_LABELS: Record<CostEventType, string> = {
  opening_balance: "Tồn đầu kỳ",
  purchase_in: "Nhập hàng",
  sale_out: "Bán",
  sale_reversal_in: "Hoàn kho (huỷ đơn)",
  return_in: "Hàng trả về",
  adjustment_in: "Điều chỉnh tăng",
  adjustment_out: "Điều chỉnh giảm",
};

export interface CostLedgerEntry {
  id: Uuid;
  productId: Uuid;
  eventType: CostEventType;
  sourceType: string;
  sourceId: Uuid | null;
  sourceExternalId: string | null;
  eventTime: Timestamp;
  quantityChange: Decimal;
  unitCost: Decimal | null;
  movementCost: Decimal | null;
  qtyBefore: Decimal;
  qtyAfter: Decimal;
  avgCostBefore: Decimal | null;
  avgCostAfter: Decimal | null;
  note: string | null;
  negativeInventory: boolean;
}

export interface UnitCostResult {
  costMethod: CostMethod;
  costPerUnit: Decimal;
  totalCost: Decimal;
}
