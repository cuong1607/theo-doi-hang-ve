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
  Decimal,
  ExternalId,
  Timestamp,
  PayoutAdjustment,
  PayoutBatch,
  PayoutOrder,
} from "./types.ts";
import type { FinancialComponentInput, OrderFinancialsInput } from "../../financial/types.ts";

// ---------- SHOPEE-2: catalog ----------

/** Reserved external_model_id of the internal sellable unit of a variation-less item. */
export const SYNTHETIC_MODEL_ID = "NO_MODEL";

/** A provider listing (item) — provider fields only, never mapping/internal fields. */
export interface MappedChannelProduct {
  externalItemId: ExternalId;
  itemName: string;
  itemSku: string | null;
  categoryId: ExternalId | null;
  itemStatus: string | null;
  hasModel: boolean;
  isKit: boolean | null;
  channelOriginalPrice: Decimal | null;
  channelCurrentPrice: Decimal | null;
  availableStock: Decimal | null;
  reservedStock: Decimal | null;
  sourceCreatedAt: Timestamp | null;
  sourceUpdatedAt: Timestamp | null;
}

/** A sellable unit of a listing: a real provider variation, or the synthetic NO_MODEL unit. */
export interface MappedChannelModel {
  externalModelId: ExternalId;
  isSynthetic: boolean;
  modelName: string | null;
  modelSku: string | null;
  modelStatus: string | null;
  channelOriginalPrice: Decimal | null;
  channelCurrentPrice: Decimal | null;
  availableStock: Decimal | null;
  reservedStock: Decimal | null;
  weight: Decimal | null;
  packageLength: Decimal | null;
  packageWidth: Decimal | null;
  packageHeight: Decimal | null;
}

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
