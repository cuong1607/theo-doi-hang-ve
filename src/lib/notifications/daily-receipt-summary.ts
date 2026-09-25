import { createAdminClient } from "@/lib/supabase/admin";

import type { DailyReceiptSummary, DailyReceiptSupplierBreakdown } from "./daily-receipt-summary-message";

export type { DailyReceiptSummary, DailyReceiptSupplierBreakdown } from "./daily-receipt-summary-message";
export { getTodayDateVN, formatDailyReceiptSummaryMessage } from "./daily-receipt-summary-message";

// All GROUP BY / SUM happens in get_daily_receipt_summary_by_supplier
// (migration 00030) — this just reads that already-aggregated per-supplier
// result set and sums it into the overall "TỔNG" line (summing a handful of
// numbers, not raw receipt_items rows, so no aggregation happens in the
// browser or over raw rows here).
export async function buildDailyReceiptSummary(date: string): Promise<DailyReceiptSummary> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("get_daily_receipt_summary_by_supplier", { p_date: date });

  if (error) {
    throw new Error(`Không thể tính tổng hợp hàng về ngày ${date}: ${error.message}`);
  }

  const rows = (data ?? []) as {
    supplier_id: string;
    supplier_code: string;
    supplier_name: string;
    receipt_count: number;
    total_delivered: number;
    total_received: number;
    total_difference: number;
    total_amount: number;
  }[];

  const suppliers: DailyReceiptSupplierBreakdown[] = rows.map((r) => ({
    supplierId: r.supplier_id,
    supplierCode: r.supplier_code,
    supplierName: r.supplier_name,
    receiptCount: r.receipt_count,
    totalDelivered: r.total_delivered,
    totalReceived: r.total_received,
    totalDifference: r.total_difference,
    totalAmount: r.total_amount,
  }));

  return {
    date,
    receiptCount: suppliers.reduce((sum, s) => sum + s.receiptCount, 0),
    totalDelivered: suppliers.reduce((sum, s) => sum + s.totalDelivered, 0),
    totalReceived: suppliers.reduce((sum, s) => sum + s.totalReceived, 0),
    totalDifference: suppliers.reduce((sum, s) => sum + s.totalDifference, 0),
    totalAmount: suppliers.reduce((sum, s) => sum + s.totalAmount, 0),
    suppliers,
  };
}
