// ============================================================
// Bootstrap / recovery: create (or promote) an ACTIVE admin account.
//
// Needed once, because with no admin nobody can open /users to create
// accounts. Also the recovery path if every admin is ever lost.
//
//   npm run auth:create-admin -- --email you@example.com --password "..." [--name "Họ tên"]
//
// Runs locally with the service-role key from .env.local; not part of the
// Next.js app. The password is only sent to Supabase Auth — never printed
// or logged.
// ============================================================
import { createClient } from "@supabase/supabase-js";

import { toLoginEmail } from "../../src/lib/auth/login-identifier.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// --email accepts a real email or a plain username (stored as
// <username>@theodoihangve.local, same rule as the login form).
const rawLogin = arg("email") ?? arg("username");
const email = rawLogin ? toLoginEmail(rawLogin) ?? undefined : undefined;
const password = arg("password");
const fullName = arg("name")?.trim();

if (!email || !password) {
  console.error('Cách dùng: npm run auth:create-admin -- --email you@example.com --password "..." [--name "Họ tên"]');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Mật khẩu tối thiểu 8 ký tự.");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (chạy qua npm script để nạp .env.local).");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function findUserId(target: string): Promise<string | null> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main() {
  let userId = await findUserId(email!);

  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : {},
      app_metadata: { provisioned_by_admin: true },
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    userId = data.user.id;
    console.log(`Đã tạo tài khoản ${email}.`);
  } else {
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password,
      app_metadata: { provisioned_by_admin: true },
    });
    if (error) throw error;
    console.log(`Tài khoản ${email} đã tồn tại — đã đặt lại mật khẩu.`);
  }

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: userId,
    role: "admin",
    is_active: true,
    ...(fullName ? { full_name: fullName } : {}),
  });
  if (profileError) throw profileError;
  console.log(`${email} hiện là admin đang hoạt động. Đăng nhập tại /login.`);
}

main().catch((e: unknown) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
