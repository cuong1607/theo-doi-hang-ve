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

export type OutstandingSummary = {
  total_invoice_amount: number;
  total_received_amount: number;
  total_remaining_amount: number;
};

// Single SQL aggregate (get_outstanding_summary, migration 00027) over the
// WHOLE filtered set — never a sum of a paginated page's rows. invoice_value/
// received_value/remaining_value already account for VAT (công ty) /
// chiết khấu (hộ kinh doanh) via v_outstanding's per-invoice allocation.
export async function getOutstandingSummary(
  filters: OutstandingFilters
): Promise<{ data: OutstandingSummary | null; error: boolean }> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .rpc("get_outstanding_summary", {
      p_supplier_id: filters.supplierId || null,
      p_invoice_date: filters.invoiceDate || null,
      p_sku: filters.sku || null,
      p_status: filters.status || null,
    })
    .maybeSingle();

  if (error) {
    return { data: null, error: true };
  }

  return { data: (data as OutstandingSummary) ?? null, error: false };
}
