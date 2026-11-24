// ============================================================
// ZALO PERSONAL Phase 03 — server wiring for the dashboard pages and API.
// The actor (user id + role) always comes from the server session
// (src/lib/auth/session.ts, role from public.profiles) — never from the client.
// The service-role client stays here; the browser only ever gets view models.
// ============================================================
import "server-only";

import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";

import { hasPermission, type Role } from "@/lib/auth/permissions";
import { authorizeRoute, requireActiveUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { randomUUID } from "node:crypto";

import { encryptSecret, parseEncryptionKey } from "@/lib/security/secrets";

import { isZaloPersonalDashboardEnabled, workerSecretContext } from "../config.ts";
import { generateWorkerSecret } from "../signing.ts";
import type { Actor } from "./access.ts";
import { canConnect, type SelfServiceDeps } from "./self-service.ts";
import { describeIssues } from "./contracts.ts";
import { httpStatusOf, moduleAccess, type DashboardDeps, type Result } from "./service.ts";
import { SupabaseDashboardStore } from "./supabase-store.ts";

export function getDashboardDeps(): DashboardDeps {
  return { store: new SupabaseDashboardStore(createAdminClient()) };
}

/**
 * Whether the user owns a connection or holds a grant. Queries only when the
 * flag is on and the role may use the module; any failure (e.g. migration not
 * applied yet) counts as "no access" instead of breaking the other apps' pages.
 */
export const zaloDataAccess = cache(async (userId: string, role: Role): Promise<boolean> => {
  if (!isZaloPersonalDashboardEnabled() || !hasPermission(role, "zalo_personal:use")) return false;
  try {
    return (await moduleAccess(getDashboardDeps(), { userId, role })).allowed;
  } catch {
    return false;
  }
});

/**
 * Shown with data access (owns a connection / holds a grant), or with
 * "zalo_personal:connect" so a user can set up their OWN connection. The
 * latter never shows any other user's data: without data access every page
 * leads to the setup page.
 */
export const zaloAppVisible = cache(async (userId: string, role: Role): Promise<boolean> => {
  if (!isZaloPersonalDashboardEnabled() || !hasPermission(role, "zalo_personal:use")) return false;
  return (await zaloDataAccess(userId, role)) || canConnect(role);
});

/**
 * Pages: flag off → 404; no role permission → 403 page. Without data access, a
 * user who may connect is sent to the setup page (which gets onboarding=true);
 * anybody else gets the 403 page.
 */
export async function requireZaloPersonal(opts: { setupPage?: boolean } = {}): Promise<{ actor: Actor; deps: DashboardDeps; onboarding: boolean }> {
  if (!isZaloPersonalDashboardEnabled()) notFound();
  const { user, profile } = await requireActiveUser();
  if (!hasPermission(profile.role, "zalo_personal:use")) redirect("/forbidden");
  const actor: Actor = { userId: user.id, role: profile.role };
  const deps = getDashboardDeps();
  if (await zaloDataAccess(user.id, profile.role)) return { actor, deps, onboarding: false };
  if (!canConnect(profile.role)) redirect("/forbidden");
  if (!opts.setupPage) redirect("/apps/zalo/personal/connections");
  return { actor, deps, onboarding: true };
}

export function getSelfServiceDeps(): SelfServiceDeps {
  const store = new SupabaseDashboardStore(createAdminClient());
  const key = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);
  return {
    dashboard: store,
    store,
    secrets: { generate: generateWorkerSecret, encrypt: (secret, workerId) => encryptSecret(secret, key, workerSecretContext(workerId)), newId: () => randomUUID() },
  };
}

/** Pages: a service refusal becomes the 404 / 403 page (never a raw error on screen). */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.data;
  if (result.error === "not_found") notFound();
  if (result.error === "forbidden") redirect("/forbidden");
  throw new Error(`zalo-personal dashboard: ${result.code}`);
}

type ApiGate ={ ok: true; actor: Actor; deps: DashboardDeps } | { ok: false; response: NextResponse };

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** API: flag off → 404; session 401 / role 403; data scope is enforced by the service. */
export async function authorizeZaloApi(): Promise<ApiGate> {
  if (!isZaloPersonalDashboardEnabled()) return { ok: false, response: json(404, { success: false, error: "not_enabled", errorMessage: "Chức năng chưa được bật." }) };
  const auth = await authorizeRoute("zalo_personal:use");
  if (!auth.ok) {
    const status = auth.response.status;
    return { ok: false, response: json(status, { success: false, error: status === 401 ? "unauthenticated" : "forbidden", errorMessage: status === 401 ? "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." : "Bạn không có quyền thực hiện thao tác này." }) };
  }
  return { ok: true, actor: { userId: auth.auth.user.id, role: auth.auth.profile.role }, deps: getDashboardDeps() };
}

/** Validates input; a structured 400 lists field paths only (never the values). */
export function parseInput<T>(schema: ZodType<T>, input: unknown): { ok: true; data: T } | { ok: false; response: NextResponse } {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, response: json(400, { success: false, error: "invalid_input", errorMessage: "Dữ liệu gửi lên không hợp lệ.", issues: describeIssues(parsed.error) }) };
}

export function respond<T>(result: Result<T>): NextResponse {
  if (result.ok) return json(200, { success: true, data: result.data as unknown as Record<string, unknown> });
  return json(httpStatusOf(result.error), { success: false, error: result.code, errorMessage: result.message });
}

/** Runs a handler; an unexpected failure is logged by category and answered with a generic 500. */
export async function guarded(op: string, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    console.error(JSON.stringify({ source: "zalo-personal-dashboard", op, error: err instanceof Error ? err.name : "unknown" }));
    return json(500, { success: false, error: "server_error", errorMessage: "Có lỗi khi tải dữ liệu. Vui lòng thử lại." });
  }
}

export const searchParamsObject = (url: string): Record<string, string> => Object.fromEntries(new URL(url).searchParams.entries());

export async function readJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return Symbol.for("too_large");
  try {
    return JSON.parse(text);
  } catch {
    return Symbol.for("invalid_json");
  }
}
