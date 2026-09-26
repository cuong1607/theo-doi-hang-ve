// ============================================================
// PHASE INV-FROM-RECEIPTS — server-side loader shared by the preview and the
// create action, so what the modal shows and what gets priced/saved come
// from the exact same queries. Line grouping itself lives in SQL
// (get_receipt_days_invoice_lines, migration 00034), which the create RPC
// re-runs under its per-day locks.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { SupplierType } from "@/lib/invoices/financials";

export type ReceiptInvoiceLine = {
  product_id: string;
  sku: string;
  product_name: string;
  unit: string;
  unit_price: number;
  quantity: number;
  line_total: number;
};

export type ReceiptInvoiceDraft = {
  supplier: { id: string; code: string; name: string; supplier_type: SupplierType };
  receiptDates: string[];
  receiptStartDate: string;
  lines: ReceiptInvoiceLine[];
  totalQuantity: number;
};

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// `receiptDates` must already be normalized (normalizeReceiptDates) and
// non-empty. Every check here is re-done by the DB inside the create
// transaction; this layer exists to give the preview precise messages.
export async function loadReceiptInvoiceDraft(
  supabase: ReturnType<typeof createAdminClient>,
  supplierId: string,
  receiptDates: string[]
): Promise<{ ok: true; draft: ReceiptInvoiceDraft } | { ok: false; error: string }> {
  const [supplierResult, receiptsResult, linkedResult, linesResult] = await Promise.all([
    supabase.from("suppliers").select("id, code, name, supplier_type").eq("id", supplierId).maybeSingle(),
    supabase.from("receipts").select("receipt_date").eq("supplier_id", supplierId).in("receipt_date", receiptDates),
    supabase
      .from("invoice_receipt_days")
      .select("receipt_date, invoices(invoice_no)")
      .eq("supplier_id", supplierId)
      .in("receipt_date", receiptDates)
      .order("receipt_date"),
    supabase.rpc("get_receipt_days_invoice_lines", {
      p_supplier_id: supplierId,
      p_receipt_dates: receiptDates,
    }),
  ]);

  if (supplierResult.error || receiptsResult.error || linkedResult.error || linesResult.error) {
    return { ok: false, error: "Không thể tải dữ liệu hàng về. Vui lòng thử lại." };
  }
  if (!supplierResult.data) {
    return { ok: false, error: "Nhà cung cấp không tồn tại." };
  }

  const existingDays = new Set((receiptsResult.data ?? []).map((r) => r.receipt_date as string));
  const missing = receiptDates.filter((d) => !existingDays.has(d));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Ngày ${missing.map(formatDateVN).join(", ")} không có phiếu nhập của nhà cung cấp này.`,
    };
  }

  const linked = (linkedResult.data ?? []) as unknown as {
    receipt_date: string;
    invoices: { invoice_no: string } | null;
  }[];
  if (linked.length > 0) {
    const detail = linked
      .map((l) => `${formatDateVN(l.receipt_date)} (HĐ ${l.invoices?.invoice_no ?? "?"})`)
      .join(", ");
    return { ok: false, error: `Ngày hàng về đã được lập hóa đơn: ${detail}. Vui lòng tải lại dữ liệu.` };
  }

  const lines = (linesResult.data ?? []) as ReceiptInvoiceLine[];
  if (lines.length === 0) {
    return { ok: false, error: "Các ngày đã chọn không có số lượng hàng nhận." };
  }

  return {
    ok: true,
    draft: {
      supplier: supplierResult.data as ReceiptInvoiceDraft["supplier"],
      receiptDates,
      receiptStartDate: receiptDates[0],
      lines,
      // quantities are numeric(15,2); round away float noise from the sum.
      totalQuantity: Math.round(lines.reduce((sum, l) => sum + Number(l.quantity), 0) * 100) / 100,
    },
  };
}
