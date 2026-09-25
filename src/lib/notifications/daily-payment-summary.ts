import { createAdminClient } from "@/lib/supabase/admin";

import type { DailyPaymentSummary, DailyPaymentSupplierBreakdown } from "./daily-payment-summary-message";

export type { DailyPaymentSummary, DailyPaymentSupplierBreakdown, DailyPaymentInvoiceLine } from "./daily-payment-summary-message";
export { getTodayDateVN, formatDailyPaymentSummaryMessage } from "./daily-payment-summary-message";

type InvoiceRow = {
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  invoice_id: string;
  invoice_no: string;
  amount_paid: number;
};

// The per-(supplier,invoice) SUM happens in get_daily_payment_summary_by_invoice
// (migration 00032) — this only groups that already-aggregated row set into
// per-supplier buckets (Map preserves the SQL's ORDER BY supplier/invoice_no,
// so no re-sorting needed) and sums a handful of numbers for the grand
// total. payment_count is a separate trivial COUNT(*), run in parallel.
export async function buildDailyPaymentSummary(date: string): Promise<DailyPaymentSummary> {
  const supabase = createAdminClient();

  const [invoiceRowsResult, paymentCountResult] = await Promise.all([
    supabase.rpc("get_daily_payment_summary_by_invoice", { p_date: date }),
    supabase.from("payments").select("id", { count: "exact", head: true }).eq("payment_date", date),
  ]);

  if (invoiceRowsResult.error) {
    throw new Error(`Không thể tính tổng hợp thanh toán ngày ${date}: ${invoiceRowsResult.error.message}`);
  }
  if (paymentCountResult.error) {
    throw new Error(`Không thể đếm số lượt thanh toán ngày ${date}: ${paymentCountResult.error.message}`);
  }

  const rows = (invoiceRowsResult.data ?? []) as InvoiceRow[];

  const suppliersMap = new Map<string, DailyPaymentSupplierBreakdown>();
  for (const r of rows) {
    let bucket = suppliersMap.get(r.supplier_id);
    if (!bucket) {
      bucket = {
        supplierId: r.supplier_id,
        supplierCode: r.supplier_code,
        supplierName: r.supplier_name,
        invoices: [],
        supplierTotal: 0,
      };
      suppliersMap.set(r.supplier_id, bucket);
    }
    bucket.invoices.push({ invoiceId: r.invoice_id, invoiceNo: r.invoice_no, amountPaid: r.amount_paid });
    bucket.supplierTotal += r.amount_paid;
  }
  const suppliers = [...suppliersMap.values()];

  return {
    date,
    paymentCount: paymentCountResult.count ?? 0,
    invoiceCount: rows.length,
    totalPaid: suppliers.reduce((sum, s) => sum + s.supplierTotal, 0),
    suppliers,
  };
}
