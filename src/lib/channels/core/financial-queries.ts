// ============================================================
// PHASE SHOPEE-5: read queries for order financials (server-only,
// service-role — callers authorize with channel:view first).
//
// NUMERIC columns are cast to text in the query and stay strings (no JS
// float). NULL = not known yet; "0" = confirmed zero — the UI must show the
// difference. Raw escrow snapshots are never read here (admin/server only).
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

const MONEY_COLUMNS = [
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
  "actual_shopee_income",
  "internal_cogs",
  "profit_after_cogs",
  "calculated_settlement",
  "settlement_variance",
  "settlement_tolerance",
  "unverified_component_amount",
] as const;
export type FinancialMoneyColumn = (typeof MONEY_COLUMNS)[number];

export interface OrderFinancialDetail {
  money: Record<FinancialMoneyColumn, string | null>;
  reconciliationStatus: "matched" | "warning" | "mismatch" | null;
  calculationVersion: string | null;
  escrowSyncedAt: string | null;
  escrowLastAttemptAt: string | null;
  escrowLastErrorCode: string | null;
  components: Array<{
    componentKey: string;
    componentType: string;
    providerField: string | null;
    category: string;
    amount: string;
    fundedBy: string | null;
    includedInSettlement: boolean;
    metadata: Record<string, unknown> | null;
  }>;
}

export async function getOrderFinancialDetail(orderId: string): Promise<OrderFinancialDetail | null> {
  const db = createAdminClient();
  const select = [...MONEY_COLUMNS.map((c) => `${c}::text`), "reconciliation_status", "calculation_version", "escrow_synced_at", "escrow_last_attempt_at", "escrow_last_error_code"].join(", ");
  const [fin, comps] = await Promise.all([
    db.from("order_financials").select(select).eq("order_id", orderId).maybeSingle(),
    db
      .from("order_financial_components")
      .select("component_key, component_type, provider_field, category, amount::text, funded_by, included_in_settlement, metadata")
      .eq("order_id", orderId)
      .order("category")
      .order("component_key"),
  ]);
  if (fin.error) throw new Error(fin.error.message);
  if (comps.error) throw new Error(comps.error.message);
  if (!fin.data) return null;
  const row = fin.data as unknown as Record<string, string | null>;
  const money = Object.fromEntries(MONEY_COLUMNS.map((c) => [c, row[c] ?? null])) as Record<FinancialMoneyColumn, string | null>;
  return {
    money,
    reconciliationStatus: (row.reconciliation_status as OrderFinancialDetail["reconciliationStatus"]) ?? null,
    calculationVersion: row.calculation_version ?? null,
    escrowSyncedAt: row.escrow_synced_at ?? null,
    escrowLastAttemptAt: row.escrow_last_attempt_at ?? null,
    escrowLastErrorCode: row.escrow_last_error_code ?? null,
    components: ((comps.data ?? []) as unknown as Array<Record<string, unknown>>).map((c) => ({
      componentKey: c.component_key as string,
      componentType: c.component_type as string,
      providerField: (c.provider_field as string | null) ?? null,
      category: c.category as string,
      amount: c.amount as string,
      fundedBy: (c.funded_by as string | null) ?? null,
      includedInSettlement: c.included_in_settlement as boolean,
      metadata: (c.metadata as Record<string, unknown> | null) ?? null,
    })),
  };
}
