import { createAdminClient } from "@/lib/supabase/admin";

export type DailyProductRow = {
  product_id: string;
  sku: string;
  product_name: string;
  unit: string;
  morning_delivered_qty: number;
  morning_received_qty: number;
  morning_difference_qty: number;
  morning_line_total: number;
  morning_unit_prices: number[] | null;
  morning_item_count: number;
  afternoon_delivered_qty: number;
  afternoon_received_qty: number;
  afternoon_difference_qty: number;
  afternoon_line_total: number;
  afternoon_unit_prices: number[] | null;
  afternoon_item_count: number;
  total_delivered_qty: number;
  total_received_qty: number;
  total_difference_qty: number;
  total_line_total: number;
  total_unit_prices: number[] | null;
};

export type SourceReceipt = {
  receipt_id: string;
  receipt_no: string;
  shift: "morning" | "afternoon";
  receiver_name: string;
  note: string | null;
  created_at: string;
  sku_count: number;
  total_amount: number;
};

export type LinkedInvoice = { id: string; invoice_no: string; invoice_date: string };

export type DailyReceiptDetail = {
  supplier: { id: string; code: string; name: string } | null;
  products: DailyProductRow[];
  receipts: SourceReceipt[];
  // INV-FROM-RECEIPTS: the from_receipts invoice this day was used for.
  linkedInvoice: LinkedInvoice | null;
};

// Single service/query layer for the /receipts/daily/[date]/[supplierId]
// screen. All aggregation (SUM/GROUP BY per product, distinct-price
// detection) happens in the v_daily_receipt_product_summary /
// v_receipt_summary SQL views — this function just runs three narrow,
// already-filtered queries (supplier lookup + the two views) in parallel.
// No per-row aggregation happens here or in the page component, and there
// is no N+1: each query is a single filtered SELECT regardless of how many
// receipts/items exist for the day.
export async function getDailyReceiptDetail(
  date: string,
  supplierId: string
): Promise<DailyReceiptDetail> {
  const supabase = createAdminClient();

  const [supplierResult, productsResult, receiptsResult, linkResult] = await Promise.all([
    supabase.from("suppliers").select("id, code, name").eq("id", supplierId).maybeSingle(),
    supabase
      .from("v_daily_receipt_product_summary")
      .select("*")
      .eq("receipt_date", date)
      .eq("supplier_id", supplierId)
      .order("sku", { ascending: true }),
    supabase
      .from("v_receipt_summary")
      .select("*")
      .eq("receipt_date", date)
      .eq("supplier_id", supplierId)
      .order("created_at", { ascending: true }),
    supabase
      .from("invoice_receipt_days")
      .select("invoices(id, invoice_no, invoice_date)")
      .eq("receipt_date", date)
      .eq("supplier_id", supplierId)
      .maybeSingle(),
  ]);

  const link = linkResult.data as unknown as { invoices: LinkedInvoice | null } | null;

  return {
    supplier: supplierResult.data ?? null,
    products: (productsResult.data as DailyProductRow[] | null) ?? [],
    receipts: (receiptsResult.data as SourceReceipt[] | null) ?? [],
    linkedInvoice: link?.invoices ?? null,
  };
}
