"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { calculateInvoiceFinancials } from "@/lib/invoices/financials";
import { loadReceiptInvoiceDraft, type ReceiptInvoiceDraft } from "@/lib/invoices/from-receipts";
import { fromReceiptsErrorMessage, normalizeReceiptDates } from "@/lib/invoices/receipt-days";


// Same uuid-shape rationale as invoices/actions.ts (seed ids aren't
// RFC-4122-version-compliant).
const uuidLike = (message: string) =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);

const selectionSchema = z.object({
  supplierId: uuidLike("Nhà cung cấp không hợp lệ."),
  receiptDates: z.array(z.string()).min(1, "Vui lòng chọn ít nhất 1 ngày hàng về.").max(366),
});

// Only the selection + header + financial INPUTS. No items, no subtotal/
// discount_amount/vat_amount/final_amount, no supplier_type: the server
// reloads the receipts and the supplier and derives all of those itself.
const createSchema = selectionSchema.extend({
  invoiceNo: z.string().trim().min(1, "Số hóa đơn là bắt buộc.").max(100, "Số hóa đơn tối đa 100 ký tự."),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Vui lòng chọn ngày lập hóa đơn."),
  note: z.string().trim().max(1000).optional(),
  discountType: z.enum(["percent", "fixed_amount"]).nullable().optional(),
  discountValue: z.coerce.number().nullable().optional(),
  vatRate: z.coerce.number().nullable().optional(),
});

export type ReceiptInvoiceSelection = z.input<typeof selectionSchema>;
export type CreateInvoiceFromReceiptsPayload = z.input<typeof createSchema>;

export type ReceiptInvoicePreviewResult =
  | { status: "success"; draft: ReceiptInvoiceDraft }
  | { status: "error"; message: string };

export type CreateInvoiceFromReceiptsState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  // true when the selection itself went stale (days linked elsewhere /
  // receipts changed) — the UI then asks the user to reload.
  stale?: boolean;
  invoice?: { id: string; invoiceNo: string };
};

function parseSelection(input: ReceiptInvoiceSelection) {
  const parsed = selectionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, message: z.flattenError(parsed.error).formErrors[0] ?? "Lựa chọn không hợp lệ." };
  }
  const dates = normalizeReceiptDates(parsed.data.receiptDates);
  if (!dates || dates.length === 0) {
    return { ok: false as const, message: "Ngày hàng về không hợp lệ." };
  }
  return { ok: true as const, supplierId: parsed.data.supplierId, dates };
}

// Modal preview: server-side load of the selected days' receipt lines,
// grouped by product + unit_price. Read-only.
export async function getReceiptInvoicePreview(
  input: ReceiptInvoiceSelection
): Promise<ReceiptInvoicePreviewResult> {
  const authz = await authorizeAction("invoice:create");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }
  const selection = parseSelection(input);
  if (!selection.ok) return { status: "error", message: selection.message };

  const result = await loadReceiptInvoiceDraft(createAdminClient(), selection.supplierId, selection.dates);
  return result.ok ? { status: "success", draft: result.draft } : { status: "error", message: result.error };
}

export async function createInvoiceFromReceiptDays(
  _prevState: CreateInvoiceFromReceiptsState,
  payload: CreateInvoiceFromReceiptsPayload
): Promise<CreateInvoiceFromReceiptsState> {
  const authz = await authorizeAction("invoice:create");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    return {
      status: "error",
      message: flattened.formErrors[0] ?? "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: flattened.fieldErrors as Record<string, string[]>,
    };
  }
  const dates = normalizeReceiptDates(parsed.data.receiptDates);
  if (!dates || dates.length === 0) {
    return { status: "error", message: "Ngày hàng về không hợp lệ." };
  }

  const supabase = createAdminClient();

  const loaded = await loadReceiptInvoiceDraft(supabase, parsed.data.supplierId, dates);
  if (!loaded.ok) {
    return { status: "error", message: loaded.error, stale: true };
  }
  const { draft } = loaded;

  // supplier_type comes from the freshly loaded supplier row — never from
  // the client. Same single formula owner as the manual flow.
  const financials = calculateInvoiceFinancials({
    supplierType: draft.supplier.supplier_type,
    items: draft.lines.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unit_price) })),
    discountType: parsed.data.discountType ?? null,
    discountValue: parsed.data.discountValue ?? null,
    vatRate: parsed.data.vatRate ?? null,
  });
  if (!financials.ok) {
    return {
      status: "error",
      message: financials.error,
      fieldErrors: financials.field ? { [financials.field]: [financials.error] } : undefined,
    };
  }

  const { data, error } = await supabase.rpc("create_invoice_from_receipts", {
    p_supplier_id: draft.supplier.id,
    p_receipt_dates: draft.receiptDates,
    p_invoice_no: parsed.data.invoiceNo,
    p_invoice_date: parsed.data.invoiceDate,
    p_note: parsed.data.note || null,
    // Audit: always the signed-in user from the server session, never client input.
    p_created_by: authz.auth.user.id,
    p_items: draft.lines.map((l) => ({
      product_id: l.product_id,
      unit_price: l.unit_price,
      quantity: l.quantity,
    })),
    p_subtotal: financials.data.subtotal,
    p_discount_type: financials.data.discountType,
    p_discount_value: financials.data.discountValue,
    p_discount_amount: financials.data.discountAmount,
    p_vat_rate: financials.data.vatRate,
    p_vat_amount: financials.data.vatAmount,
    p_final_amount: financials.data.finalAmount,
  });

  if (error) {
    const message = fromReceiptsErrorMessage(error.code, error.message);
    if (error.code === "HD003") {
      return { status: "error", message, fieldErrors: { invoiceNo: ["Số hóa đơn đã tồn tại cho nhà cung cấp này."] } };
    }
    return { status: "error", message, stale: ["HD001", "HD002", "HD004", "HD005"].includes(error.code) };
  }
  if (!data || data.length === 0) {
    return { status: "error", message: "Không thể lưu hóa đơn. Vui lòng thử lại." };
  }

  const result = data[0] as { invoice_id: string; invoice_no: string };

  revalidatePath("/invoices");
  revalidatePath("/receipts");
  revalidatePath("/outstanding");
  for (const date of draft.receiptDates) {
    revalidatePath(`/receipts/daily/${date}/${draft.supplier.id}`);
  }

  // No ZL4 low-stock evaluation here: every line of a from_receipts invoice
  // is born fully received (remaining_qty = 0, status "complete"), which is
  // not an alert state, and manual invoices' numbers are unaffected.

  return {
    status: "success",
    message: `Đã tạo hóa đơn ${result.invoice_no} từ ${draft.receiptDates.length} ngày hàng về.`,
    invoice: { id: result.invoice_id, invoiceNo: result.invoice_no },
  };
}
