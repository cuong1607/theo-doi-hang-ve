// ============================================================
// PHASE 05 — Supabase implementation of AssistantStore + IdentityStore
// (service-role client injected; callers authorize first). Errors keep the
// DB code only — never row data. No "@/" imports (integration-testable).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AiConfig } from "../ai-assistant/config.ts";
import type { AssistantStore, RequestRecord, ReserveResult, ToolCallRecord } from "./assistant.ts";
import type { IdentityStore } from "./identity.ts";

export class SystemStoreError extends Error {
  constructor(op: string, code?: string) {
    super(`ai-system store ${op}${code ? ` (${code})` : ""}`);
    this.name = "SystemStoreError";
  }
}

function check<T>(op: string, res: { data: unknown; error: { code?: string } | null }): T {
  if (res.error) throw new SystemStoreError(op, res.error.code);
  return res.data as T;
}

export class SupabaseSystemStore implements AssistantStore, IdentityStore {
  private readonly db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.db = db;
  }

  // ---------------------------------------------------------------- identity / profile
  async profile(userId: string) {
    const r = check<{ role: string | null; is_active: boolean } | null>("profile", await this.db.from("profiles").select("role, is_active").eq("id", userId).maybeSingle());
    return r ? { role: r.role, active: !!r.is_active } : null;
  }

  async oaLink(zaloUserId: string) {
    const r = check<{ internal_user_id: string } | null>("oaLink", await this.db.from("zalo_user_links").select("internal_user_id").eq("zalo_user_id", zaloUserId).eq("status", "active").maybeSingle());
    return r ? { internalUserId: r.internal_user_id } : null;
  }

  async personalIdentity(connectionId: string, externalUserId: string) {
    const r = check<{ internal_user_id: string } | null>(
      "personalIdentity",
      await this.db.from("ai_channel_identities").select("internal_user_id").eq("channel", "zalo_personal").eq("connection_id", connectionId).eq("external_user_id", externalUserId).eq("status", "active").maybeSingle(),
    );
    return r ? { internalUserId: r.internal_user_id } : null;
  }

  async createPersonalLinkCode(userId: string, codeHash: string, expiresAt: Date) {
    check("createLinkCode", await this.db.from("ai_identity_link_codes").insert({ code_hash: codeHash, channel: "zalo_personal", internal_user_id: userId, expires_at: expiresAt.toISOString() }));
  }

  async consumePersonalLinkCode(codeHash: string, connectionId: string, externalUserId: string) {
    const r = check<{ ok: boolean; internal_user_id?: string; error?: string }>("consumeLinkCode", await this.db.rpc("ai_identity_consume_code", { p_code_hash: codeHash, p_channel: "zalo_personal", p_connection_id: connectionId, p_external_user_id: externalUserId }));
    return r.ok && r.internal_user_id ? { ok: true as const, internalUserId: r.internal_user_id } : { ok: false as const, error: r.error ?? "invalid_code" };
  }

  async listPersonalIdentities(userId: string) {
    const rows = check<Array<{ id: string; connection_id: string; external_user_id: string; linked_at: string }>>(
      "listIdentities",
      await this.db.from("ai_channel_identities").select("id, connection_id, external_user_id, linked_at").eq("internal_user_id", userId).eq("status", "active").order("linked_at", { ascending: false }).limit(50),
    );
    return rows.map((r) => ({ id: r.id, connectionId: r.connection_id, externalUserId: r.external_user_id, linkedAt: r.linked_at }));
  }

  /** Only the owner can revoke their own link (the row must belong to userId). */
  async revokePersonalIdentity(id: string, userId: string, by: string) {
    const rows = check<Array<{ id: string }>>(
      "revokeIdentity",
      await this.db.from("ai_channel_identities").update({ status: "revoked", revoked_at: new Date().toISOString(), revoked_by: by }).eq("id", id).eq("internal_user_id", userId).eq("status", "active").select("id"),
    );
    return rows.length > 0;
  }

  // ---------------------------------------------------------------- assistant
  async countRequestsSince(userId: string, since: Date) {
    const res = await this.db.from("ai_system_requests").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since.toISOString());
    if (res.error) throw new SystemStoreError("countRequests", res.error.code);
    return res.count ?? 0;
  }

  async reserve(r: { userId: string; channel: string; feature: "system_plan" | "system_answer"; provider: string; model: string; estimated: number; dayStart: Date; limits: AiConfig["limits"] }): Promise<ReserveResult> {
    const out = check<{ ok: boolean; id?: string; reason?: string }>(
      "reserve",
      await this.db.rpc("ai_system_reserve", {
        p_user: r.userId,
        p_channel: r.channel,
        p_feature: r.feature,
        p_provider: r.provider.slice(0, 32),
        p_model: r.model.slice(0, 64),
        p_estimated: r.estimated,
        p_day_start: r.dayStart.toISOString(),
        p_max_user_day: r.limits.maxRequestsPerUserPerDay,
        p_max_day: r.limits.maxRequestsPerDay,
        p_max_minute: r.limits.maxRequestsPerMinute,
        p_cooldown_minutes: r.limits.quotaCooldownMinutes,
      }),
    );
    return out.ok && out.id ? { ok: true, id: out.id } : { ok: false, reason: out.reason ?? "global_daily" };
  }

  async finish(id: string, r: { status: "completed" | "failed"; reason: string | null; inputTokens: number; outputTokens: number; confirmed: boolean; attempts: number; durationMs: number }) {
    check("finish", await this.db.rpc("zp_ai_finish", { p_id: id, p_status: r.status, p_reason: r.reason, p_input: r.inputTokens, p_output: r.outputTokens, p_confirmed: r.confirmed, p_attempts: r.attempts, p_redactions: 0, p_duration: r.durationMs }));
  }

  async recordRequest(r: RequestRecord) {
    const row = check<{ id: string }>(
      "recordRequest",
      await this.db.from("ai_system_requests").insert({ user_id: r.userId, channel: r.channel, audience: r.audience, status: r.status, planner: r.planner, synthesis: r.synthesis, reason: r.reason && /^[a-z_]{1,64}$/.test(r.reason) ? r.reason : null, tools: r.tools, duration_ms: r.durationMs }).select("id").single(),
    );
    return row.id;
  }

  async recordToolCalls(requestId: string, userId: string | null, calls: ToolCallRecord[]) {
    if (!calls.length) return;
    check("recordToolCalls", await this.db.from("ai_system_tool_calls").insert(calls.map((c) => ({ request_id: requestId, user_id: userId, tool: c.tool, sensitivity: c.sensitivity, outcome: c.outcome, scope: boundedScope(c.scope), row_count: c.rowCount, duration_ms: c.durationMs }))));
  }

  // ---------------------------------------------------------------- status (page)
  async usageToday(userId: string, dayStart: Date) {
    const res = await this.db.from("ai_request_usage").select("status, feature").eq("user_id", userId).in("feature", ["system_plan", "system_answer"]).gte("created_at", dayStart.toISOString()).limit(2000);
    if (res.error) throw new SystemStoreError("usageToday", res.error.code);
    const rows = (res.data ?? []) as Array<{ status: string }>;
    return { modelCalls: rows.filter((r) => r.status === "running" || r.status === "completed" || r.status === "failed").length };
  }
}

/** The audit scope must stay small and figure-free (DB CHECK: ≤ 2000 bytes). */
function boundedScope(scope: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(scope ?? {});
  return json.length <= 1800 ? scope : { truncated: true };
}
