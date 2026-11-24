// ============================================================
// ZALO PERSONAL Phase 04 — server wiring for Ask AI. The actor always comes
// from the server session; the service-role client and GEMINI_API_KEY stay
// here (server-only), the browser only gets view models.
// ============================================================
import "server-only";

import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import { getAiConfig } from "@/lib/ai-assistant/config";
import { echoSourcesScript, FakeAiProvider } from "@/lib/ai-assistant/fake-provider";
import { GeminiProvider } from "@/lib/ai-assistant/gemini-provider";
import { hasPermission } from "@/lib/auth/permissions";
import { createAdminClient } from "@/lib/supabase/admin";

import { authorizeZaloApi, getDashboardDeps, requireZaloPersonal } from "../dashboard/server.ts";
import type { Actor } from "../dashboard/access.ts";
import type { DashboardDeps } from "../dashboard/service.ts";
import { aiHttpStatus, type AiDeps, type AiResult } from "./service.ts";
import { SupabaseAiStore } from "./supabase-store.ts";

export function getAiDeps(): AiDeps {
  const config = getAiConfig();
  return {
    dashboard: getDashboardDeps().store,
    store: new SupabaseAiStore(createAdminClient()),
    config,
    provider: () => (config.provider === "fake" ? new FakeAiProvider(echoSourcesScript, "fake-demo") : new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: config.model, baseUrl: config.geminiBaseUrl })),
  };
}

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Dashboard gate (flag, session, role) + the AI permission. Data scope is enforced by the service. */
export async function authorizeAiApi(): Promise<{ ok: true; actor: Actor; deps: AiDeps } | { ok: false; response: NextResponse }> {
  const gate = await authorizeZaloApi();
  if (!gate.ok) return gate;
  if (!hasPermission(gate.actor.role, "zalo_personal:ai")) return { ok: false, response: json(403, { success: false, error: "forbidden", errorMessage: "Bạn không có quyền dùng Hỏi AI." }) };
  return { ok: true, actor: gate.actor, deps: getAiDeps() };
}

/** Pages: the dashboard gate (flag 404, session, data scope) + the AI permission. */
export async function requireZaloPersonalAi(): Promise<{ actor: Actor; deps: AiDeps; dashboardDeps: DashboardDeps }> {
  const { actor, deps: dashboardDeps } = await requireZaloPersonal();
  if (!hasPermission(actor.role, "zalo_personal:ai")) redirect("/forbidden");
  return { actor, deps: getAiDeps(), dashboardDeps };
}

export function respondAi<T>(result: AiResult<T>): NextResponse {
  if (result.ok) return json(200, { success: true, data: result.data as unknown as Record<string, unknown> });
  return json(aiHttpStatus(result.error), { success: false, error: result.code, errorMessage: result.message });
}
