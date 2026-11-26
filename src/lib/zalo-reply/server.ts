// ============================================================
// PHASE 04.5 — server wiring. The actor ALWAYS comes from the server session
// (Phase 03 requireZaloPersonal / authorizeZaloApi). The service-role client,
// GEMINI_API_KEY and worker secrets stay here. Next.js NEVER sends a Zalo
// message: it only stores drafts and answers the worker's signed claim.
//   PERSONAL_REPLY_ENABLED           off → pages 404, API 404, tick 503
//   ZALO_PERSONAL_DASHBOARD_ENABLED  (Phase 03) the module itself
// ============================================================
import "server-only";

import { notFound } from "next/navigation";
import { NextResponse } from "next/server";

import { getSystemAssistantDeps } from "@/lib/ai-system/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isZaloPersonalDashboardEnabled } from "@/lib/zalo-personal/config";
import { getAiDeps } from "@/lib/zalo-personal/ai/server";
import { authorizeZaloApi, getDashboardDeps, requireZaloPersonal } from "@/lib/zalo-personal/dashboard/server";
import { getZaloPersonalIngestDeps } from "@/lib/zalo-personal/server";

import { getReplyConfig } from "./config.ts";
import { FastReplyScheduler, runFastReply, type EngineDeps } from "./engine.ts";
import type { OutboundDeps } from "./outbound.ts";
import { httpStatusOf, type Actor, type Result, type ReviewDeps } from "./service.ts";
import { SupabaseReplyStore } from "./supabase-store.ts";

export function replyEnabled(): boolean {
  return getReplyConfig().enabled && isZaloPersonalDashboardEnabled();
}

export function getReviewDeps(): ReviewDeps {
  const db = createAdminClient();
  const system = getSystemAssistantDeps();
  return { store: new SupabaseReplyStore(db), dashboard: getDashboardDeps().store, identity: system.identityStore, config: getReplyConfig() };
}

export function getReplyEngineDeps(workerId: string, signal?: AbortSignal): EngineDeps {
  const system = getSystemAssistantDeps();
  return {
    store: new SupabaseReplyStore(createAdminClient()),
    config: getReplyConfig(),
    identity: system.identityStore,
    // Phase 05: the personal adapter itself is gated by AI_SYSTEM_PERSONAL_DRAFTS_ENABLED
    system,
    memory: getAiDeps(),
    workerId,
    signal,
    // counters / categories only — never message text, answers or ids of people
    log: (event, fields) => console.info(JSON.stringify({ source: "zalo-reply", event, ...fields })),
  };
}

function fastWorkerId(): string {
  const region = (process.env.VERCEL_REGION ?? "local").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `reply-fast-${region}-${crypto.randomUUID().slice(0, 8)}`;
}

// one per server instance: a burst of ingests → one run (+ one follow-up)
const fastScheduler = new FastReplyScheduler(() => runFastReply(() => getReplyEngineDeps(fastWorkerId()), { lagMs: getReplyConfig().scanLagMs }));

/**
 * Realtime: called (inside after()) by the events endpoint when an ingest
 * stored at least one message. No-op unless replies + the fast path are on.
 */
export function triggerFastReply(): Promise<void> | null {
  const config = getReplyConfig();
  if (!config.fastPath || !replyEnabled()) return null;
  return fastScheduler.trigger();
}

export function getOutboundDeps(): OutboundDeps {
  return { ingest: getZaloPersonalIngestDeps(), config: getReplyConfig(), store: new SupabaseReplyStore(createAdminClient()) };
}

/**
 * Pages: flags off → 404; otherwise the Phase 03 gate. `linkOnly` (settings
 * page): a staff member without any Zalo data access still gets in — the page
 * then only shows "link my Zalo" (every connection section is scoped and empty).
 */
export async function requireReplyPage(opts: { linkOnly?: boolean } = {}): Promise<{ actor: Actor; deps: ReviewDeps; linkOnly: boolean }> {
  if (!replyEnabled()) notFound();
  const { actor, onboarding } = await requireZaloPersonal({ setupPage: opts.linkOnly === true });
  return { actor, deps: getReviewDeps(), linkOnly: onboarding };
}

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function authorizeReplyApi(): Promise<{ ok: true; actor: Actor; deps: ReviewDeps } | { ok: false; response: NextResponse }> {
  if (!replyEnabled()) return { ok: false, response: json(404, { success: false, error: "not_enabled", errorMessage: "Trả lời AI chưa được bật." }) };
  const gate = await authorizeZaloApi();
  if (!gate.ok) return gate;
  return { ok: true, actor: gate.actor, deps: getReviewDeps() };
}

export function respondReply<T>(result: Result<T>): NextResponse {
  if (result.ok) return json(200, { success: true, data: result.data as unknown as Record<string, unknown> });
  return json(httpStatusOf(result.error), { success: false, error: result.code, errorMessage: result.message });
}

export function unwrapReply<T>(result: Result<T>): T {
  if (result.ok) return result.data;
  if (result.error === "not_found" || result.error === "forbidden") notFound();
  throw new Error(`zalo-reply: ${result.code}`);
}
