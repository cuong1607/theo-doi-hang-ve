"use server";

import { z } from "zod";

import { canCreateReceipts, getCurrentRole } from "@/lib/auth/role";
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

export type CreateReceiptPayload = z.input<typeof receiptSchema>;

export type CreateReceiptState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  receipt?: { id: string; receiptNo: string };
};

export async function createReceipt(
  _prevState: CreateReceiptState,
  payload: CreateReceiptPayload
): Promise<CreateReceiptState> {
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

  const { data: supplier, error: supplierError } = await supabase
    .from("suppliers")
    .select("id, is_active")
    .eq("id", parsed.data.supplierId)
    .maybeSingle();

  if (supplierError || !supplier) {
    return { status: "error", message: "Nhà cung cấp không tồn tại." };
  }
  if (!supplier.is_active) {
    return { status: "error", message: "Nhà cung cấp này đã ngừng hoạt động." };
  }

  const productIds = parsed.data.items.map((i) => i.productId);
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, supplier_id, is_active")
    .in("id", productIds);

  if (productsError || !products || products.length !== productIds.length) {
    return { status: "error", message: "Có sản phẩm không tồn tại trong hệ thống." };
  }
  const invalidProduct = products.find(
    (p) => p.supplier_id !== parsed.data.supplierId || !p.is_active
  );
  if (invalidProduct) {
    return {
      status: "error",
      message: "Có sản phẩm không thuộc nhà cung cấp đã chọn hoặc đã ngừng kinh doanh.",
    };
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
  return {
    status: "success",
    message: `Đã lưu phiếu nhập ${result.receipt_no}.`,
    receipt: { id: result.receipt_id, receiptNo: result.receipt_no },
  };
}
