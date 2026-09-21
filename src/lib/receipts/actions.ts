"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { canCreateReceipts, canEditReceipts, getCurrentRole } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";

const FORBIDDEN_MESSAGE = "Bạn không có quyền thực hiện thao tác này.";

export type SupplierProduct = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  current_price: number;
};

export async function getSupplierProducts(
  supplierId: string
): Promise<{ status: "success"; data: SupplierProduct[] } | { status: "error"; message: string }> {
  if (!supplierId) {
    return { status: "success", data: [] };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("products")
    .select("id, sku, name, unit, current_price")
    .eq("supplier_id", supplierId)
    .eq("is_active", true)
    .order("sku", { ascending: true });

  if (error) {
    return { status: "error", message: "Không thể tải danh sách sản phẩm." };
  }

  return { status: "success", data: data as SupplierProduct[] };
}

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

// Shared by create and update: the chosen supplier must be active, and every
// item's product must exist, belong to that supplier, and be active. This is
// the server-side re-validation required even though the UI already limits
// the pickers — a request could otherwise submit a stale/tampered selection
// (e.g. a supplier changed to inactive between page load and submit).
async function validateSupplierAndItems(
  supabase: ReturnType<typeof createAdminClient>,
  supplierId: string,
  items: { productId: string }[]
): Promise<string | null> {
  const { data: supplier, error: supplierError } = await supabase
    .from("suppliers")
    .select("id, is_active")
    .eq("id", supplierId)
    .maybeSingle();

  if (supplierError || !supplier) {
    return "Nhà cung cấp không tồn tại.";
  }
  if (!supplier.is_active) {
    return "Nhà cung cấp này đã ngừng hoạt động.";
  }

  const productIds = items.map((i) => i.productId);
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, supplier_id, is_active")
    .in("id", productIds);

  if (productsError || !products || products.length !== productIds.length) {
    return "Có sản phẩm không tồn tại trong hệ thống.";
  }
  const invalidProduct = products.find((p) => p.supplier_id !== supplierId || !p.is_active);
  if (invalidProduct) {
    return "Có sản phẩm không thuộc nhà cung cấp đã chọn hoặc đã ngừng kinh doanh.";
  }
  return null;
}

export async function createReceipt(
  _prevState: ReceiptFormState,
  payload: ReceiptFormPayload
): Promise<ReceiptFormState> {
  if (!canCreateReceipts(getCurrentRole())) {
    return { status: "error", message: FORBIDDEN_MESSAGE };
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
    p_created_by: null,
    p_items: parsed.data.items.map((i) => ({
      product_id: i.productId,
      unit_price: i.unitPrice,
      delivered_qty: i.deliveredQty,
      received_qty: i.receivedQty,
    })),
  });

  if (error || !data || data.length === 0) {
    return {
      status: "error",
      message: "Không thể lưu phiếu nhập. Vui lòng thử lại.",
    };
  }

  const result = data[0] as { receipt_id: string; receipt_no: string };
  revalidatePath("/receipts");
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
  if (!canEditReceipts(getCurrentRole())) {
    return { status: "error", message: FORBIDDEN_MESSAGE };
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
    .select("receipt_date, supplier_id")
    .eq("id", receiptId)
    .maybeSingle();
  if (!original) {
    return { status: "error", message: "Không tìm thấy phiếu nhập." };
  }

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

  return {
    status: "success",
    message: `Đã lưu thay đổi phiếu ${result.receipt_no}.`,
    receipt: { id: result.receipt_id, receiptNo: result.receipt_no },
  };
}
