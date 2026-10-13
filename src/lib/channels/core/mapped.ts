// ============================================================
// PHASE SHOPEE-0: what a provider mapper hands to the sync/persistence
// layer — canonical rows WITHOUT database-owned fields (id, shop_id,
// financial_status, mapping, COGS, timestamps we set ourselves).
//
// Every provider (Shopee today) maps into exactly these shapes; the sync
// layer (SHOPEE-1+) scopes them to a shop and upserts them.
// ============================================================
import type {
  ChannelOrder,
  ChannelOrderItem,
  ChannelReturn,
  ChannelReturnItem,
  ExternalId,
  PayoutAdjustment,
  PayoutBatch,
  PayoutOrder,
} from "./types.ts";
import type { FinancialComponentInput, OrderFinancialsInput } from "../../financial/types.ts";

export type MappedOrderItem = Omit<
  ChannelOrderItem,
  "id" | "orderId" | "internalProductId" | "costMethod" | "costPerUnitSnapshot" | "totalCogs" | "cogsCalculatedAt"
>;

export type MappedOrder = Omit<ChannelOrder, "id" | "shopId" | "financialStatus" | "lastSyncedAt"> & {
  items: MappedOrderItem[];
};

/** Escrow/income detail of ONE order, already in canonical buckets. */
export interface MappedOrderFinancials {
  externalOrderSn: ExternalId;
  financials: OrderFinancialsInput;
  components: FinancialComponentInput[];
}

export type MappedReturnItem = Omit<ChannelReturnItem, "id" | "returnId" | "internalProductId" | "inventoryDisposition">;

export type MappedReturn = Omit<ChannelReturn, "id" | "shopId" | "orderId" | "items"> & {
  /** Resolved to channel_orders.id (same shop) by the sync layer. */
  externalOrderSn: ExternalId;
  items: MappedReturnItem[];
};

export type MappedPayout = Omit<PayoutBatch, "id" | "shopId" | "orders" | "adjustments"> & {
  orders: Omit<PayoutOrder, "id" | "payoutId" | "orderId">[];
  adjustments: Omit<PayoutAdjustment, "id" | "payoutId" | "orderId">[];
};
