"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InvoiceDebtRow } from "@/lib/debt/invoice-debt";


// Same rationale as receipts/invoices: seed ids aren't RFC-4122-version-
// compliant, so zod's strict `.uuid()` rejects them. Match the general
// shape and let FK constraints be the authority on existence.
const uuidLike = (message: string) =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);

const paymentSchema = z.object({
  supplierId: uuidLike("Vui lòng chọn nhà cung cấp."),
  paymentDate: z.string().min(1, "Vui lòng chọn ngày thanh toán."),
  note: z.string().trim().max(1000).optional(),
  invoiceIds: z
    .array(uuidLike("Hóa đơn không hợp lệ."))
    .min(1, "Vui lòng chọn ít nhất 1 hóa đơn để thanh toán.")
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Danh sách hóa đơn bị trùng.",
    }),
});

export type PaymentFormPayload = z.input<typeof paymentSchema>;

export type PaymentFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  payment?: { id: string; totalAmount: number; invoiceCount: number };
};

// The amount charged to each invoice is always its CURRENT remaining_amount
// re-read from the database here — never a value the client sent. This
// phase only supports full payment of each selected invoice's debt (no
// partial-amount input yet), and re-reading also closes the gap between
// "when the user opened the confirm dialog" and "when they clicked confirm"
// (e.g. another payment landed in between).
export async function createPayment(
  _prevState: PaymentFormState,
  payload: PaymentFormPayload
): Promise<PaymentFormState> {
  const authz = await authorizeAction("payment:create");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const parsed = paymentSchema.safeParse(payload);
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    return {
      status: "error",
      message: flattened.formErrors[0] ?? "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: flattened.fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = createAdminClient();

  const { data: debtRows, error: debtError } = await supabase
    .from("v_invoice_debt")
    .select("*")
    .in("invoice_id", parsed.data.invoiceIds);

  if (debtError) {
    return { status: "error", message: "Không thể tải dữ liệu công nợ. Vui lòng thử lại." };
  }

  const rows = (debtRows ?? []) as InvoiceDebtRow[];

  if (rows.length !== parsed.data.invoiceIds.length) {
    return { status: "error", message: "Một hoặc nhiều hóa đơn không còn tồn tại. Vui lòng tải lại trang." };
  }

  const wrongSupplier = rows.find((r) => r.supplier_id !== parsed.data.supplierId);
  if (wrongSupplier) {
    return {
      status: "error",
      message: "Tất cả hóa đơn trong một lần thanh toán phải thuộc cùng một nhà cung cấp.",
    };
  }

  const alreadyPaid = rows.find((r) => r.remaining_amount <= 0);
  if (alreadyPaid) {
    return {
      status: "error",
      message: `Hóa đơn ${alreadyPaid.invoice_no} đã được thanh toán đủ, không thể chọn lại.`,
    };
  }

  const items = rows.map((r) => ({ invoice_id: r.invoice_id, amount: r.remaining_amount }));
  const totalAmount = items.reduce((sum, i) => sum + i.amount, 0);

  if (totalAmount <= 0) {
    return { status: "error", message: "Tổng số tiền thanh toán phải lớn hơn 0." };
  }

  const { data, error } = await supabase.rpc("create_payment", {
    p_supplier_id: parsed.data.supplierId,
    p_payment_date: parsed.data.paymentDate,
    p_note: parsed.data.note || null,
    // Audit: always the signed-in user from the server session, never client input.
    p_created_by: authz.auth.user.id,
    p_items: items,
  });

  if (error || !data || data.length === 0) {
    return { status: "error", message: "Không thể lưu thanh toán. Vui lòng thử lại." };
  }

  const result = data[0] as { payment_id: string; total_amount: number };

  revalidatePath("/debts");
  revalidatePath("/payments");

  return {
    status: "success",
    message: `Đã lưu thanh toán ${items.length} hóa đơn, tổng ${result.total_amount.toLocaleString("vi-VN")} đ.`,
    payment: { id: result.payment_id, totalAmount: result.total_amount, invoiceCount: items.length },
  };
}
