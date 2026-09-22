import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";

export type PaymentSummaryRow = {
  id: string;
  payment_date: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  total_amount: number;
  note: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  invoice_count: number;
  invoice_numbers: string | null;
};

export type PaymentListFilters = {
  fromDate?: string;
  toDate?: string;
  supplierId?: string;
  search?: string;
};

// invoice_count / invoice_numbers / total_amount all come from
// v_payment_summary (migration 00020) — a plain filtered, paginated read.
export async function getPaymentList(
  filters: PaymentListFilters,
  page: number,
  pageSize: number
): Promise<{ rows: PaymentSummaryRow[]; total: number; error: boolean }> {
  const supabase = createAdminClient();

  let query = supabase.from("v_payment_summary").select("*", { count: "exact" });

  if (filters.fromDate) query = query.gte("payment_date", filters.fromDate);
  if (filters.toDate) query = query.lte("payment_date", filters.toDate);
  if (filters.supplierId) query = query.eq("supplier_id", filters.supplierId);
  if (filters.search) {
    const term = escapeIlikeTerm(filters.search);
    query = query.or(
      `note.ilike.%${term}%,supplier_name.ilike.%${term}%,invoice_numbers.ilike.%${term}%`
    );
  }

  const from = (page - 1) * pageSize;
  const { data, error, count } = await query
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) {
    return { rows: [], total: 0, error: true };
  }

  return { rows: (data ?? []) as PaymentSummaryRow[], total: count ?? 0, error: false };
}
