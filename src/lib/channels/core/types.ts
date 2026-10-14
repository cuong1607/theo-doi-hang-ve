// ============================================================
// PHASE SHOPEE-0: canonical, channel-agnostic domain types.
//
// Mirrors supabase/migrations/00038_shopee_financial_core.sql. Nothing here
// knows Shopee field names — provider payloads are translated into these
// shapes by src/lib/channels/<provider>/mappers.ts.
//
// Pure (no I/O, no "@/" imports): usable from server code, client code and
// `node --test`.
// ============================================================

// ---------- Primitive aliases ----------

/**
 * Exact decimal value as a string ("125000.00"), matching a NUMERIC column.
 * Never a JS number: money/quantity must not go through floating point.
 * Repositories select NUMERIC columns cast to text (`col::text`) so the
 * value arrives exactly as stored. Arithmetic on it is a future-phase
 * concern (decimal library or integer minor units — see
 * docs/shopee-financial-core.md "Money rules").
 */
export type Decimal = string;

/** ISO-8601 timestamp string as returned by PostgREST for timestamptz. */
export type Timestamp = string;

export type Uuid = string;

/** Provider identifiers are kept as text to avoid 64-bit precision loss. */
export type ExternalId = string;

// ---------- Allowed values (must match the DB CHECK constraints) ----------

export const CHANNELS = ["shopee"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CONNECTION_STATUSES = ["disconnected", "connected", "expired", "error", "revoked"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const MAPPING_STATUSES = ["unmapped", "auto_mapped", "manual_mapped", "mapping_conflict"] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

export const FINANCIAL_STATUSES = [
  "pending",
  "estimated",
  "settlement_available",
  "released",
  "mismatch",
  "return_adjusted",
] as const;
export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];

export const COST_METHODS = ["moving_average", "fifo", "manual", "unknown"] as const;
export type CostMethod = (typeof COST_METHODS)[number];

export const INVENTORY_DISPOSITIONS = ["pending", "restock", "damaged", "lost", "disposed"] as const;
export type InventoryDisposition = (typeof INVENTORY_DISPOSITIONS)[number];

export const SYNC_LOG_STATUSES = ["running", "success", "partial", "failed", "cancelled"] as const;
export type SyncLogStatus = (typeof SYNC_LOG_STATUSES)[number];

/** Where channel data came from (shops.data_source, channel_api_snapshots.source_mode). */
export const SOURCE_MODES = ["live", "fixture"] as const;
export type SourceMode = (typeof SOURCE_MODES)[number];

/** Open text in the DB (validated here) so new sync kinds need no migration. */
export const SYNC_TYPES = ["product", "order", "return", "income", "payout"] as const;
export type SyncType = (typeof SYNC_TYPES)[number];

function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);
}

export const isChannel = oneOf(CHANNELS);
export const isConnectionStatus = oneOf(CONNECTION_STATUSES);
export const isMappingStatus = oneOf(MAPPING_STATUSES);
export const isFinancialStatus = oneOf(FINANCIAL_STATUSES);
export const isCostMethod = oneOf(COST_METHODS);
export const isInventoryDisposition = oneOf(INVENTORY_DISPOSITIONS);
export const isSyncLogStatus = oneOf(SYNC_LOG_STATUSES);
export const isSyncType = oneOf(SYNC_TYPES);

// ---------- Entities ----------

export interface Shop {
  id: Uuid;
  channel: Channel;
  externalShopId: ExternalId;
  shopName: string;
  currency: string | null;
  region: string | null;
  isActive: boolean;
  /** "fixture" shops hold test data only and can only be synced from fixtures. */
  dataSource: SourceMode;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * shop_connections WITHOUT the token columns. Tokens never leave the
 * server-only token module (SHOPEE-1); this is the only connection shape
 * the rest of the app may see.
 */
export interface ShopConnectionStatus {
  id: Uuid;
  shopId: Uuid;
  provider: Channel;
  connectionStatus: ConnectionStatus;
  accessTokenExpiresAt: Timestamp | null;
  lastTokenRefreshAt: Timestamp | null;
  lastSuccessfulApiCallAt: Timestamp | null;
  lastErrorAt: Timestamp | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface ChannelProduct {
  id: Uuid;
  shopId: Uuid;
  externalItemId: ExternalId;
  itemName: string;
  itemSku: string | null;
  categoryId: ExternalId | null;
  itemStatus: string | null;
  hasModel: boolean;
  channelOriginalPrice: Decimal | null;
  channelCurrentPrice: Decimal | null;
  availableStock: Decimal | null;
  reservedStock: Decimal | null;
  sourceCreatedAt: Timestamp | null;
  sourceUpdatedAt: Timestamp | null;
  lastSyncedAt: Timestamp | null;
}

export interface ChannelProductModel {
  id: Uuid;
  channelProductId: Uuid;
  externalModelId: ExternalId;
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
  /** Source of truth for "which internal SKU is this" once mapped. */
  internalProductId: Uuid | null;
  mappingStatus: MappingStatus;
  mappedAt: Timestamp | null;
  mappedBy: Uuid | null;
  lastSyncedAt: Timestamp | null;
}

export interface ChannelOrder {
  id: Uuid;
  shopId: Uuid;
  externalOrderSn: ExternalId;
  bookingSn: string | null;
  /** Provider lifecycle (free text, e.g. Shopee "COMPLETED"). */
  orderStatus: string;
  /** Our money lifecycle — independent of orderStatus. */
  financialStatus: FinancialStatus;
  currency: string;
  paymentMethod: string | null;
  cod: boolean | null;
  /** What the buyer paid. NOT the seller's settlement. */
  channelTotalAmount: Decimal | null;
  estimatedShippingFee: Decimal | null;
  reverseShippingFee: Decimal | null;
  createdAtChannel: Timestamp | null;
  paidAtChannel: Timestamp | null;
  pickupDoneAtChannel: Timestamp | null;
  shipByDate: Timestamp | null;
  updatedAtChannel: Timestamp | null;
  lastSyncedAt: Timestamp | null;
}

export interface ChannelOrderItem {
  id: Uuid;
  orderId: Uuid;
  /** Shared by all lines of one bundle deal on Shopee — not a line key. */
  externalOrderItemId: ExternalId | null;
  externalItemId: ExternalId;
  externalModelId: ExternalId | null;
  itemName: string;
  modelName: string | null;
  itemSku: string | null;
  modelSku: string | null;
  internalProductId: Uuid | null;
  quantity: Decimal;
  originalUnitPrice: Decimal | null;
  discountedUnitPrice: Decimal | null;
  promotionType: string | null;
  promotionId: ExternalId | null;
  costMethod: CostMethod | null;
  costPerUnitSnapshot: Decimal | null;
  totalCogs: Decimal | null;
  cogsCalculatedAt: Timestamp | null;
}

export interface ChannelReturn {
  id: Uuid;
  shopId: Uuid;
  orderId: Uuid;
  externalReturnSn: ExternalId;
  status: string | null;
  reason: string | null;
  textReason: string | null;
  refundAmount: Decimal | null;
  currency: string | null;
  needsLogistics: boolean | null;
  trackingNumber: string | null;
  reverseLogisticsStatus: string | null;
  sellerCompensationStatus: string | null;
  sellerCompensationAmount: Decimal | null;
  warehouseArrivalStatus: number | null;
  createdAtChannel: Timestamp | null;
  updatedAtChannel: Timestamp | null;
  items: ChannelReturnItem[];
}

export interface ChannelReturnItem {
  id: Uuid;
  returnId: Uuid;
  externalItemId: ExternalId;
  externalModelId: ExternalId | null;
  internalProductId: Uuid | null;
  itemSku: string | null;
  variationSku: string | null;
  quantity: Decimal;
  refundAmount: Decimal | null;
  inventoryDisposition: InventoryDisposition;
}

export interface PayoutBatch {
  id: Uuid;
  shopId: Uuid;
  fromCurrency: string;
  fromAmount: Decimal;
  payoutCurrency: string;
  payoutAmount: Decimal;
  exchangeRate: Decimal | null;
  payoutTime: Timestamp | null;
  payService: string | null;
  payeeId: string | null;
  orders: PayoutOrder[];
  adjustments: PayoutAdjustment[];
}

export interface PayoutOrder {
  id: Uuid;
  payoutId: Uuid;
  /** Null until the referenced order has been synced and linked. */
  orderId: Uuid | null;
  externalOrderSn: ExternalId;
  escrowAmount: Decimal;
  currency: string;
}

export interface PayoutAdjustment {
  id: Uuid;
  payoutId: Uuid;
  orderId: Uuid | null;
  externalOrderSn: ExternalId | null;
  adjustmentAmount: Decimal;
  module: string | null;
  scenario: string | null;
  remark: string | null;
  adjustmentLevel: string | null;
}

export interface SyncState {
  id: Uuid;
  shopId: Uuid;
  syncType: string;
  lastCursor: string | null;
  lastOffset: number | null;
  lastWindowFrom: Timestamp | null;
  lastWindowTo: Timestamp | null;
  lastSuccessAt: Timestamp | null;
  lastFailureAt: Timestamp | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface SyncLog {
  id: Uuid;
  shopId: Uuid;
  syncType: string;
  startedAt: Timestamp;
  completedAt: Timestamp | null;
  status: SyncLogStatus;
  recordsFetched: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsFailed: number;
  errorCode: string | null;
  errorMessage: string | null;
}
