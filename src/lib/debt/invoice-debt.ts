import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";

// Kept in sync with the CASE expression in v_invoice_debt (migration 00017).
export type PaymentStatus = "unpaid" | "partial" | "paid";

export type InvoiceDebtRow = {
  invoice_id: string;
  invoice_no: string;
  invoice_date: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  invoice_total: number;
  paid_amount: number;
  remaining_amount: number;
  payment_status: PaymentStatus;
};

export type InvoiceDebtFilters = {
  supplierId?: string;
  paymentStatus?: PaymentStatus;
  fromDate?: string;
  toDate?: string;
  search?: string;
};

// invoice_total / paid_amount / remaining_amount / payment_status are all
// computed in the v_invoice_debt SQL view — this is a plain filtered,
// paginated read, no per-row math in the app layer.
export async function getInvoiceDebtList(
  filters: InvoiceDebtFilters,
  page: number,
  pageSize: number
): Promise<{ rows: InvoiceDebtRow[]; total: number; error: boolean }> {
  const supabase = createAdminClient();

  let query = supabase.from("v_invoice_debt").select("*", { count: "exact" });

  if (filters.supplierId) query = query.eq("supplier_id", filters.supplierId);
  if (filters.paymentStatus) query = query.eq("payment_status", filters.paymentStatus);
  if (filters.fromDate) query = query.gte("invoice_date", filters.fromDate);
  if (filters.toDate) query = query.lte("invoice_date", filters.toDate);
  if (filters.search) query = query.ilike("invoice_no", `%${escapeIlikeTerm(filters.search)}%`);

  const from = (page - 1) * pageSize;
  const { data, error, count } = await query
    .order("invoice_date", { ascending: false })
    .order("invoice_no", { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) {
    return { rows: [], total: 0, error: true };
  }

  return { rows: (data ?? []) as InvoiceDebtRow[], total: count ?? 0, error: false };
}

// Single-invoice lookup — used where a page already has an invoice_id (e.g.
// an invoice detail page wanting its own debt figures without listing).
export async function getInvoiceDebt(invoiceId: string): Promise<{ row: InvoiceDebtRow | null; error: boolean }> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("v_invoice_debt")
    .select("*")
    .eq("invoice_id", invoiceId)
    .maybeSingle();

  if (error) {
    return { row: null, error: true };
  }

  return { row: (data as InvoiceDebtRow) ?? null, error: false };
}
