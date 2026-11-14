"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { ROLES, type Role } from "@/lib/auth/permissions";
import { createAdminClient } from "@/lib/supabase/admin";

// ("use server" modules may only export async functions.)
const LAST_ADMIN_MESSAGE = "Phải có ít nhất một tài khoản admin đang hoạt động.";

export type UserActionState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

const uuidLike = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Người dùng không hợp lệ.");
const roleSchema = z.enum(ROLES as unknown as [Role, ...Role[]], { error: "Vai trò không hợp lệ." });

// Friendly pre-check for the last-admin rule. The database trigger
// guard_last_active_admin (migration 00036) is the real, race-safe guard —
// its AU001 error is mapped to the same message below.
async function wouldRemoveLastActiveAdmin(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  next: { role: Role; isActive: boolean }
): Promise<boolean> {
  const { data: target } = await supabase.from("profiles").select("role, is_active").eq("id", userId).maybeSingle();
  if (!target || target.role !== "admin" || !target.is_active) return false;
  if (next.role === "admin" && next.isActive) return false;
  const { count } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin")
    .eq("is_active", true)
    .neq("id", userId);
  return (count ?? 0) === 0;
}

async function updateProfile(
  userId: string,
  patch: { role?: Role; is_active?: boolean }
): Promise<UserActionState> {
  const authz = await authorizeAction("user:manage");
  if (!authz.ok) return { status: "error", message: authz.message };

  const supabase = createAdminClient();
  const { data: current } = await supabase.from("profiles").select("role, is_active").eq("id", userId).maybeSingle();
  if (!current) return { status: "error", message: "Không tìm thấy người dùng." };

  const next = { role: (patch.role ?? current.role) as Role, isActive: patch.is_active ?? current.is_active };
  if (await wouldRemoveLastActiveAdmin(supabase, userId, next)) {
    return { status: "error", message: LAST_ADMIN_MESSAGE };
  }

  const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
  if (error) {
    return {
      status: "error",
      message: error.code === "AU001" ? LAST_ADMIN_MESSAGE : "Không thể cập nhật người dùng. Vui lòng thử lại.",
    };
  }

  revalidatePath("/users");
  return { status: "success", message: "Đã cập nhật người dùng." };
}

export async function updateUserRole(userId: string, role: string): Promise<UserActionState> {
  const parsedId = uuidLike.safeParse(userId);
  const parsedRole = roleSchema.safeParse(role);
  if (!parsedId.success || !parsedRole.success) {
    return { status: "error", message: "Dữ liệu không hợp lệ." };
  }
  return updateProfile(parsedId.data, { role: parsedRole.data });
}

// Deactivation takes effect on the user's very next request (the proxy and
// every server-side auth check read profiles.is_active).
export async function setUserActive(userId: string, isActive: boolean): Promise<UserActionState> {
  const parsedId = uuidLike.safeParse(userId);
  if (!parsedId.success || typeof isActive !== "boolean") {
    return { status: "error", message: "Dữ liệu không hợp lệ." };
  }
  return updateProfile(parsedId.data, { is_active: isActive });
}

const createUserSchema = z.object({
  email: z.string().trim().min(1, "Vui lòng nhập email.").pipe(z.email("Email không hợp lệ.")),
  fullName: z.string().trim().max(255).optional(),
  role: roleSchema,
  password: z.string().min(8, "Mật khẩu tạm tối thiểu 8 ký tự.").max(72, "Mật khẩu tối đa 72 ký tự."),
});

export type CreateUserPayload = z.input<typeof createUserSchema>;

// Internal system: accounts are created by an admin (no public signup).
// app_metadata.provisioned_by_admin is informational (settable only with
// the service-role key); activation itself happens explicitly below.
export async function createUser(_prev: UserActionState, payload: CreateUserPayload): Promise<UserActionState> {
  const authz = await authorizeAction("user:manage");
  if (!authz.ok) return { status: "error", message: authz.message };

  const parsed = createUserSchema.safeParse(payload);
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    return {
      status: "error",
      message: flattened.formErrors[0] ?? "Vui lòng kiểm tra lại thông tin.",
      fieldErrors: flattened.fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: parsed.data.fullName ? { full_name: parsed.data.fullName } : {},
    app_metadata: { provisioned_by_admin: true },
  });
  if (error || !data.user) {
    const message =
      error?.code === "email_exists" || error?.code === "user_already_exists"
        ? "Email này đã có tài khoản."
        : error?.code === "weak_password"
          ? "Mật khẩu quá yếu. Vui lòng chọn mật khẩu khác."
          : "Không thể tạo người dùng. Vui lòng thử lại.";
    return { status: "error", message, fieldErrors: message.startsWith("Email") ? { email: [message] } : undefined };
  }

  // The on_auth_user_created trigger always creates an INACTIVE viewer
  // profile (migration 00037); this admin-driven path activates it with the
  // chosen role.
  const { error: profileError } = await supabase
    .from("profiles")
    .update({ role: parsed.data.role, is_active: true })
    .eq("id", data.user.id);
  if (profileError) {
    revalidatePath("/users");
    return {
      status: "error",
      message: "Đã tạo tài khoản nhưng chưa kích hoạt được. Vui lòng bấm \"Kích hoạt\" và chọn vai trò trong danh sách.",
    };
  }

  revalidatePath("/users");
  return { status: "success", message: `Đã tạo tài khoản ${parsed.data.email}.` };
}
