"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeNextPath } from "./redirect";
import { toLoginEmail } from "./login-identifier";

const loginSchema = z.object({
  // Email or internal username (see login-identifier.ts).
  email: z
    .string()
    .trim()
    .min(1, "Vui lòng nhập email hoặc tên đăng nhập.")
    .refine((v) => toLoginEmail(v) !== null, "Email hoặc tên đăng nhập không hợp lệ.")
    .transform((v) => toLoginEmail(v)!),
  password: z.string().min(1, "Vui lòng nhập mật khẩu."),
  next: z.string().optional(),
});

export type LoginState = {
  status: "idle" | "error";
  message?: string;
  fieldErrors?: { email?: string[]; password?: string[] };
  email?: string;
};

// Supabase Auth error codes -> user-facing messages. Never show the raw
// provider error; unknown failures get a generic message.
function loginErrorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_credentials":
      return "Tài khoản hoặc mật khẩu không đúng.";
    case "email_not_confirmed":
      return "Tài khoản chưa được xác nhận email. Vui lòng liên hệ quản trị viên.";
    case "user_banned":
      return "Tài khoản đã bị vô hiệu hóa.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ít phút.";
    default:
      return "Không thể đăng nhập lúc này. Vui lòng thử lại.";
  }
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  const email = typeof formData.get("email") === "string" ? String(formData.get("email")) : "";
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    return {
      status: "error",
      fieldErrors: { email: flattened.fieldErrors.email, password: flattened.fieldErrors.password },
      email,
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    return { status: "error", message: loginErrorMessage(error?.code), email };
  }

  // Credentials are right, but the account must also be ACTIVE. Don't leave
  // a session behind for a disabled account.
  const { data: profile } = await createAdminClient()
    .from("profiles")
    .select("is_active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!profile?.is_active) {
    await supabase.auth.signOut();
    return { status: "error", message: "Tài khoản đã bị vô hiệu hóa.", email };
  }

  revalidatePath("/", "layout");
  redirect(safeNextPath(parsed.data.next));
}

export async function logout(): Promise<void> {
  const supabase = await createClient();
  // Revokes the refresh token server-side and clears the auth cookies.
  await supabase.auth.signOut();
  // Drop any cached protected RSC payloads before landing on /login.
  revalidatePath("/", "layout");
  redirect("/login");
}
