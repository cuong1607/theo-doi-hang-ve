import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";

export type InvoiceListRow = {
  id: string;
  invoice_no: string;
  invoice_date: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  sku_count: number;
  total_quantity: number;
  total_amount: number;
  source_type: "manual" | "from_receipts";
  receipt_start_date: string | null;
};

export type InvoiceListFilters = {
  fromDate?: string;
  toDate?: string;
  supplierId?: string;
  invoiceNo?: string;
};

// v_invoice_summary already rolls each invoice's items up to one row (see the
// migration), so this is a plain filtered + paginated read — no RPC needed
// the way the receipt daily-groups list needs one for its GROUP BY.
export async function getInvoiceList(
  filters: InvoiceListFilters,
  page: number,
  pageSize: number
): Promise<{ rows: InvoiceListRow[]; total: number; error: boolean }> {
  const supabase = createAdminClient();

  let query = supabase.from("v_invoice_summary").select("*", { count: "exact" });

  if (filters.fromDate) query = query.gte("invoice_date", filters.fromDate);
  if (filters.toDate) query = query.lte("invoice_date", filters.toDate);
  if (filters.supplierId) query = query.eq("supplier_id", filters.supplierId);
  if (filters.invoiceNo) {
    query = query.ilike("invoice_no", `%${escapeIlikeTerm(filters.invoiceNo)}%`);
  }

  const from = (page - 1) * pageSize;
  const { data, error, count } = await query
    .order("invoice_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) {
    return { rows: [], total: 0, error: true };
  }

  return { rows: (data ?? []) as InvoiceListRow[], total: count ?? 0, error: false };
}
