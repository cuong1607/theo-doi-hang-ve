import { createAdminClient } from "@/lib/supabase/admin";
import type { PaymentStatus } from "./invoice-debt";

export type DebtScreenFilters = {
  fromDate: string;
  toDate: string;
  supplierId?: string;
  paymentStatus?: PaymentStatus;
  search?: string;
};

export type SupplierDebtSummaryRow = {
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  supplier_invoice_total: number;
  supplier_paid_total: number;
  supplier_remaining_total: number;
  supplier_open_invoice_count: number;
};

// All figures come from v_supplier_debt_summary (migration 00017), which
// rolls up v_invoice_debt per supplier — no per-row math in the app layer.
export async function getSupplierDebtSummaryList(): Promise<{
  rows: SupplierDebtSummaryRow[];
  error: boolean;
}> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("v_supplier_debt_summary")
    .select("*")
    .order("supplier_remaining_total", { ascending: false });

  if (error) {
    return { rows: [], error: true };
  }

  return { rows: (data ?? []) as SupplierDebtSummaryRow[], error: false };
}

export async function getSupplierDebtSummary(
  supplierId: string
): Promise<{ row: SupplierDebtSummaryRow | null; error: boolean }> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("v_supplier_debt_summary")
    .select("*")
    .eq("supplier_id", supplierId)
    .maybeSingle();

  if (error) {
    return { row: null, error: true };
  }

  return { row: (data as SupplierDebtSummaryRow) ?? null, error: false };
}

// Filtered per-supplier breakdown for the /debts screen (Phần 3) — a single
// SQL aggregate (get_supplier_debt_summary_filtered, migration 00018), not
// a fetch-all-then-reduce in the app layer. Always includes every supplier,
// even ones with zero invoices matching the filter (LEFT JOIN in the RPC).
export async function getSupplierDebtSummaryFiltered(
  filters: DebtScreenFilters
): Promise<{ rows: SupplierDebtSummaryRow[]; error: boolean }> {
  const supabase = createAdminClient();

  const { data, error } = await supabase.rpc("get_supplier_debt_summary_filtered", {
    p_from_date: filters.fromDate,
    p_to_date: filters.toDate,
    p_supplier_id: filters.supplierId || null,
    p_status: filters.paymentStatus || null,
    p_search: filters.search || null,
  });

  if (error) {
    return { rows: [], error: true };
  }

  return { rows: (data ?? []) as SupplierDebtSummaryRow[], error: false };
}
