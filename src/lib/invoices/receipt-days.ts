// ============================================================
// PHASE INV-FROM-RECEIPTS — pure helpers (no I/O, no "@/" imports) so they
// are `node --test`-able, same convention as financials.ts.
// ============================================================

export type InvoiceSourceType = "manual" | "from_receipts";

export const INVOICE_SOURCE_LABELS: Record<InvoiceSourceType, string> = {
  manual: "Nhập thủ công",
  from_receipts: "Từ hàng đã nhận",
};

export const MIXED_SUPPLIER_MESSAGE =
  "Một hóa đơn chỉ có thể được tạo từ các ngày hàng về của cùng một nhà cung cấp.";

export const DAY_ALREADY_INVOICED_MESSAGE =
  "Một hoặc nhiều ngày hàng về vừa được sử dụng để lập hóa đơn khác. Vui lòng tải lại dữ liệu.";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Trim, validate (YYYY-MM-DD, a real calendar date), de-duplicate and sort
// ascending. Returns null if any entry is invalid — callers reject the whole
// request rather than silently dropping a date the user picked.
// The DB function normalizes again on its own; this is for the app-side
// checks and for receipt_start_date = first element.
export function normalizeReceiptDates(dates: readonly string[]): string[] | null {
  const cleaned = dates.map((d) => d.trim());
  if (cleaned.some((d) => !isRealIsoDate(d))) return null;
  return [...new Set(cleaned)].sort();
}

// Custom SQLSTATEs raised by migration 00034 (create_invoice_from_receipts,
// update_invoice_from_receipts_header, the receipt edit-lock triggers).
// Never surface a raw constraint/DB error to the user.
export function fromReceiptsErrorMessage(code: string | undefined, dbMessage?: string): string {
  switch (code) {
    case "HD001":
      return DAY_ALREADY_INVOICED_MESSAGE;
    case "HD002":
      return "Dữ liệu hàng về của các ngày đã chọn vừa thay đổi. Vui lòng tải lại và kiểm tra lại hóa đơn.";
    case "HD003":
      return "Số hóa đơn này đã tồn tại cho nhà cung cấp đã chọn.";
    case "HD004":
    case "HD005":
    case "HD006":
    case "HD007":
    case "HD010":
      // Messages written for end users inside the SQL function itself (they
      // carry the offending date / invoice number).
      return dbMessage || "Không thể lưu hóa đơn. Vui lòng thử lại.";
    case "HD008":
      return "Số liệu chiết khấu/VAT không hợp lệ. Vui lòng kiểm tra lại.";
    case "HD009":
      return "Hóa đơn tạo từ hàng đã nhận chỉ được sửa số HĐ, ngày HĐ, ghi chú và chiết khấu/VAT.";
    default:
      return "Không thể lưu hóa đơn. Vui lòng thử lại.";
  }
}

// Receipt create/edit blocked by the linked-day triggers (HD010) — the DB
// message already reads "Ngày hàng về này đã được sử dụng để lập hóa đơn X.
// Không thể thay đổi dữ liệu hàng về trực tiếp."
export function isReceiptDayLockedError(code: string | undefined): boolean {
  return code === "HD010";
}
