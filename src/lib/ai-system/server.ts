// ============================================================
// PHASE 05 — server wiring for the web channel. The actor ALWAYS comes from
// the server session (getAuthContext → auth.getUser + profiles); the
// service-role client and GEMINI_API_KEY stay here (server-only); the
// browser only ever receives an AssistantResponse.
// ============================================================
import "server-only";

import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";

import { getAiConfig } from "@/lib/ai-assistant/config";
import { FakeAiProvider } from "@/lib/ai-assistant/fake-provider";
import { GeminiProvider } from "@/lib/ai-assistant/gemini-provider";
import { getAuthContext, requireActiveUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getShopeeFlags } from "@/lib/feature-flags";
import { createAdminClient } from "@/lib/supabase/admin";

import type { AssistantDeps } from "./assistant.ts";
import { getSystemAssistantConfig } from "./config.ts";
import { systemDemoScript } from "./fake-script.ts";
import { SupabaseSystemStore } from "./supabase-store.ts";
import { createDefaultRegistry } from "./tools/index.ts";

export function getSystemAssistantDeps(): AssistantDeps & { identityStore: SupabaseSystemStore } {
  const aiConfig = getAiConfig();
  const db = createAdminClient();
  const store = new SupabaseSystemStore(db);
  return {
    db,
    store,
    identityStore: store,
    registry: createDefaultRegistry(),
    aiConfig,
    config: getSystemAssistantConfig(),
    flags: { adsRealData: getShopeeFlags().adsDataSource === "real" },
    provider: () => (aiConfig.provider === "fake" ? new FakeAiProvider(systemDemoScript, "fake-demo") : new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: aiConfig.model, baseUrl: aiConfig.geminiBaseUrl })),
    // metadata only: never a question, an answer or a figure
    log: (e) => console.info(JSON.stringify({ source: "ai-system", ...e })),
  };
}

/** Is the web assistant available to this role (flag + permission)? UX only — the API re-checks. */
export function systemAssistantAvailable(role: Parameters<typeof hasPermission>[0]): boolean {
  return getSystemAssistantConfig().webEnabled && hasPermission(role, "ai_system:use");
}

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Route handlers: flag (404) → session (401) → active + permission (403). */
export async function authorizeSystemApi(): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  if (!getSystemAssistantConfig().webEnabled) return { ok: false, response: json(404, { success: false, error: "not_enabled", errorMessage: "Trợ lý hệ thống chưa được bật." }) };
  const ctx = await getAuthContext();
  if (ctx.status === "unauthenticated") return { ok: false, response: json(401, { success: false, error: "unauthenticated", errorMessage: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." }) };
  if (ctx.status === "inactive") return { ok: false, response: json(403, { success: false, error: "inactive", errorMessage: "Tài khoản đã bị vô hiệu hóa." }) };
  if (!hasPermission(ctx.profile.role, "ai_system:use")) return { ok: false, response: json(403, { success: false, error: "forbidden", errorMessage: "Bạn không có quyền dùng Trợ lý hệ thống." }) };
  return { ok: true, userId: ctx.user.id };
}

/** Page: flag off → 404; no permission → 403 page. */
export async function requireSystemAssistantPage() {
  if (!getSystemAssistantConfig().webEnabled) notFound();
  const auth = await requireActiveUser();
  if (!hasPermission(auth.profile.role, "ai_system:use")) redirect("/forbidden");
  return auth;
}

export const respondJson = json;

/** Today's (VN day) model calls of the system assistant for one user; 0 when unreadable (the page still works). */
export async function systemUsageToday(deps: ReturnType<typeof getSystemAssistantDeps>, userId: string, now: Date = new Date()): Promise<number> {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  const dayStart = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3_600_000);
  return deps.identityStore.usageToday(userId, dayStart).then((u) => u.modelCalls).catch(() => 0);
}
