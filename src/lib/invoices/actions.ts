"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { canCreateInvoices, getCurrentRole } from "@/lib/auth/role";
import { validateSupplierAndItems } from "@/lib/products/queries";
import { createAdminClient } from "@/lib/supabase/admin";

const FORBIDDEN_MESSAGE = "Bạn không có quyền thực hiện thao tác này.";

// Same rationale as receipts: seed ids aren't RFC-4122-version-compliant, so
// zod's strict `.uuid()` rejects them. Match the general shape and let FK
// constraints be the authority on existence.
const uuidLike = (message: string) =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);

const invoiceItemSchema = z.object({
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

export async function createInvoice(
  _prevState: InvoiceFormState,
  payload: InvoiceFormPayload
): Promise<InvoiceFormState> {
  if (!canCreateInvoices(getCurrentRole())) {
    return { status: "error", message: FORBIDDEN_MESSAGE };
  }

  const parsed = invoiceSchema.safeParse(payload);
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

  const { data, error } = await supabase.rpc("create_invoice", {
    p_supplier_id: parsed.data.supplierId,
    p_invoice_no: parsed.data.invoiceNo,
    p_invoice_date: parsed.data.invoiceDate,
    p_note: parsed.data.note || null,
    p_created_by: null,
    p_items: parsed.data.items.map((i) => ({
      product_id: i.productId,
      unit_price: i.unitPrice,
      quantity: i.quantity,
    })),
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
  return {
    status: "success",
    message: `Đã lưu hóa đơn ${result.invoice_no}.`,
    invoice: { id: result.invoice_id, invoiceNo: result.invoice_no },
  };
}
