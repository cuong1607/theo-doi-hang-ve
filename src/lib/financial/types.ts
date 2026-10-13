// ============================================================
// PHASE SHOPEE-0: canonical financial types (channel-agnostic).
//
// The Financial Engine only ever sees these shapes — never a Shopee field
// name. Provider mappers (src/lib/channels/<provider>/mappers.ts) translate
// escrow/income/payout payloads into FinancialComponentInput[] and
// OrderFinancialsInput.
//
// Sign convention: every input amount is a POSITIVE magnitude of what its
// name says (a 5,000 fee is "5000", not "-5000"); only adjustments and the
// computed profit/variance outputs are signed.
// ============================================================
import type { Decimal, Timestamp, Uuid } from "../channels/core/types.ts";

export const FINANCIAL_COMPONENT_CATEGORIES = [
  "sales",
  "seller_discount",
  "platform_support",
  "platform_fee",
  "shipping",
  "tax",
  "refund",
  "compensation",
  "adjustment",
  "settlement",
  "other",
] as const;
export type FinancialComponentCategory = (typeof FINANCIAL_COMPONENT_CATEGORIES)[number];

export const FUNDED_BY = ["seller", "platform", "buyer", "third_party", "unknown"] as const;
export type FundedBy = (typeof FUNDED_BY)[number];

/** Open text in the DB; the known sources today. */
export const FINANCIAL_SOURCES = ["shopee_order", "shopee_escrow", "shopee_income", "shopee_payout", "manual"] as const;
export type FinancialSource = (typeof FINANCIAL_SOURCES)[number];

export const RECONCILIATION_STATUSES = ["matched", "warning", "mismatch"] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** One money line of an order (order_financial_components row). */
export interface FinancialComponent {
  id: Uuid;
  orderId: Uuid;
  componentType: string;
  providerField: string | null;
  category: FinancialComponentCategory;
  /** Signed from the seller's point of view: + inflow, - outflow. */
  amount: Decimal;
  currency: string | null;
  fundedBy: FundedBy | null;
  source: string;
  sourceSyncedAt: Timestamp | null;
  metadata: Record<string, unknown> | null;
}

export type FinancialComponentInput = Omit<FinancialComponent, "id" | "orderId">;

// ---------- Engine input (canonical) ----------

export interface SalesInput {
  grossOriginalValue: Decimal | null;
  grossSellingValue: Decimal | null;
}

export interface DiscountsInput {
  sellerDiscount: Decimal | null;
  sellerVoucher: Decimal | null;
  platformDiscount: Decimal | null;
  platformVoucher: Decimal | null;
  otherPlatformSupport: Decimal | null;
}

export interface FeesInput {
  commissionFee: Decimal | null;
  serviceFee: Decimal | null;
  transactionFee: Decimal | null;
  processingFee: Decimal | null;
  campaignFee: Decimal | null;
  affiliateFee: Decimal | null;
  otherPlatformFee: Decimal | null;
}

export interface ShippingInput {
  buyerPaidShipping: Decimal | null;
  actualShippingFee: Decimal | null;
  shippingRebate: Decimal | null;
  shippingDiscount: Decimal | null;
  reverseShippingFee: Decimal | null;
  returnShippingFee: Decimal | null;
}

export interface TaxesInput {
  escrowTax: Decimal | null;
  withholdingVatTax: Decimal | null;
  withholdingPitTax: Decimal | null;
  withholdingCitTax: Decimal | null;
  otherTax: Decimal | null;
}

export interface ReturnsInput {
  refundAmount: Decimal | null;
  sellerCompensationAmount: Decimal | null;
}

export interface AdjustmentsInput {
  /** Signed. */
  totalAdjustmentAmount: Decimal | null;
}

export interface SettlementInput {
  /** Platform-reported amount for the order (escrow). */
  escrowAmount: Decimal | null;
  escrowAmountAfterAdjustment: Decimal | null;
  /** Actually paid out; null until released. */
  releasedAmount: Decimal | null;
  releasedAt: Timestamp | null;
}

export interface InternalCostsInput {
  /** From the Internal Cost Engine — never the channel price, never products.current_price. */
  internalCogs: Decimal | null;
  giftCost: Decimal | null;
  packagingCost: Decimal | null;
  adsCost: Decimal | null;
  otherVariableCost: Decimal | null;
}

export interface OrderFinancialsInput {
  sales: SalesInput;
  discounts: DiscountsInput;
  fees: FeesInput;
  shipping: ShippingInput;
  taxes: TaxesInput;
  returns: ReturnsInput;
  adjustments: AdjustmentsInput;
  settlement: SettlementInput;
  internalCosts: InternalCostsInput;
}

// ---------- Engine output ----------

export interface OrderFinancialsResult {
  /** Before settlement is known (from order + estimated fees). */
  estimatedProfit: Decimal | null;
  /** After settlement/release is known. */
  actualProfit: Decimal | null;
  profitAfterCogs: Decimal | null;
  contributionProfit: Decimal | null;
  margin: Decimal | null;
  /** escrow reported by the platform minus what we calculated. */
  settlementVariance: Decimal | null;
  calculationVersion: string;
}

/** order_financials row (canonical P&L snapshot, one per order). */
export interface OrderFinancial extends OrderFinancialsInput {
  id: Uuid;
  orderId: Uuid;
  estimatedProfit: Decimal | null;
  actualProfit: Decimal | null;
  profitAfterCogs: Decimal | null;
  contributionProfit: Decimal | null;
  estimatedMargin: Decimal | null;
  actualMargin: Decimal | null;
  profitVariance: Decimal | null;
  calculatedSettlement: Decimal | null;
  settlementVariance: Decimal | null;
  reconciliationStatus: ReconciliationStatus | null;
  calculationVersion: string | null;
  calculatedAt: Timestamp | null;
}
