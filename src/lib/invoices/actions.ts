"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { validateSupplierAndItems } from "@/lib/products/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { calculateInvoiceFinancials, type SupplierType } from "@/lib/invoices/financials";
import { triggerOutstandingAlertCheck } from "@/lib/notifications/outstanding-alert";
import { fromReceiptsErrorMessage } from "@/lib/invoices/receipt-days";


// Same rationale as receipts: seed ids aren't RFC-4122-version-compliant, so
// zod's strict `.uuid()` rejects them. Match the general shape and let FK
// constraints be the authority on existence.
const uuidLike = (message: string) =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);

const invoiceItemSchema = z.object({
  // Present + a real id => this row already exists on the invoice (update in
  // place). Absent => a new row added during this edit. Only used by
  // updateInvoice; createInvoice ignores it since nothing exists yet.
  id: uuidLike("ID dòng hàng không hợp lệ.").optional(),
  productId: uuidLike("Sản phẩm không hợp lệ."),
  unitPrice: z.coerce.number({ error: "Đơn giá phải là số." }).min(0, "Đơn giá phải >= 0."),
  quantity: z.coerce
    .number({ error: "SL hóa đơn phải là số." })
    .gt(0, "SL hóa đơn phải > 0."),
});

const invoiceSchema = z.object({
  supplierId: uuidLike("Vui lòng chọn nhà cung cấp."),
  invoiceNo: z.string().trim().min(1, "Số hóa đơn là bắt buộc.").max(100, "Số hóa đơn tối đa 100 ký tự."),
  invoiceDate: z.string().min(1, "Vui lòng chọn ngày hóa đơn."),
  note: z.string().trim().max(1000).optional(),
  // Financial inputs only — the client never sends (and this schema never
  // accepts) subtotal/discount_amount/vat_amount/final_amount. Those are
  // always derived server-side by calculateInvoiceFinancials below.
  discountType: z.enum(["percent", "fixed_amount"]).nullable().optional(),
  discountValue: z.coerce.number().nullable().optional(),
  vatRate: z.coerce.number().nullable().optional(),
  items: z
    .array(invoiceItemSchema)
    .min(1, "Hóa đơn phải có ít nhất 1 sản phẩm.")
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
      message: "Không được trùng sản phẩm trong cùng một hóa đơn.",
    }),
});

export type InvoiceFormPayload = z.input<typeof invoiceSchema>;

export type InvoiceFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  invoice?: { id: string; invoiceNo: string };
};

type InvoiceParsed = z.infer<typeof invoiceSchema>;

// Shared by createInvoice and updateInvoice: validate the payload, re-check
// supplier/items server-side, and compute the authoritative financial
// snapshot from the supplier's CURRENT supplier_type (never trusted from
// client input) via calculateInvoiceFinancials — the single formula owner.
async function resolveInvoiceFinancials(
  supabase: ReturnType<typeof createAdminClient>,
  payload: InvoiceFormPayload
): Promise<
  | { ok: false; state: InvoiceFormState }
  | { ok: true; parsed: InvoiceParsed; financials: ReturnType<typeof calculateInvoiceFinancials> & { ok: true } }
> {
  const parsed = invoiceSchema.safeParse(payload);
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    return {
      ok: false,
      state: {
        status: "error",
        message: flattened.formErrors[0] ?? "Vui lòng kiểm tra lại thông tin.",
        fieldErrors: flattened.fieldErrors as Record<string, string[]>,
      },
    };
  }

  const validationError = await validateSupplierAndItems(
    supabase,
    parsed.data.supplierId,
    parsed.data.items
  );
  if (validationError) {
    return { ok: false, state: { status: "error", message: validationError } };
  }

  // supplier_type is the source of truth for which financial rules apply —
  // always read fresh from the DB, never trusted from client input.
  const { data: supplierRow, error: supplierError } = await supabase
    .from("suppliers")
    .select("supplier_type")
    .eq("id", parsed.data.supplierId)
    .maybeSingle();
  if (supplierError || !supplierRow) {
    return { ok: false, state: { status: "error", message: "Nhà cung cấp không tồn tại." } };
  }

  const financials = calculateInvoiceFinancials({
    supplierType: supplierRow.supplier_type as SupplierType,
    items: parsed.data.items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice })),
    discountType: parsed.data.discountType ?? null,
    discountValue: parsed.data.discountValue ?? null,
    vatRate: parsed.data.vatRate ?? null,
  });
  if (!financials.ok) {
    return {
      ok: false,
      state: {
        status: "error",
        message: financials.error,
        fieldErrors: financials.field ? { [financials.field]: [financials.error] } : undefined,
      },
    };
  }

  return { ok: true, parsed: parsed.data, financials };
}

export async function createInvoice(
  _prevState: InvoiceFormState,
  payload: InvoiceFormPayload
): Promise<InvoiceFormState> {
  const authz = await authorizeAction("invoice:create");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const supabase = createAdminClient();

  const resolved = await resolveInvoiceFinancials(supabase, payload);
  if (!resolved.ok) return resolved.state;
  const { parsed, financials } = resolved;

  const { data, error } = await supabase.rpc("create_invoice", {
    p_supplier_id: parsed.supplierId,
    p_invoice_no: parsed.invoiceNo,
    p_invoice_date: parsed.invoiceDate,
    p_note: parsed.note || null,
    // Audit: always the signed-in user from the server session, never client input.
    p_created_by: authz.auth.user.id,
    p_items: parsed.items.map((i) => ({
      product_id: i.productId,
      unit_price: i.unitPrice,
      quantity: i.quantity,
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
    if (error.code === "23505") {
      return {
        status: "error",
        message: "Số hóa đơn này đã tồn tại cho nhà cung cấp đã chọn.",
        fieldErrors: { invoiceNo: ["Số hóa đơn đã tồn tại cho nhà cung cấp này."] },
      };
    }
    return {
      status: "error",
      message: "Không thể lưu hóa đơn. Vui lòng thử lại.",
    };
  }
  if (!data || data.length === 0) {
    return {
      status: "error",
      message: "Không thể lưu hóa đơn. Vui lòng thử lại.",
    };
  }

  const result = data[0] as { invoice_id: string; invoice_no: string };
  revalidatePath("/invoices");

  // ZL4: a brand-new invoice_item can already be born into "low"/"need_makeup"
  // (e.g. its own invoice_qty is under the threshold, or receipts for this
  // supplier+SKU already exist as of the invoice date) — evaluate it right
  // away, same as after a receipt.
  await triggerOutstandingAlertCheck({
    supplierIds: [parsed.supplierId],
    productIds: parsed.items.map((i) => i.productId),
  });

  return {
    status: "success",
    message: `Đã lưu hóa đơn ${result.invoice_no}.`,
    invoice: { id: result.invoice_id, invoiceNo: result.invoice_no },
  };
}

export async function updateInvoice(
  invoiceId: string,
  _prevState: InvoiceFormState,
  payload: InvoiceFormPayload
): Promise<InvoiceFormState> {
  const authz = await authorizeAction("invoice:edit");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const supabase = createAdminClient();

  const { data: original } = await supabase
    .from("invoices")
    .select("id, supplier_id, source_type, invoice_items(product_id)")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!original) {
    return { status: "error", message: "Không tìm thấy hóa đơn." };
  }
  if (original.source_type === "from_receipts") {
    return updateFromReceiptsInvoiceHeader(supabase, invoiceId, payload);
  }
  const originalProductIds = (original.invoice_items as { product_id: string }[]).map((i) => i.product_id);

  // Re-derives the full snapshot from scratch every time, using whatever
  // supplier_type the (possibly just-changed) supplier currently has — this
  // is intentional and correct: an edit that keeps the same supplier just
  // reproduces the same numbers, and an edit that switches supplier is
  // exactly when the policy SHOULD change. What must never happen is the
  // opposite: an edit that touches unrelated fields silently drifting an
  // untouched invoice's old snapshot — that can't happen here because the
  // client always re-sends its current discountType/discountValue/vatRate
  // (pre-filled from the existing snapshot by the edit form), never omits
  // them expecting a stale value to persist.
  const resolved = await resolveInvoiceFinancials(supabase, payload);
  if (!resolved.ok) return resolved.state;
  const { parsed, financials } = resolved;

  const { data, error } = await supabase.rpc("update_invoice", {
    p_invoice_id: invoiceId,
    p_supplier_id: parsed.supplierId,
    p_invoice_no: parsed.invoiceNo,
    p_invoice_date: parsed.invoiceDate,
    p_note: parsed.note || null,
    p_items: parsed.items.map((i) => ({
      id: i.id ?? null,
      product_id: i.productId,
      unit_price: i.unitPrice,
      quantity: i.quantity,
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
    if (error.code === "23505") {
      return {
        status: "error",
        message: "Số hóa đơn này đã tồn tại cho nhà cung cấp đã chọn.",
        fieldErrors: { invoiceNo: ["Số hóa đơn đã tồn tại cho nhà cung cấp này."] },
      };
    }
    return {
      status: "error",
      message: "Không thể lưu thay đổi. Vui lòng thử lại.",
    };
  }
  if (!data || data.length === 0) {
    return {
      status: "error",
      message: "Không thể lưu thay đổi. Vui lòng thử lại.",
    };
  }

  const result = data[0] as { invoice_id: string; invoice_no: string };
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);

  // ZL4: evaluate both the OLD supplier/products and the NEW ones — same
  // union rationale as updateReceipt (an edit can move a SKU/supplier off
  // this invoice, which can itself change some OTHER invoice_item's
  // received_qty allocation... in practice v_outstanding is keyed per
  // invoice_item so this mainly re-checks the edited invoice's own rows,
  // but the old-side union costs nothing and stays consistent).
  await triggerOutstandingAlertCheck({
    supplierIds: [...new Set([original.supplier_id, parsed.supplierId])],
    productIds: [...new Set([...originalProductIds, ...parsed.items.map((i) => i.productId)])],
  });

  return {
    status: "success",
    message: `Đã lưu thay đổi hóa đơn ${result.invoice_no}.`,
    invoice: { id: result.invoice_id, invoiceNo: result.invoice_no },
  };
}

// PHASE INV-FROM-RECEIPTS: a from_receipts invoice may only change its
// header (số HĐ, ngày HĐ, ghi chú) and discount/VAT. Supplier, linked
// receipt days and items are fixed — whatever supplierId/items the client
// sends is ignored; financials are recomputed from the invoice's own stored
// items and the supplier's current supplier_type (same rule as the manual
// edit path).
const fromReceiptsHeaderSchema = invoiceSchema.pick({
  invoiceNo: true,
  invoiceDate: true,
  note: true,
  discountType: true,
  discountValue: true,
  vatRate: true,
});

async function updateFromReceiptsInvoiceHeader(
  supabase: ReturnType<typeof createAdminClient>,
  invoiceId: string,
  payload: InvoiceFormPayload
): Promise<InvoiceFormState> {
  const parsed = fromReceiptsHeaderSchema.safeParse(payload);
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    return {
      status: "error",
      message: flattened.formErrors[0] ?? "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: flattened.fieldErrors as Record<string, string[]>,
    };
  }

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, suppliers(supplier_type), invoice_items(quantity, unit_price)")
    .eq("id", invoiceId)
    .maybeSingle();
  const row = invoice as unknown as {
    suppliers: { supplier_type: SupplierType } | null;
    invoice_items: { quantity: number; unit_price: number }[];
  } | null;
  if (!row?.suppliers) {
    return { status: "error", message: "Không tìm thấy hóa đơn." };
  }

  const financials = calculateInvoiceFinancials({
    supplierType: row.suppliers.supplier_type,
    items: row.invoice_items.map((i) => ({ quantity: Number(i.quantity), unitPrice: Number(i.unit_price) })),
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

  const { data, error } = await supabase.rpc("update_invoice_from_receipts_header", {
    p_invoice_id: invoiceId,
    p_invoice_no: parsed.data.invoiceNo,
    p_invoice_date: parsed.data.invoiceDate,
    p_note: parsed.data.note || null,
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
    return error.code === "HD003"
      ? { status: "error", message, fieldErrors: { invoiceNo: ["Số hóa đơn đã tồn tại cho nhà cung cấp này."] } }
      : { status: "error", message };
  }
  if (!data || data.length === 0) {
    return { status: "error", message: "Không thể lưu thay đổi. Vui lòng thử lại." };
  }

  const result = data[0] as { invoice_id: string; invoice_no: string };
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/receipts");

  // No ZL4 evaluation: quantities are untouched by a header edit, so no
  // outstanding status can change.

  return {
    status: "success",
    message: `Đã lưu thay đổi hóa đơn ${result.invoice_no}.`,
    invoice: { id: result.invoice_id, invoiceNo: result.invoice_no },
  };
}
