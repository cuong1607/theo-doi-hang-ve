import { createAdminClient } from "@/lib/supabase/admin";
import type { DebtScreenFilters } from "./supplier-debt";

export type DebtOverview = {
  total_subtotal_amount: number;
  total_discount_amount: number;
  total_vat_amount: number;
  total_final_amount: number;
  total_paid_amount: number;
  total_remaining_amount: number;
  open_invoice_count: number;
};

// Single SQL aggregate (get_debt_overview, migration 00018) over the whole
// filtered set — never a sum of a paginated page's rows.
export async function getDebtOverview(
  filters: DebtScreenFilters
): Promise<{ data: DebtOverview | null; error: boolean }> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .rpc("get_debt_overview", {
      p_from_date: filters.fromDate,
      p_to_date: filters.toDate,
      p_supplier_id: filters.supplierId || null,
      p_status: filters.paymentStatus || null,
      p_search: filters.search || null,
    })
    .maybeSingle();

  if (error) {
    return { data: null, error: true };
  }

  return { data: (data as DebtOverview) ?? null, error: false };
}
