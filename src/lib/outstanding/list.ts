import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";

// Kept in sync with the CASE expression in v_outstanding (migration 00014).
export type OutstandingStatus = "need_makeup" | "low" | "normal";

export type OutstandingRow = {
  invoice_item_id: string;
  invoice_id: string;
  invoice_no: string;
  invoice_date: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  product_id: string;
  sku: string;
  product_name: string;
  unit: string;
  invoice_qty: number;
  unit_price: number;
  received_qty: number;
  remaining_qty: number;
  invoice_value: number;
  received_value: number;
  remaining_value: number;
  status: OutstandingStatus;
};

export type OutstandingFilters = {
  supplierId?: string;
  invoiceDate?: string;
  sku?: string;
  status?: OutstandingStatus;
};

// All the arithmetic (received_qty, remaining_qty, values, status threshold)
// happens in the v_outstanding SQL view — this is a plain filtered,
// paginated read, no per-row math in the app layer. See the migration for
// the Excel-compatibility caveat (possible double-counting across
// overlapping invoices for the same supplier+SKU).
export async function getOutstandingList(
  filters: OutstandingFilters,
  page: number,
  pageSize: number
): Promise<{ rows: OutstandingRow[]; total: number; error: boolean }> {
  const supabase = createAdminClient();

  let query = supabase.from("v_outstanding").select("*", { count: "exact" });

  if (filters.supplierId) query = query.eq("supplier_id", filters.supplierId);
  if (filters.invoiceDate) query = query.eq("invoice_date", filters.invoiceDate);
  if (filters.sku) query = query.ilike("sku", `%${escapeIlikeTerm(filters.sku)}%`);
  if (filters.status) query = query.eq("status", filters.status);

  const from = (page - 1) * pageSize;
  const { data, error, count } = await query
    .order("invoice_date", { ascending: false })
    .order("invoice_no", { ascending: false })
    .order("sku", { ascending: true })
    .range(from, from + pageSize - 1);

  if (error) {
    return { rows: [], total: 0, error: true };
  }

  return { rows: (data ?? []) as OutstandingRow[], total: count ?? 0, error: false };
}
