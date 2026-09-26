"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

const SETTINGS_PATH = "/settings/notifications";

export type RecipientFormValues = {
  name: string;
  zaloUid: string;
};

export type RecipientFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  values?: RecipientFormValues;
};

export type RecipientActionResult = {
  status: "success" | "error";
  message?: string;
};

const recipientSchema = z.object({
  name: z.string().trim().min(1, "Tên là bắt buộc.").max(255, "Tên tối đa 255 ký tự."),
  zaloUid: z.string().trim().min(1, "Zalo UID là bắt buộc.").max(255, "Zalo UID tối đa 255 ký tự."),
});

function parseRecipientForm(formData: FormData) {
  return recipientSchema.safeParse({
    name: formData.get("name"),
    zaloUid: formData.get("zaloUid"),
  });
}

function readSubmittedValues(formData: FormData): RecipientFormValues {
  return {
    name: (formData.get("name") ?? "").toString(),
    zaloUid: (formData.get("zaloUid") ?? "").toString(),
  };
}

export async function createRecipient(
  _prevState: RecipientFormState,
  formData: FormData
): Promise<RecipientFormState> {
  const authz = await authorizeAction("notification:manage");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const parsed = parseRecipientForm(formData);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
      values: readSubmittedValues(formData),
    };
  }

  const supabase = createAdminClient();
  const { error } = await supabase.from("notification_recipients").insert({
    name: parsed.data.name,
    zalo_uid: parsed.data.zaloUid,
  });

  if (error) {
    if (error.code === "23505") {
      return {
        status: "error",
        message: "Zalo UID này đã được thêm rồi.",
        fieldErrors: { zaloUid: ["Zalo UID đã tồn tại."] },
        values: readSubmittedValues(formData),
      };
    }
    return {
      status: "error",
      message: "Không thể thêm người nhận. Vui lòng thử lại.",
      values: readSubmittedValues(formData),
    };
  }

  revalidatePath(SETTINGS_PATH);
  return { status: "success", message: "Đã thêm người nhận." };
}

export async function updateRecipient(
  id: string,
  _prevState: RecipientFormState,
  formData: FormData
): Promise<RecipientFormState> {
  const authz = await authorizeAction("notification:manage");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const parsed = parseRecipientForm(formData);
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
    .from("notification_recipients")
    .update({ name: parsed.data.name, zalo_uid: parsed.data.zaloUid })
    .eq("id", id);

  if (error) {
    if (error.code === "23505") {
      return {
        status: "error",
        message: "Zalo UID này đã được thêm rồi.",
        fieldErrors: { zaloUid: ["Zalo UID đã tồn tại."] },
        values: readSubmittedValues(formData),
      };
    }
    return {
      status: "error",
      message: "Không thể cập nhật người nhận. Vui lòng thử lại.",
      values: readSubmittedValues(formData),
    };
  }

  revalidatePath(SETTINGS_PATH);
  return { status: "success", message: "Đã lưu thay đổi." };
}

export async function setRecipientActive(id: string, isActive: boolean): Promise<RecipientActionResult> {
  const authz = await authorizeAction("notification:manage");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const supabase = createAdminClient();
  const { error } = await supabase.from("notification_recipients").update({ is_active: isActive }).eq("id", id);

  if (error) {
    return { status: "error", message: "Không thể cập nhật trạng thái. Vui lòng thử lại." };
  }

  revalidatePath(SETTINGS_PATH);
  return { status: "success" };
}

export async function deleteRecipient(id: string): Promise<RecipientActionResult> {
  const authz = await authorizeAction("notification:manage");
  if (!authz.ok) {
    return { status: "error", message: authz.message };
  }

  const supabase = createAdminClient();
  // notification_logs.recipient_id -> ON DELETE SET NULL (migration 00029):
  // deleting a recipient here never erases their past send history.
  const { error } = await supabase.from("notification_recipients").delete().eq("id", id);

  if (error) {
    return { status: "error", message: "Không thể xóa người nhận. Vui lòng thử lại." };
  }

  revalidatePath(SETTINGS_PATH);
  return { status: "success" };
}
