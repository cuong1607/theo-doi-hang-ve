import { createAdminClient } from "@/lib/supabase/admin";
import { escapeIlikeTerm } from "@/lib/supabase/search";

export type DailyGroup = {
  receipt_date: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  sku_count: number;
  total_delivered_qty: number;
  total_received_qty: number;
  total_difference_qty: number;
  total_line_total: number;
  // INV-FROM-RECEIPTS: the from_receipts invoice this daily group feeds, if
  // any (at most one — UNIQUE(supplier_id, receipt_date) on
  // invoice_receipt_days). null = "Chưa lập HĐ". Comes from the same RPC
  // call, no per-row lookup.
  linked_invoice_id: string | null;
  linked_invoice_no: string | null;
};

export type ReceiptHistoryFilters = {
  fromDate?: string;
  toDate?: string;
  supplierId?: string;
  sku?: string;
  productName?: string;
};

// GROUP BY (receipt_date, supplier_id) via the get_receipt_daily_groups RPC —
// aggregation happens entirely in SQL (see the migration for why), this is
// just a single filtered, paginated call. No N+1, no per-row math here.
//
// IMPORTANT: when `sku` or `productName` is set, the RPC's WHERE clause
// filters receipt_items/products *before* summing, so a group's totals
// reflect only the matching product(s) — never the day's unfiltered total.
// The page must not present these numbers as "tổng cả ngày" while a
// SKU/product filter is active, since that would misrepresent the data.
export async function getReceiptDailyGroups(
  filters: ReceiptHistoryFilters,
  page: number,
  pageSize: number
): Promise<{ groups: DailyGroup[]; totalGroups: number; error: boolean }> {
  const supabase = createAdminClient();

  const { data, error } = await supabase.rpc("get_receipt_daily_groups", {
    p_from_date: filters.fromDate || null,
    p_to_date: filters.toDate || null,
    p_supplier_id: filters.supplierId || null,
    p_sku: filters.sku ? escapeIlikeTerm(filters.sku) : null,
    p_product_name: filters.productName ? escapeIlikeTerm(filters.productName) : null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });

  if (error) {
    return { groups: [], totalGroups: 0, error: true };
  }

  const rows = (data ?? []) as (DailyGroup & { total_groups: number })[];
  const totalGroups = rows[0]?.total_groups ?? 0;
  return {
    groups: rows.map((row) => ({
      receipt_date: row.receipt_date,
      supplier_id: row.supplier_id,
      supplier_code: row.supplier_code,
      supplier_name: row.supplier_name,
      sku_count: row.sku_count,
      total_delivered_qty: row.total_delivered_qty,
      total_received_qty: row.total_received_qty,
      total_difference_qty: row.total_difference_qty,
      total_line_total: row.total_line_total,
      linked_invoice_id: row.linked_invoice_id,
      linked_invoice_no: row.linked_invoice_no,
    })),
    totalGroups,
    error: false,
  };
}
