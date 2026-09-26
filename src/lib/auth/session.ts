// ============================================================
// PHASE AUTHENTICATION AND AUTHORIZATION — server-side auth helpers (the
// app's Data Access Layer for "who is this and what may they do").
//
// Every page, server action and route handler authorizes through here.
// The proxy (src/proxy.ts) also checks sessions on every request, but it is
// only the first line of defense — these helpers are what actually gate
// data access and mutations.
//
// Identity comes from Supabase Auth (auth.getUser() re-validates the JWT
// with the Auth server — never a locally decoded cookie). Role and
// is_active come from public.profiles in the database — never from the
// client.
// ============================================================
import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasPermission, isRole, type Permission, type Role } from "./permissions";

export type Profile = {
  id: string;
  full_name: string | null;
  role: Role;
  is_active: boolean;
};

export type AuthContext =
  | { status: "unauthenticated" }
  | { status: "inactive"; user: User; profile: Profile | null }
  | { status: "active"; user: User; profile: Profile };

export type ActiveAuth = Extract<AuthContext, { status: "active" }>;

export const AUTH_MESSAGES = {
  unauthenticated: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  inactive: "Tài khoản đã bị vô hiệu hóa.",
  forbidden: "Bạn không có quyền thực hiện thao tác này.",
} as const;

// Memoized per request (React cache), so a page + its helpers hit Supabase
// Auth / the profiles table once, not once per call site.
export const getAuthContext = cache(async (): Promise<AuthContext> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "unauthenticated" };

  const { data } = await createAdminClient()
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (!data || !isRole(data.role)) {
    return { status: "inactive", user, profile: null };
  }
  const profile = data as Profile;
  if (!profile.is_active) return { status: "inactive", user, profile };
  return { status: "active", user, profile };
});

export async function getCurrentUser(): Promise<User | null> {
  const ctx = await getAuthContext();
  return ctx.status === "unauthenticated" ? null : ctx.user;
}

export async function getCurrentProfile(): Promise<Profile | null> {
  const ctx = await getAuthContext();
  return ctx.status === "unauthenticated" ? null : ctx.profile;
}

export async function isAdmin(): Promise<boolean> {
  const ctx = await getAuthContext();
  return ctx.status === "active" && ctx.profile.role === "admin";
}

// ---------- Pages (Server Components) ----------

// Not logged in -> /login; logged in but disabled -> /account-disabled.
export async function requireActiveUser(): Promise<ActiveAuth> {
  const ctx = await getAuthContext();
  if (ctx.status === "unauthenticated") redirect("/login");
  if (ctx.status === "inactive") redirect("/account-disabled");
  return ctx;
}

// Same as requireActiveUser() plus the permission — lacking it renders the
// 403 page (/forbidden), never a redirect loop back to /login.
export async function requirePermission(permission: Permission): Promise<ActiveAuth> {
  const ctx = await requireActiveUser();
  if (!hasPermission(ctx.profile.role, permission)) redirect("/forbidden");
  return ctx;
}

export async function requireRole(...roles: Role[]): Promise<ActiveAuth> {
  const ctx = await requireActiveUser();
  if (!roles.includes(ctx.profile.role)) redirect("/forbidden");
  return ctx;
}

// ---------- Server Actions ----------

export type ActionAuthResult =
  | { ok: true; auth: ActiveAuth }
  | { ok: false; status: 401 | 403; message: string };

// For mutations: returns a result instead of redirecting, so the calling
// action can hand a friendly message back to its form. Pass no permission
// to require only an active user.
export async function authorizeAction(permission?: Permission): Promise<ActionAuthResult> {
  const ctx = await getAuthContext();
  if (ctx.status === "unauthenticated") {
    return { ok: false, status: 401, message: AUTH_MESSAGES.unauthenticated };
  }
  if (ctx.status === "inactive") {
    return { ok: false, status: 403, message: AUTH_MESSAGES.inactive };
  }
  if (permission && !hasPermission(ctx.profile.role, permission)) {
    return { ok: false, status: 403, message: AUTH_MESSAGES.forbidden };
  }
  return { ok: true, auth: ctx };
}

// ---------- Route Handlers ----------

// Returns the active auth context, or a ready-to-return JSON error Response
// (401 not logged in / 403 inactive or missing permission). Response shape
// matches the existing /api/* routes ({ success: false, errorMessage }).
export async function authorizeRoute(
  permission?: Permission
): Promise<{ ok: true; auth: ActiveAuth } | { ok: false; response: NextResponse }> {
  const result = await authorizeAction(permission);
  if (result.ok) return result;
  return {
    ok: false,
    response: NextResponse.json({ success: false, errorMessage: result.message }, { status: result.status }),
  };
}
