"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { getSupplierProducts, type SupplierProduct } from "@/lib/products/actions";
import { validateSupplierAndItems } from "@/lib/products/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerOutstandingAlertCheck } from "@/lib/notifications/outstanding-alert";
import { isReceiptDayLockedError } from "@/lib/invoices/receipt-days";


// Re-exported for existing imports (receipt-form.tsx, receipt-item-row.tsx).
// getSupplierProducts must originate from a "use server" file (see
// @/lib/products/actions) since these components call it directly — a plain
// re-export here preserves that server-action reference correctly.
export { getSupplierProducts, type SupplierProduct };

// Some seed rows use hand-picked ids (e.g. a0000000-0000-0000-0000-000000000001)
// that are valid Postgres uuid values but not RFC-4122-version-compliant, so
// zod's strict `.uuid()` format check rejects them. Match the general
// 8-4-4-4-12 hex shape instead and let the database (FK constraints) be the
// authority on whether the id actually exists.
const uuidLike = (message: string) =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);

const receiptItemSchema = z.object({
  // Present + a real id => this row already exists on the receipt (update in
  // place). Absent => a new row added during this edit (insert). Used only
  // by updateReceipt; createReceipt ignores it since nothing exists yet.
  id: uuidLike("ID dòng hàng không hợp lệ.").optional(),
  productId: uuidLike("Sản phẩm không hợp lệ."),
  unitPrice: z.coerce.number({ error: "Đơn giá phải là số." }).min(0, "Đơn giá phải >= 0."),
  deliveredQty: z.coerce
    .number({ error: "SL giao phải là số." })
    .min(0, "SL giao phải >= 0."),
  receivedQty: z.coerce
    .number({ error: "SL nhận phải là số." })
    .min(0, "SL nhận phải >= 0."),
});

const receiptSchema = z.object({
  receiptDate: z.string().min(1, "Vui lòng chọn ngày nhận."),
  shift: z.enum(["morning", "afternoon"], { error: "Vui lòng chọn ca." }),
  supplierId: uuidLike("Vui lòng chọn nhà cung cấp."),
  receiverName: z.string().trim().min(1, "Người nhận là bắt buộc.").max(255),
  note: z.string().trim().max(1000).optional(),
  items: z
    .array(receiptItemSchema)
    .min(1, "Phiếu nhập phải có ít nhất 1 sản phẩm.")
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
      message: "Không được trùng sản phẩm trong cùng một phiếu.",
    }),
});

export type ReceiptFormPayload = z.input<typeof receiptSchema>;

export type ReceiptFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  receipt?: { id: string; receiptNo: string };
};

export async function createReceipt(
  _prevState: ReceiptFormState,
  payload: ReceiptFormPayload
): Promise<ReceiptFormState> {
  const authz = await authorizeAction("receipt:create");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const parsed = receiptSchema.safeParse(payload);
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    return {
      status: "error",
      message: flattened.formErrors[0] ?? "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: flattened.fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = createAdminClient();

  const validationError = await validateSupplierAndItems(
    supabase,
    parsed.data.supplierId,
    parsed.data.items
  );
  if (validationError) {
    return { status: "error", message: validationError };
  }

  const { data, error } = await supabase.rpc("create_receipt", {
    p_receipt_date: parsed.data.receiptDate,
    p_shift: parsed.data.shift,
    p_supplier_id: parsed.data.supplierId,
    p_receiver_name: parsed.data.receiverName,
    p_note: parsed.data.note || null,
    // Audit: always the signed-in user from the server session, never client input.
    p_created_by: authz.auth.user.id,
    p_items: parsed.data.items.map((i) => ({
      product_id: i.productId,
      unit_price: i.unitPrice,
      delivered_qty: i.deliveredQty,
      received_qty: i.receivedQty,
    })),
  });

  if (error && isReceiptDayLockedError(error.code)) {
    // Edit-lock trigger (migration 00034): the day is linked to a
    // from_receipts invoice. The DB message names the invoice.
    return { status: "error", message: error.message };
  }
  if (error || !data || data.length === 0) {
    return {
      status: "error",
      message: "Không thể lưu phiếu nhập. Vui lòng thử lại.",
    };
  }

  const result = data[0] as { receipt_id: string; receipt_no: string };
  revalidatePath("/receipts");

  // ZL4: a new receipt can push any of its SKUs' outstanding status down
  // (e.g. a supplier+SKU combo now has enough received_qty to cross into
  // "low"/"need_makeup") — re-evaluate after the receipt is durably saved,
  // never before (and never blocking this action's own success).
  await triggerOutstandingAlertCheck({
    supplierIds: [parsed.data.supplierId],
    productIds: parsed.data.items.map((i) => i.productId),
  });

  return {
    status: "success",
    message: `Đã lưu phiếu nhập ${result.receipt_no}.`,
    receipt: { id: result.receipt_id, receiptNo: result.receipt_no },
  };
}

export async function updateReceipt(
  receiptId: string,
  _prevState: ReceiptFormState,
  payload: ReceiptFormPayload
): Promise<ReceiptFormState> {
  const authz = await authorizeAction("receipt:edit");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const parsed = receiptSchema.safeParse(payload);
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    return {
      status: "error",
      message: flattened.formErrors[0] ?? "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: flattened.fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = createAdminClient();

  const { data: original } = await supabase
    .from("receipts")
    .select("receipt_date, supplier_id, receipt_items(product_id)")
    .eq("id", receiptId)
    .maybeSingle();
  if (!original) {
    return { status: "error", message: "Không tìm thấy phiếu nhập." };
  }
  const originalProductIds = (original.receipt_items as { product_id: string }[]).map((i) => i.product_id);

  const validationError = await validateSupplierAndItems(
    supabase,
    parsed.data.supplierId,
    parsed.data.items
  );
  if (validationError) {
    return { status: "error", message: validationError };
  }

  const { data, error } = await supabase.rpc("update_receipt", {
    p_receipt_id: receiptId,
    p_receipt_date: parsed.data.receiptDate,
    p_shift: parsed.data.shift,
    p_supplier_id: parsed.data.supplierId,
    p_receiver_name: parsed.data.receiverName,
    p_note: parsed.data.note || null,
    p_items: parsed.data.items.map((i) => ({
      id: i.id ?? null,
      product_id: i.productId,
      unit_price: i.unitPrice,
      delivered_qty: i.deliveredQty,
      received_qty: i.receivedQty,
    })),
  });

  if (error && isReceiptDayLockedError(error.code)) {
    // The trigger checks BOTH the old and the new supplier/date.
    return { status: "error", message: error.message };
  }
  if (error || !data || data.length === 0) {
    return {
      status: "error",
      message: "Không thể lưu thay đổi. Vui lòng thử lại.",
    };
  }

  const result = data[0] as { receipt_id: string; receipt_no: string };

  // Daily summaries are computed live from receipts/receipt_items (no cached
  // totals table), so they reflect the edit automatically on next read. The
  // revalidatePath calls below only bust Next's client-side router cache for
  // pages the user may already have open — both the old date+supplier (in
  // case date/supplier changed) and the new one need a poke.
  revalidatePath("/receipts");
  revalidatePath(`/receipts/${receiptId}`);
  revalidatePath(`/receipts/daily/${original.receipt_date}/${original.supplier_id}`);
  if (
    original.receipt_date !== parsed.data.receiptDate ||
    original.supplier_id !== parsed.data.supplierId
  ) {
    revalidatePath(`/receipts/daily/${parsed.data.receiptDate}/${parsed.data.supplierId}`);
  }

  // ZL4: evaluate both the OLD supplier/products (in case the edit moved
  // this receipt to a different supplier/date and some SKUs' received_qty
  // just went DOWN) and the NEW ones — a plain union, since
  // evaluateOutstandingNotifications() itself is a no-op for any SKU whose
  // status didn't actually change.
  await triggerOutstandingAlertCheck({
    supplierIds: [...new Set([original.supplier_id, parsed.data.supplierId])],
    productIds: [...new Set([...originalProductIds, ...parsed.data.items.map((i) => i.productId)])],
  });

  return {
    status: "success",
    message: `Đã lưu thay đổi phiếu ${result.receipt_no}.`,
    receipt: { id: result.receipt_id, receiptNo: result.receipt_no },
  };
}
