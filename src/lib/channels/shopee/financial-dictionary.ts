// ============================================================
// PHASE SHOPEE-5: Shopee escrow → canonical financial dictionary.
//
// The ONLY place that knows what a Shopee get_escrow_detail money field
// means. Nothing else in the code base may interpret a Shopee fee name.
//
// Per field:
//   column      order_financials column it fills (POSITIVE magnitude, except
//               signed columns), or none (component only)
//   type        canonical component_type
//   category    canonical bucket (order_financial_components.category)
//   impact      how the provider value affects the SELLER's income:
//                 inflow   positive value adds to seller income   → +v
//                 outflow  positive value is deducted              → −|v|
//                 signed   provider value is already signed by seller impact
//                 info     shown / audited, NOT a seller money flow (e.g. what
//                          the buyer paid, platform-funded discounts, results)
//   fundedBy    who bears it
//   settlement  part of the escrow formula used for calculated_settlement
//   verified    meaning confirmed on REAL Vietnam payloads
//               (docs/shopee-financial-validation.md). A component is
//               included in calculated_settlement only if settlement AND
//               verified — uncertain fields are stored, never summed.
//
// Final income is NEVER rebuilt from these components: it is
// escrow_amount_after_adjustment ?? escrow_amount (Shopee's own number).
// calculated_settlement only cross-checks that number.
//
// Double counting (VN): net_commission_fee / net_service_fee are market
// specific (BR) re-statements of commission_fee / service_fee → info, never
// in the formula. total_adjustment_amount is the sum of order_adjustment[] →
// info; the individual adjustment rows are the formula members.
// Shopee's cost_of_goods_sold / original_cost_of_goods_sold are Shopee
// settlement naming — NOT internal COGS (which only the cost engine owns).
// ============================================================
import type { FinancialComponentCategory, FundedBy } from "../../financial/types.ts";

export type SellerImpact = "inflow" | "outflow" | "signed" | "info";

/** order_financials columns the escrow sync owns (internal_cogs is NOT one of them). */
export const ESCROW_COLUMNS = [
  "gross_original_value",
  "gross_selling_value",
  "seller_discount",
  "seller_voucher",
  "shopee_discount",
  "shopee_voucher",
  "other_platform_support",
  "commission_fee",
  "service_fee",
  "transaction_fee",
  "processing_fee",
  "campaign_fee",
  "affiliate_fee",
  "other_platform_fee",
  "buyer_paid_shipping",
  "actual_shipping_fee",
  "shipping_rebate",
  "shipping_discount",
  "reverse_shipping_fee",
  "return_shipping_fee",
  "escrow_tax",
  "withholding_vat_tax",
  "withholding_pit_tax",
  "withholding_cit_tax",
  "other_tax",
  "refund_amount",
  "seller_compensation_amount",
  "total_adjustment_amount",
  "escrow_amount",
  "escrow_amount_after_adjustment",
] as const;
export type EscrowColumn = (typeof ESCROW_COLUMNS)[number];

/**
 * Columns that hold a signed value instead of a magnitude. The settlement
 * itself is signed: a returned order can settle NEGATIVE (seller owes, e.g.
 * escrow_amount −2700 = protection fee on a fully returned order).
 */
export const SIGNED_COLUMNS: ReadonlySet<EscrowColumn> = new Set(["total_adjustment_amount", "escrow_amount", "escrow_amount_after_adjustment"]);

export interface EscrowFieldDefinition {
  column?: EscrowColumn;
  type: string;
  category: FinancialComponentCategory;
  impact: SellerImpact;
  fundedBy: FundedBy;
  settlement: boolean;
  verified: boolean;
  notes: string;
}

/** order_income.<field> → definition. Fields not listed here and not in IGNORED become "unknown" components. */
export const ESCROW_FIELDS: Readonly<Record<string, EscrowFieldDefinition>> = {
  // ---- settlement results (the numbers we reconcile against)
  escrow_amount: { column: "escrow_amount", type: "escrow_amount", category: "settlement", impact: "info", fundedBy: "platform", settlement: false, verified: true, notes: "Shopee's settlement for the order before adjustments. Final income fallback." },
  escrow_amount_after_adjustment: { column: "escrow_amount_after_adjustment", type: "escrow_amount_after_adjustment", category: "settlement", impact: "info", fundedBy: "platform", settlement: false, verified: true, notes: "Final settlement incl. adjustments — primary final income when present." },
  buyer_total_amount: { type: "buyer_total_amount", category: "sales", impact: "info", fundedBy: "buyer", settlement: false, verified: true, notes: "What the buyer paid. Never seller income." },

  // ---- sales
  original_price: { column: "gross_original_value", type: "original_price", category: "sales", impact: "inflow", fundedBy: "buyer", settlement: true, verified: true, notes: "Formula base. Merchandise value before seller discounts, AFTER returns (fully returned order → 0)." },
  order_original_price: { type: "order_original_price", category: "sales", impact: "info", fundedBy: "buyer", settlement: false, verified: true, notes: "Same as original_price but BEFORE returns — never added to it." },
  order_seller_discount: { type: "order_seller_discount", category: "seller_discount", impact: "info", fundedBy: "seller", settlement: false, verified: true, notes: "seller_discount BEFORE returns — never added to it." },
  order_selling_price: { column: "gross_selling_value", type: "order_selling_price", category: "sales", impact: "info", fundedBy: "buyer", settlement: false, verified: true, notes: "Merchandise value after item-level promotion, if provided." },
  order_discounted_price: { type: "order_discounted_price", category: "sales", impact: "info", fundedBy: "buyer", settlement: false, verified: true, notes: "Merchandise value after all discounts, if provided." },

  // ---- seller-funded discounts
  seller_discount: { column: "seller_discount", type: "seller_discount", category: "seller_discount", impact: "outflow", fundedBy: "seller", settlement: true, verified: true, notes: "Discount funded by the seller." },
  voucher_from_seller: { column: "seller_voucher", type: "seller_voucher", category: "seller_discount", impact: "outflow", fundedBy: "seller", settlement: true, verified: false, notes: "Seller voucher." },
  seller_coin_cash_back: { type: "seller_coin_cash_back", category: "seller_discount", impact: "outflow", fundedBy: "seller", settlement: true, verified: false, notes: "Coin cash-back funded by the seller." },

  // ---- platform-funded support (does not reduce seller income)
  shopee_discount: { column: "shopee_discount", type: "shopee_discount", category: "platform_support", impact: "info", fundedBy: "platform", settlement: false, verified: false, notes: "Discount funded by Shopee." },
  voucher_from_shopee: { column: "shopee_voucher", type: "shopee_voucher", category: "platform_support", impact: "info", fundedBy: "platform", settlement: false, verified: true, notes: "Shopee voucher." },
  coins: { type: "coins", category: "platform_support", impact: "info", fundedBy: "platform", settlement: false, verified: false, notes: "Shopee coins used by the buyer." },
  original_shopee_discount: { type: "original_shopee_discount", category: "platform_support", impact: "info", fundedBy: "platform", settlement: false, verified: false, notes: "Shopee discount before refunds." },
  payment_promotion: { column: "other_platform_support", type: "payment_promotion", category: "platform_support", impact: "info", fundedBy: "platform", settlement: false, verified: false, notes: "Payment-channel promotion." },
  credit_card_promotion: { type: "credit_card_promotion", category: "platform_support", impact: "info", fundedBy: "third_party", settlement: false, verified: false, notes: "Card promotion." },

  // ---- platform fees
  commission_fee: { column: "commission_fee", type: "commission_fee", category: "platform_fee", impact: "outflow", fundedBy: "seller", settlement: true, verified: true, notes: "Phí cố định." },
  service_fee: { column: "service_fee", type: "service_fee", category: "platform_fee", impact: "outflow", fundedBy: "seller", settlement: true, verified: true, notes: "Phí dịch vụ." },
  seller_transaction_fee: { column: "transaction_fee", type: "transaction_fee", category: "platform_fee", impact: "outflow", fundedBy: "seller", settlement: true, verified: true, notes: "Phí thanh toán." },
  credit_card_transaction_fee: { type: "credit_card_transaction_fee", category: "platform_fee", impact: "info", fundedBy: "seller", settlement: false, verified: true, notes: "VN: always EQUAL to seller_transaction_fee (same fee reported twice, also on COD orders) — info only, never added (double count)." },
  campaign_fee: { column: "campaign_fee", type: "campaign_fee", category: "platform_fee", impact: "outflow", fundedBy: "seller", settlement: true, verified: false, notes: "Campaign fee." },
  order_ams_commission_fee: { column: "affiliate_fee", type: "affiliate_fee", category: "platform_fee", impact: "outflow", fundedBy: "seller", settlement: true, verified: true, notes: "Affiliate (AMS) commission." },
  net_commission_fee: { type: "net_commission_fee", category: "platform_fee", impact: "info", fundedBy: "seller", settlement: false, verified: false, notes: "Market-specific (BR) re-statement of commission_fee — never added to it." },
  net_service_fee: { type: "net_service_fee", category: "platform_fee", impact: "info", fundedBy: "seller", settlement: false, verified: false, notes: "Market-specific (BR) re-statement of service_fee — never added to it." },
  buyer_transaction_fee: { type: "buyer_transaction_fee", category: "platform_fee", impact: "info", fundedBy: "buyer", settlement: false, verified: false, notes: "Fee paid by the buyer." },
  fbs_fee: { column: "other_platform_fee", type: "fbs_fee", category: "platform_fee", impact: "outflow", fundedBy: "seller", settlement: true, verified: false, notes: "Fulfilled-by-Shopee fee." },

  // ---- shipping
  final_shipping_fee: { type: "final_shipping_fee", category: "shipping", impact: "signed", fundedBy: "seller", settlement: true, verified: true, notes: "Signed: = shopee_shipping_rebate − actual_shipping_fee (VN). Does NOT include buyer_paid_shipping_fee, which is its own member." },
  buyer_paid_shipping_fee: { column: "buyer_paid_shipping", type: "buyer_paid_shipping", category: "shipping", impact: "inflow", fundedBy: "buyer", settlement: true, verified: true, notes: "Shipping paid by the buyer, passed to the seller (formula member next to final_shipping_fee)." },
  actual_shipping_fee: { column: "actual_shipping_fee", type: "actual_shipping_fee", category: "shipping", impact: "info", fundedBy: "seller", settlement: false, verified: true, notes: "Inside final_shipping_fee — never added separately." },
  shopee_shipping_rebate: { column: "shipping_rebate", type: "shipping_rebate", category: "shipping", impact: "info", fundedBy: "platform", settlement: false, verified: true, notes: "Inside final_shipping_fee — never added separately." },
  final_return_to_seller_shipping_fee: { column: "return_shipping_fee", type: "return_to_seller_shipping_fee", category: "shipping", impact: "outflow", fundedBy: "seller", settlement: true, verified: true, notes: "Shipping of a returned / failed parcel back to the seller (often offset by rsf_seller_protection_fee_claim_amount)." },
  shipping_fee_discount_from_3pl: { column: "shipping_discount", type: "shipping_discount_3pl", category: "shipping", impact: "info", fundedBy: "third_party", settlement: false, verified: false, notes: "Part of final_shipping_fee." },
  seller_shipping_discount: { type: "seller_shipping_discount", category: "shipping", impact: "info", fundedBy: "seller", settlement: false, verified: false, notes: "Seller-funded shipping discount (in final_shipping_fee?)." },
  estimated_shipping_fee: { type: "estimated_shipping_fee", category: "shipping", impact: "info", fundedBy: "unknown", settlement: false, verified: true, notes: "Estimate only." },
  reverse_shipping_fee: { column: "reverse_shipping_fee", type: "reverse_shipping_fee", category: "shipping", impact: "outflow", fundedBy: "seller", settlement: true, verified: false, notes: "Return shipping charged to the seller." },
  shipping_seller_protection_fee_amount: { type: "shipping_seller_protection_fee", category: "platform_fee", impact: "outflow", fundedBy: "seller", settlement: true, verified: true, notes: "Shipping protection fee." },
  delivery_seller_protection_fee_premium_amount: { type: "delivery_protection_premium", category: "platform_fee", impact: "outflow", fundedBy: "seller", settlement: true, verified: false, notes: "Delivery protection premium." },

  // ---- taxes (kept separate, never folded into fees)
  escrow_tax: { column: "escrow_tax", type: "escrow_tax", category: "tax", impact: "outflow", fundedBy: "seller", settlement: true, verified: false, notes: "Tax withheld from escrow." },
  withholding_tax: { column: "other_tax", type: "withholding_tax", category: "tax", impact: "outflow", fundedBy: "seller", settlement: true, verified: false, notes: "Generic withholding tax." },
  withholding_vat_tax: { column: "withholding_vat_tax", type: "withholding_vat_tax", category: "tax", impact: "outflow", fundedBy: "seller", settlement: true, verified: true, notes: "VAT withheld (VN household sellers)." },
  withholding_pit_tax: { column: "withholding_pit_tax", type: "withholding_pit_tax", category: "tax", impact: "outflow", fundedBy: "seller", settlement: true, verified: true, notes: "PIT withheld (VN household sellers)." },
  withholding_cit_tax: { column: "withholding_cit_tax", type: "withholding_cit_tax", category: "tax", impact: "outflow", fundedBy: "seller", settlement: true, verified: false, notes: "CIT withheld." },
  cross_border_tax: { type: "cross_border_tax", category: "tax", impact: "info", fundedBy: "buyer", settlement: false, verified: false, notes: "Cross-border only." },
  vat_on_imported_goods: { type: "vat_on_imported_goods", category: "tax", impact: "info", fundedBy: "buyer", settlement: false, verified: false, notes: "Cross-border only." },

  // ---- refunds / compensation
  seller_return_refund: { column: "refund_amount", type: "seller_return_refund", category: "refund", impact: "outflow", fundedBy: "seller", settlement: false, verified: true, notes: "Refunded to the buyer (provider value negative). ALREADY netted out of original_price/seller_discount → info, never added (double count). Never reverses internal COGS (SHOPEE-6)." },
  drc_adjustable_refund: { type: "drc_adjustable_refund", category: "refund", impact: "info", fundedBy: "unknown", settlement: false, verified: false, notes: "Dispute refund — semantics unverified." },
  seller_lost_compensation: { column: "seller_compensation_amount", type: "seller_compensation", category: "compensation", impact: "inflow", fundedBy: "platform", settlement: true, verified: false, notes: "Paid to the seller for lost items. Not sales." },
  rsf_seller_protection_fee_claim_amount: { type: "seller_protection_claim", category: "compensation", impact: "inflow", fundedBy: "platform", settlement: true, verified: true, notes: "Return-shipping protection payout (seen offsetting final_return_to_seller_shipping_fee)." },

  // ---- adjustments
  total_adjustment_amount: { column: "total_adjustment_amount", type: "total_adjustment_amount", category: "adjustment", impact: "info", fundedBy: "unknown", settlement: false, verified: false, notes: "Sum of order_adjustment[] — the rows are the formula members (no double count)." },

  // ---- Shopee naming that must NOT be read as internal COGS
  cost_of_goods_sold: { type: "shopee_cost_of_goods_sold", category: "sales", impact: "info", fundedBy: "buyer", settlement: false, verified: true, notes: "Shopee settlement naming — NOT internal COGS." },
  original_cost_of_goods_sold: { type: "shopee_original_cost_of_goods_sold", category: "sales", impact: "info", fundedBy: "buyer", settlement: false, verified: true, notes: "Shopee settlement naming — NOT internal COGS." },
};

/** order_adjustment[] rows: one signed component each. */
export const ADJUSTMENT_ROW: EscrowFieldDefinition = {
  type: "order_adjustment",
  category: "adjustment",
  impact: "signed",
  fundedBy: "unknown",
  settlement: true,
  verified: false,
  notes: "One row per Shopee adjustment (amount signed by seller impact).",
};

/**
 * Deliberately not turned into components (explicit, not silent):
 *   *_pri               primary-currency copies of the same amounts (cross-border view)
 *   items / order_adjustment / buyer_payment_info / tenure_info  structured (handled or not money)
 *   order_chargeable_weight, instalment_plan  not money
 *   tax_registration_code  the SELLER's tax / ID number — an all-digit string
 *                       that would otherwise parse as a "money" value (also
 *                       stripped from snapshots, see escrow-adapter PII_KEYS)
 */
export const IGNORED_FIELD_PATTERNS: readonly RegExp[] = [/_pri$/, /^order_chargeable_weight$/, /^instalment_plan$/, /^tax_registration_code$/];

/**
 * v1  first release, nothing verified (calculated_settlement always NULL)
 * v2  formula verified on real VN payloads (docs/shopee-financial-validation.md).
 * v3  estimated order revenue (escrow_amount → order_financials.estimated_order_revenue)
 *     + estimated profit against VAT-adjusted COGS (migration 00052).
 * Bumping the version makes every synced order a candidate for re-fetch +
 * recalculation (get_orders_needing_escrow_sync p_calculation_version).
 */
export const FINANCIAL_CALCULATION_VERSION = "shopee-fin-v3";

/**
 * Seller Center "Doanh thu đơn hàng ước tính" = order_income.escrow_amount
 * (Shopee: the amount the seller is expected to receive; it can change until
 * the order completes). Taken as-is — never rebuilt from fees. Mapping
 * status: candidate, pending the Seller Center comparison in
 * docs/shopee-financial-validation.md §10.
 */
export const ESTIMATED_ORDER_REVENUE_FIELD = "escrow_amount" as const;
