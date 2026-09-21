"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { canManageSuppliers, getCurrentRole } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";

export type SupplierFormValues = {
  code: string;
  name: string;
  phone: string;
  address: string;
  note: string;
};

export type SupplierFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  // React resets uncontrolled form fields after every action call, success or
  // error. Echo back what the user typed so a failed submit doesn't force
  // them to retype everything.
  values?: SupplierFormValues;
};

export type SupplierActionResult = {
  status: "success" | "error";
  message?: string;
};

const FORBIDDEN_MESSAGE = "Bạn không có quyền thực hiện thao tác này.";

const supplierSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Mã NCC là bắt buộc.")
    .max(50, "Mã NCC tối đa 50 ký tự."),
  name: z
    .string()
    .trim()
    .min(1, "Tên NCC là bắt buộc.")
    .max(255, "Tên NCC tối đa 255 ký tự."),
  phone: z.string().trim().max(30, "Số điện thoại tối đa 30 ký tự.").optional(),
  address: z.string().trim().max(500, "Địa chỉ tối đa 500 ký tự.").optional(),
  note: z.string().trim().max(1000, "Ghi chú tối đa 1000 ký tự.").optional(),
});

function readOptionalField(value: FormDataEntryValue | null) {
  const s = (value ?? "").toString().trim();
  return s.length ? s : undefined;
}

function parseSupplierForm(formData: FormData) {
  return supplierSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    phone: readOptionalField(formData.get("phone")),
    address: readOptionalField(formData.get("address")),
    note: readOptionalField(formData.get("note")),
  });
}

function readSubmittedValues(formData: FormData): SupplierFormValues {
  return {
    code: (formData.get("code") ?? "").toString(),
    name: (formData.get("name") ?? "").toString(),
    phone: (formData.get("phone") ?? "").toString(),
    address: (formData.get("address") ?? "").toString(),
    note: (formData.get("note") ?? "").toString(),
  };
}

export async function createSupplier(
  _prevState: SupplierFormState,
  formData: FormData
): Promise<SupplierFormState> {
  // Correlates the checkpoints for one invocation in the Vercel function log.
  // TEMP: remove once the production create-supplier issue is confirmed fixed.
  const reqId = Math.random().toString(36).slice(2, 8);
  console.log(`[createSupplier:${reqId}] action started`, {
    fields: Array.from(formData.keys()),
    code: formData.get("code"),
    name: formData.get("name"),
  });

  const role = getCurrentRole();
  console.log(`[createSupplier:${reqId}] role resolved`, { role });

  if (!canManageSuppliers(role)) {
    console.log(`[createSupplier:${reqId}] returned early: permission denied`, { role });
    return { status: "error", message: FORBIDDEN_MESSAGE };
  }
  console.log(`[createSupplier:${reqId}] permission passed`);

  const parsed = parseSupplierForm(formData);
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    console.log(`[createSupplier:${reqId}] returned early: validation failed`, {
      fieldErrors,
    });
    return {
      status: "error",
      message: "Vui lòng kiểm tra lại thông tin.",
      fieldErrors,
      values: readSubmittedValues(formData),
    };
  }
  console.log(`[createSupplier:${reqId}] validation passed`);

  const missingEnv = [
    !process.env.NEXT_PUBLIC_SUPABASE_URL && "NEXT_PUBLIC_SUPABASE_URL",
    !process.env.SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);
  if (missingEnv.length > 0) {
    console.error(`[createSupplier:${reqId}] returned early: missing env vars`, {
      missingEnv,
    });
    return {
      status: "error",
      message: "Lỗi cấu hình hệ thống. Vui lòng liên hệ quản trị viên.",
      values: readSubmittedValues(formData),
    };
  }

  let supabase: ReturnType<typeof createAdminClient>;
  try {
    supabase = createAdminClient();
  } catch (e) {
    console.error(`[createSupplier:${reqId}] returned early: createAdminClient threw`, {
      message: e instanceof Error ? e.message : String(e),
    });
    return {
      status: "error",
      message: "Lỗi cấu hình hệ thống. Vui lòng liên hệ quản trị viên.",
      values: readSubmittedValues(formData),
    };
  }

  console.log(`[createSupplier:${reqId}] before Supabase insert`);
  const { error } = await supabase.from("suppliers").insert({
    code: parsed.data.code,
    name: parsed.data.name,
    phone: parsed.data.phone ?? null,
    address: parsed.data.address ?? null,
    note: parsed.data.note ?? null,
  });
  console.log(`[createSupplier:${reqId}] after Supabase insert`, {
    success: !error,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    errorDetails: error?.details ?? null,
    errorHint: error?.hint ?? null,
  });

  if (error) {
    if (error.code === "23505") {
      return {
        status: "error",
        message: "Mã NCC đã tồn tại. Vui lòng chọn mã khác.",
        fieldErrors: { code: ["Mã NCC đã tồn tại."] },
        values: readSubmittedValues(formData),
      };
    }
    return {
      status: "error",
      message: "Không thể tạo nhà cung cấp. Vui lòng thử lại.",
      values: readSubmittedValues(formData),
    };
  }

  console.log(`[createSupplier:${reqId}] revalidate started`);
  revalidatePath("/suppliers");
  console.log(`[createSupplier:${reqId}] action completed`, { status: "success" });
  return { status: "success", message: "Đã thêm nhà cung cấp." };
}

export async function updateSupplier(
  id: string,
  _prevState: SupplierFormState,
  formData: FormData
): Promise<SupplierFormState> {
  if (!canManageSuppliers(getCurrentRole())) {
    return { status: "error", message: FORBIDDEN_MESSAGE };
  }

  const parsed = parseSupplierForm(formData);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
      values: readSubmittedValues(formData),
    };
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("suppliers")
    .update({
      code: parsed.data.code,
      name: parsed.data.name,
      phone: parsed.data.phone ?? null,
      address: parsed.data.address ?? null,
      note: parsed.data.note ?? null,
    })
    .eq("id", id);

  if (error) {
    if (error.code === "23505") {
      return {
        status: "error",
        message: "Mã NCC đã tồn tại. Vui lòng chọn mã khác.",
        fieldErrors: { code: ["Mã NCC đã tồn tại."] },
        values: readSubmittedValues(formData),
      };
    }
    return {
      status: "error",
      message: "Không thể cập nhật nhà cung cấp. Vui lòng thử lại.",
      values: readSubmittedValues(formData),
    };
  }

  revalidatePath("/suppliers");
  return { status: "success", message: "Đã lưu thay đổi." };
}

export async function setSupplierActive(
  id: string,
  isActive: boolean
): Promise<SupplierActionResult> {
  if (!canManageSuppliers(getCurrentRole())) {
    return { status: "error", message: FORBIDDEN_MESSAGE };
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("suppliers")
    .update({ is_active: isActive })
    .eq("id", id);

  if (error) {
    return { status: "error", message: "Không thể cập nhật trạng thái. Vui lòng thử lại." };
  }

  revalidatePath("/suppliers");
  return { status: "success" };
}
