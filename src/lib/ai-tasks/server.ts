// ============================================================
// PHASE 06 — server wiring. The actor ALWAYS comes from the server session
// (Phase 03 requireZaloPersonal / authorizeZaloApi); the service-role client and
// GEMINI_API_KEY stay here. Two switches:
//   AI_TASKS_ENABLED                 (this phase)  off → pages 404, API 404, tick 503
//   ZALO_PERSONAL_DASHBOARD_ENABLED  (Phase 03)    the module itself
// ============================================================
import "server-only";

import { notFound } from "next/navigation";
import { NextResponse } from "next/server";

import { getAiConfig } from "@/lib/ai-assistant/config";
import { FakeAiProvider } from "@/lib/ai-assistant/fake-provider";
import { GeminiProvider } from "@/lib/ai-assistant/gemini-provider";
import { createAdminClient } from "@/lib/supabase/admin";
import { isZaloPersonalDashboardEnabled } from "@/lib/zalo-personal/config";
import { authorizeZaloApi, requireZaloPersonal } from "@/lib/zalo-personal/dashboard/server";
import type { DashboardDeps } from "@/lib/zalo-personal/dashboard/service";

import { getReplyConfig } from "@/lib/zalo-reply/config";
import { SupabaseReplyStore } from "@/lib/zalo-reply/supabase-store";

import { unavailableAdapter, zaloPersonalQueueAdapter } from "./channels.ts";
import { getTaskEngineConfig } from "./config.ts";
import type { EngineDeps } from "./engine.ts";
import { taskDemoScript } from "./fake-script.ts";
import { httpStatusOf, type Actor, type Result, type TaskServiceDeps } from "./service.ts";
import { SupabaseTaskStore } from "./supabase-store.ts";

export function tasksEnabled(): boolean {
  return getTaskEngineConfig().enabled && isZaloPersonalDashboardEnabled();
}

export function getTaskServiceDeps(): TaskServiceDeps {
  return { store: new SupabaseTaskStore(createAdminClient()), reminders: getTaskEngineConfig().reminders };
}

export function getEngineDeps(workerId: string, signal?: AbortSignal): EngineDeps {
  const aiConfig = getAiConfig();
  return {
    store: new SupabaseTaskStore(createAdminClient()),
    config: getTaskEngineConfig(),
    aiConfig,
    provider: () => (aiConfig.provider === "fake" ? new FakeAiProvider(taskDemoScript, "fake-demo") : new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: aiConfig.model, baseUrl: aiConfig.geminiBaseUrl })),
    // PHASE 07: Zalo Personal reminders go into the reply outbound queue (sent by the
    // connection's worker after the claim gates). Available only while replies +
    // sending are on system-wide; the channel flag / kill switch / preference gate it too.
    adapters: {
      zalo_personal: zaloPersonalQueueAdapter((i) => new SupabaseReplyStore(createAdminClient()).enqueueReminder(i), getReplyConfig().sendEnabled),
      zalo_oa: unavailableAdapter("zalo_oa"),
    },
    workerId,
    signal,
    // counters and categories only — never message text, titles or ids of people
    log: (event, fields) => console.info(JSON.stringify({ source: "ai-tasks", event, ...fields })),
  };
}

/** Pages: flags off → 404; otherwise the Phase 03 gate (403 / setup redirect). */
export async function requireTasksPage(): Promise<{ actor: Actor; deps: TaskServiceDeps; dashboard: DashboardDeps }> {
  if (!tasksEnabled()) notFound();
  const { actor, deps: dashboard } = await requireZaloPersonal();
  return { actor, deps: getTaskServiceDeps(), dashboard };
}

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function authorizeTasksApi(): Promise<{ ok: true; actor: Actor; deps: TaskServiceDeps } | { ok: false; response: NextResponse }> {
  if (!tasksEnabled()) return { ok: false, response: json(404, { success: false, error: "not_enabled", errorMessage: "Chức năng công việc chưa được bật." }) };
  const gate = await authorizeZaloApi();
  if (!gate.ok) return gate;
  return { ok: true, actor: gate.actor, deps: getTaskServiceDeps() };
}

export function respondTasks<T>(result: Result<T>): NextResponse {
  if (result.ok) return json(200, { success: true, data: result.data as unknown as Record<string, unknown> });
  return json(httpStatusOf(result.error), { success: false, error: result.code, errorMessage: result.message });
}

export function unwrapTasks<T>(result: Result<T>): T {
  if (result.ok) return result.data;
  if (result.error === "not_found") notFound();
  if (result.error === "forbidden") notFound();
  throw new Error(`ai-tasks: ${result.code}`);
}

export const respondJson = json;
