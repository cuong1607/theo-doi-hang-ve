import { createAdminClient } from "@/lib/supabase/admin";
import type { OutstandingRow, OutstandingStatus } from "@/lib/outstanding/list";
import type { SupplierType } from "@/lib/debt/invoice-debt";

export type DashboardFilters = {
  fromDate: string;
  toDate: string;
  supplierId?: string;
};

// Financial (invoice/discount/VAT/debt) metrics accept an extra
// supplierType dimension the receipt-based metrics above don't have.
export type DashboardFinancialFilters = DashboardFilters & {
  supplierType?: SupplierType;
};

export type DashboardSummary = {
  receipt_count: number;
  daily_group_count: number;
  total_delivered_qty: number;
  total_received_qty: number;
  total_difference_qty: number;
  total_amount: number;
};

// Every function below is a single SQL aggregate (view or RPC) call — no
// raw-row fetch + in-app summation, and no per-row follow-up queries.
export async function getDashboardSummary(f: DashboardFilters): Promise<{
  data: DashboardSummary | null;
  error: boolean;
}> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .rpc("get_dashboard_summary", {
      p_from_date: f.fromDate,
      p_to_date: f.toDate,
      p_supplier_id: f.supplierId || null,
    })
    .maybeSingle();
  return { data: (data as DashboardSummary) ?? null, error: !!error };
}

export type DashboardOutstandingSummary = {
  watching_invoice_count: number;
  low_sku_count: number;
  need_makeup_sku_count: number;
};

export async function getDashboardOutstandingSummary(f: DashboardFilters): Promise<{
  data: DashboardOutstandingSummary | null;
  error: boolean;
}> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .rpc("get_dashboard_outstanding_summary", {
      p_from_date: f.fromDate,
      p_to_date: f.toDate,
      p_supplier_id: f.supplierId || null,
    })
    .maybeSingle();
  return { data: (data as DashboardOutstandingSummary) ?? null, error: !!error };
}

export type DailySeriesPoint = {
  receipt_date: string;
  total_delivered_qty: number;
  total_received_qty: number;
  total_amount: number;
};

export async function getDashboardDailySeries(
  f: DashboardFilters
): Promise<{ data: DailySeriesPoint[]; error: boolean }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("get_dashboard_daily_series", {
    p_from_date: f.fromDate,
    p_to_date: f.toDate,
    p_supplier_id: f.supplierId || null,
  });
  return { data: (data ?? []) as DailySeriesPoint[], error: !!error };
}

export type SupplierTotal = {
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  total_received_qty: number;
  total_amount: number;
};

export async function getDashboardSupplierTotals(
  f: DashboardFilters
): Promise<{ data: SupplierTotal[]; error: boolean }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("get_dashboard_supplier_totals", {
    p_from_date: f.fromDate,
    p_to_date: f.toDate,
    p_supplier_id: f.supplierId || null,
  });
  return { data: (data ?? []) as SupplierTotal[], error: !!error };
}

// Top N outstanding rows per status, for the "Cảnh báo outstanding" section.
// Two separate small limited queries (not one unbounded fetch) — cheap and
// each already sorted/limited by Postgres.
export async function getTopOutstanding(
  f: DashboardFilters,
  status: OutstandingStatus,
  limit: number
): Promise<{ data: OutstandingRow[]; error: boolean }> {
  const supabase = createAdminClient();
  let query = supabase
    .from("v_outstanding")
    .select("*")
    .eq("status", status)
    .gte("invoice_date", f.fromDate)
    .lte("invoice_date", f.toDate);
  if (f.supplierId) query = query.eq("supplier_id", f.supplierId);

  const { data, error } = await query.order("remaining_qty", { ascending: true }).limit(limit);
  return { data: (data ?? []) as OutstandingRow[], error: !!error };
}

export type RecentDailySummary = {
  receipt_date: string;
  supplier_id: string;
  supplier_name: string;
  total_delivered_qty: number;
  total_received_qty: number;
  total_difference_qty: number;
  total_amount: number;
};

export async function getRecentDailySummaries(
  f: DashboardFilters,
  limit: number
): Promise<{ data: RecentDailySummary[]; error: boolean }> {
  const supabase = createAdminClient();
  let query = supabase
    .from("v_daily_receipt_summary")
    .select(
      "receipt_date, supplier_id, supplier_name, total_delivered_qty, total_received_qty, total_difference_qty, total_amount"
    )
    .gte("receipt_date", f.fromDate)
    .lte("receipt_date", f.toDate);
  if (f.supplierId) query = query.eq("supplier_id", f.supplierId);

  const { data, error } = await query
    .order("receipt_date", { ascending: false })
    .limit(limit);
  return { data: (data ?? []) as RecentDailySummary[], error: !!error };
}

export type RecentReceipt = {
  id: string;
  receipt_no: string;
  receipt_date: string;
  shift: string;
  receiver_name: string;
  supplier_code: string;
  supplier_name: string;
};

// Receipt-level records (Section 5), kept clearly separate from the
// daily-summary rows above — a receipt is one actual phiếu nhập, not a
// day+supplier rollup.
export async function getRecentReceipts(
  f: DashboardFilters,
  limit: number
): Promise<{ data: RecentReceipt[]; error: boolean }> {
  const supabase = createAdminClient();
  let query = supabase
    .from("receipts")
    .select("id, receipt_no, receipt_date, shift, receiver_name, suppliers(code, name)")
    .gte("receipt_date", f.fromDate)
    .lte("receipt_date", f.toDate);
  if (f.supplierId) query = query.eq("supplier_id", f.supplierId);

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  const rows = (data ?? []) as unknown as (Omit<RecentReceipt, "supplier_code" | "supplier_name"> & {
    suppliers: { code: string; name: string } | null;
  })[];

  return {
    data: rows.map((r) => ({
      id: r.id,
      receipt_no: r.receipt_no,
      receipt_date: r.receipt_date,
      shift: r.shift,
      receiver_name: r.receiver_name,
      supplier_code: r.suppliers?.code ?? "",
      supplier_name: r.suppliers?.name ?? "",
    })),
    error: !!error,
  };
}

// ============================================================
// PHASE UP5: Financial (invoice/discount/VAT/debt) dashboard metrics.
// Built on v_invoice_debt via dedicated aggregate RPCs (migration 00026) —
// same single-aggregate-query convention as everything above, no raw-row
// fetch summed client-side.
// ============================================================

export type DashboardFinancialSummary = {
  total_subtotal_amount: number;
  total_discount_amount: number;
  total_vat_amount: number;
  total_final_amount: number;
  total_paid_amount: number;
  total_remaining_amount: number;
};

export async function getDashboardFinancialSummary(f: DashboardFinancialFilters): Promise<{
  data: DashboardFinancialSummary | null;
  error: boolean;
}> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .rpc("get_dashboard_financial_summary", {
      p_from_date: f.fromDate,
      p_to_date: f.toDate,
      p_supplier_id: f.supplierId || null,
      p_supplier_type: f.supplierType || null,
    })
    .maybeSingle();
  return { data: (data as DashboardFinancialSummary) ?? null, error: !!error };
}

export type DashboardFinancialSupplierRow = {
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  supplier_type: SupplierType;
  subtotal_total: number;
  discount_total: number;
  vat_total: number;
  final_total: number;
  paid_total: number;
  remaining_total: number;
};

export async function getDashboardFinancialSupplierBreakdown(
  f: DashboardFinancialFilters
): Promise<{ data: DashboardFinancialSupplierRow[]; error: boolean }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("get_dashboard_financial_supplier_breakdown", {
    p_from_date: f.fromDate,
    p_to_date: f.toDate,
    p_supplier_id: f.supplierId || null,
    p_supplier_type: f.supplierType || null,
  });
  return { data: (data ?? []) as DashboardFinancialSupplierRow[], error: !!error };
}

export type DashboardFinancialTypeRow = {
  supplier_type: SupplierType;
  subtotal_total: number;
  discount_total: number;
  vat_total: number;
  final_total: number;
  paid_total: number;
  remaining_total: number;
};

export async function getDashboardFinancialTypeBreakdown(
  f: DashboardFinancialFilters
): Promise<{ data: DashboardFinancialTypeRow[]; error: boolean }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("get_dashboard_financial_type_breakdown", {
    p_from_date: f.fromDate,
    p_to_date: f.toDate,
    p_supplier_id: f.supplierId || null,
    p_supplier_type: f.supplierType || null,
  });
  return { data: (data ?? []) as DashboardFinancialTypeRow[], error: !!error };
}
