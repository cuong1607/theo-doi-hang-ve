// ============================================================
// ZALO PERSONAL Phase 04 — AiStore over the service-role client (server only).
// Called ONLY by ai/service.ts after the reader's scope was computed. Scoped
// reads use the 00075 SQL functions; every query is bounded (period + limit)
// and has a client-side timeout. No prompt / answer text is ever logged.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { AI_PROMPT_VERSION, type AiConfig } from "../../ai-assistant/config.ts";
import type { SummaryKind } from "../../ai-assistant/prompts.ts";
import type { ConversationScope } from "../dashboard/access.ts";
import type { AiMessageRow, AiSearchFilter, AiStore, FactKind, FactRecord, ReserveResult, SessionRecord, StoredSummaryContent, SummaryRecord, TurnRecord, UsageAggregate, UsageRecord } from "./service.ts";

type Raw = Record<string, unknown>;

class AiStoreError extends Error {
  constructor(op: string, code: string | undefined) {
    super(`zalo-personal ai store: ${op} failed (${code ?? "unknown"})`);
    this.name = "AiStoreError";
  }
}

function check<T>(op: string, res: { data: T | null; error: { code?: string } | null }): T {
  if (res.error) throw new AiStoreError(op, res.error.code);
  return res.data as T;
}

const QUERY_TIMEOUT_MS = 8_000;
const signal = () => AbortSignal.timeout(QUERY_TIMEOUT_MS);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function messageRow(r: Raw): AiMessageRow {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    conversationId: String(r.conversation_id),
    conversationType: r.conversation_type === "user" || r.conversation_type === "group" ? r.conversation_type : undefined,
    externalConversationId: s(r.external_conversation_id) ?? undefined,
    groupName: s(r.group_name),
    senderExternalId: String(r.sender_external_id),
    messageType: String(r.message_type),
    textContent: s(r.text_content),
    contentStored: r.content_stored === true,
    textLength: num(r.text_length),
    isSelf: r.is_self === true,
    messageAt: new Date(String(r.message_at)).toISOString(),
    rank: r.rank === undefined ? undefined : num(r.rank),
  };
}

const scopeArgs = (s: ConversationScope) => ({ p_full: s.full, p_group: s.group, p_ids: s.ids });

const TURN_COLS = "id, session_id, user_id, question, status, notice, answer, source_message_ids, scope_conversation_ids, period, provider, model, cache_key, created_at";
function turnRow(r: Raw): TurnRecord {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    userId: String(r.user_id),
    question: String(r.question),
    status: r.status as TurnRecord["status"],
    notice: s(r.notice),
    answer: (r.answer ?? {}) as TurnRecord["answer"],
    sourceMessageIds: (r.source_message_ids as string[] | null) ?? [],
    scopeConversationIds: (r.scope_conversation_ids as string[] | null) ?? [],
    period: r.period as TurnRecord["period"],
    provider: s(r.provider),
    model: s(r.model),
    cacheKey: s(r.cache_key),
    createdAt: String(r.created_at),
  };
}

const SUMMARY_COLS = "id, namespace, connection_id, conversation_id, kind, topic, period_start, period_end, message_count, source_fingerprint, summary_version, prompt_version, provider, model, content, status, stale_reason, created_at";
function summaryRow(r: Raw): SummaryRecord {
  return {
    id: String(r.id),
    namespace: String(r.namespace),
    connectionId: String(r.connection_id),
    conversationId: String(r.conversation_id),
    kind: r.kind as SummaryKind,
    topic: s(r.topic),
    periodStart: String(r.period_start),
    periodEnd: String(r.period_end),
    messageCount: num(r.message_count),
    sourceFingerprint: String(r.source_fingerprint),
    summaryVersion: num(r.summary_version),
    promptVersion: String(r.prompt_version),
    provider: String(r.provider),
    model: String(r.model),
    content: r.content as StoredSummaryContent,
    status: r.status as SummaryRecord["status"],
    staleReason: s(r.stale_reason),
    createdAt: String(r.created_at),
  };
}

const FACT_COLS = "id, conversation_id, connection_id, summary_id, kind, statement, value_date, confidence, evidence_status, status, stale_reason, created_at";

export class SupabaseAiStore implements AiStore {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async search(scope: ConversationScope, f: AiSearchFilter): Promise<AiMessageRow[]> {
    const rows = check<Raw[]>(
      "search",
      await this.db
        .rpc("zp_ai_search", {
          ...scopeArgs(scope),
          p_conversation_ids: f.conversationIds,
          p_connection_id: f.connectionId,
          p_type: null,
          p_sender: null,
          p_message_type: null,
          p_from: f.from.toISOString(),
          p_to: f.to.toISOString(),
          p_terms: f.terms,
          p_limit: f.limit,
        })
        .abortSignal(signal()),
    );
    return rows.map(messageRow);
  }

  async context(conversationId: string, at: string, id: string, before: number, after: number): Promise<AiMessageRow[]> {
    const rows = check<Raw[]>("context", await this.db.rpc("zp_ai_context", { p_conversation_id: conversationId, p_at: at, p_id: id, p_before: before, p_after: after }).abortSignal(signal()));
    return rows.map(messageRow);
  }

  async range(conversationId: string, from: Date, to: Date, limit: number): Promise<{ rows: AiMessageRow[]; total: number }> {
    const rows = check<Raw[]>("range", await this.db.rpc("zp_ai_range", { p_conversation_id: conversationId, p_from: from.toISOString(), p_to: to.toISOString(), p_limit: limit }).abortSignal(signal()));
    return { rows: rows.map(messageRow), total: rows.length ? num(rows[0]!.total) : 0 };
  }

  async messagesByIds(ids: string[]): Promise<AiMessageRow[]> {
    if (ids.length === 0) return [];
    const rows = check<Raw[]>("messagesByIds", await this.db.rpc("zp_ai_messages_by_ids", { p_ids: ids.slice(0, 400) }).abortSignal(signal()));
    return rows.map(messageRow);
  }

  async factSources(conversationIds: string[], terms: string[], limit: number): Promise<string[]> {
    if (conversationIds.length === 0 || terms.length === 0) return [];
    const rows = check<Raw[]>("factSources", await this.db.rpc("zp_ai_fact_sources", { p_conversation_ids: conversationIds, p_terms: terms, p_limit: limit }).abortSignal(signal()));
    return rows.map((r) => String(r.message_id));
  }

  async reserve(userId: string, feature: "ask" | "summarize", provider: string, model: string, estimated: number, dayStart: Date, l: AiConfig["limits"]): Promise<ReserveResult> {
    const r = check<{ ok: boolean; id?: string; reason?: string }>(
      "reserve",
      await this.db.rpc("zp_ai_reserve", {
        p_user: userId,
        p_feature: feature,
        p_provider: provider,
        p_model: model,
        p_estimated: estimated,
        p_day_start: dayStart.toISOString(),
        p_max_user_day: l.maxRequestsPerUserPerDay,
        p_max_day: l.maxRequestsPerDay,
        p_max_minute: l.maxRequestsPerMinute,
        p_cooldown_minutes: l.quotaCooldownMinutes,
      }),
    );
    return r.ok && r.id ? { ok: true, id: r.id } : { ok: false, reason: (r.reason ?? "global_daily") as Exclude<ReserveResult, { ok: true }>["reason"] };
  }

  async finish(id: string, r: { status: "completed" | "failed"; reason: string | null; inputTokens: number; outputTokens: number; confirmed: boolean; attempts: number; redactions: number; durationMs: number }): Promise<void> {
    check("finish", await this.db.rpc("zp_ai_finish", { p_id: id, p_status: r.status, p_reason: r.reason, p_input: r.inputTokens, p_output: r.outputTokens, p_confirmed: r.confirmed, p_attempts: r.attempts, p_redactions: r.redactions, p_duration: r.durationMs }));
  }

  async record(r: UsageRecord): Promise<void> {
    check("record", await this.db.from("ai_request_usage").insert({ user_id: r.userId, feature: r.feature, provider: r.provider, model: r.model.slice(0, 64), status: r.status, reason: r.reason, finished_at: new Date().toISOString() }));
  }

  async apiCallsSince(userId: string, since: Date): Promise<number> {
    const res = await this.db.from("ai_request_usage").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since.toISOString());
    if (res.error) throw new AiStoreError("apiCallsSince", res.error.code);
    return res.count ?? 0;
  }

  async usage(userId: string | null, since: Date): Promise<UsageAggregate> {
    let q = this.db.from("ai_request_usage").select("status, reason, model, input_tokens, output_tokens, tokens_confirmed, created_at").gte("created_at", since.toISOString()).order("created_at", { ascending: false }).limit(5000);
    if (userId) q = q.eq("user_id", userId);
    const rows = check<Raw[]>("usage", await q);
    const agg: UsageAggregate = { calls: 0, completed: 0, failed: 0, rejected: 0, skipped: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, confirmedCalls: 0, reasons: {}, models: {}, lastQuotaErrorAt: null };
    for (const r of rows) {
      const st = String(r.status);
      if (st === "running" || st === "completed" || st === "failed") {
        agg.calls++;
        agg.models[String(r.model)] = (agg.models[String(r.model)] ?? 0) + 1;
      }
      if (st === "completed") agg.completed++;
      if (st === "failed") agg.failed++;
      if (st === "rejected") agg.rejected++;
      if (st === "skipped") agg.skipped++;
      if (st === "cache_hit") agg.cacheHits++;
      agg.inputTokens += num(r.input_tokens);
      agg.outputTokens += num(r.output_tokens);
      if (r.tokens_confirmed === true) agg.confirmedCalls++;
      const reason = s(r.reason);
      if (reason) agg.reasons[reason] = (agg.reasons[reason] ?? 0) + 1;
      if (st === "failed" && reason === "quota_exceeded" && !agg.lastQuotaErrorAt) agg.lastQuotaErrorAt = String(r.created_at);
    }
    return agg;
  }

  async cachedTurn(userId: string, cacheKey: string, since: Date): Promise<TurnRecord | null> {
    const rows = check<Raw[]>("cachedTurn", await this.db.from("ai_assistant_turns").select(TURN_COLS).eq("user_id", userId).eq("cache_key", cacheKey).gte("created_at", since.toISOString()).in("status", ["answered", "insufficient"]).order("created_at", { ascending: false }).limit(1));
    return rows[0] ? turnRow(rows[0]) : null;
  }

  async session(id: string): Promise<SessionRecord | null> {
    const r = check<Raw | null>("session", await this.db.from("ai_assistant_sessions").select("id, user_id, title, created_at, updated_at").eq("id", id).maybeSingle());
    return r ? { id: String(r.id), userId: String(r.user_id), title: String(r.title), createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : null;
  }

  async sessions(userId: string, limit: number): Promise<SessionRecord[]> {
    const rows = check<Raw[]>("sessions", await this.db.from("ai_assistant_sessions").select("id, user_id, title, created_at, updated_at, ai_assistant_turns(count)").eq("user_id", userId).order("updated_at", { ascending: false }).limit(limit));
    return rows.map((r) => ({ id: String(r.id), userId: String(r.user_id), title: String(r.title), createdAt: String(r.created_at), updatedAt: String(r.updated_at), turns: num((r.ai_assistant_turns as Array<{ count: number }> | undefined)?.[0]?.count) }));
  }

  async createSession(userId: string, title: string): Promise<string> {
    const r = check<Raw>("createSession", await this.db.from("ai_assistant_sessions").insert({ user_id: userId, title: title.trim().slice(0, 120) || "Câu hỏi" }).select("id").single());
    return String(r.id);
  }

  async touchSession(id: string): Promise<void> {
    check("touchSession", await this.db.from("ai_assistant_sessions").update({ updated_at: new Date().toISOString() }).eq("id", id));
  }

  async insertTurn(t: Omit<TurnRecord, "id" | "createdAt"> & { promptVersion: string; usageId: string | null }): Promise<TurnRecord> {
    const r = check<Raw>(
      "insertTurn",
      await this.db
        .from("ai_assistant_turns")
        .insert({
          session_id: t.sessionId,
          user_id: t.userId,
          question: t.question,
          status: t.status,
          notice: t.notice,
          answer: t.answer,
          source_message_ids: t.sourceMessageIds,
          scope_conversation_ids: t.scopeConversationIds,
          period: t.period,
          provider: t.provider,
          model: t.model,
          prompt_version: t.promptVersion,
          cache_key: t.cacheKey,
          usage_id: t.usageId,
        })
        .select(TURN_COLS)
        .single(),
    );
    return turnRow(r);
  }

  async turns(sessionId: string): Promise<TurnRecord[]> {
    const rows = check<Raw[]>("turns", await this.db.from("ai_assistant_turns").select(TURN_COLS).eq("session_id", sessionId).order("created_at", { ascending: true }).limit(50));
    return rows.map(turnRow);
  }

  async validateMemory(conversationIds: string[]): Promise<void> {
    if (conversationIds.length === 0) return;
    check("validateMemory", await this.db.rpc("zp_ai_validate_memory", { p_conversation_ids: conversationIds }));
  }

  async freshSummary(conversationId: string, kind: SummaryKind, topic: string | null, start: Date, end: Date): Promise<SummaryRecord | null> {
    let q = this.db.from("ai_conversation_summaries").select(SUMMARY_COLS).eq("conversation_id", conversationId).eq("kind", kind).eq("status", "fresh").eq("period_start", start.toISOString()).eq("period_end", end.toISOString());
    q = topic === null ? q.is("topic", null) : q.eq("topic", topic);
    const rows = check<Raw[]>("freshSummary", await q.order("created_at", { ascending: false }).limit(1));
    return rows[0] ? summaryRow(rows[0]) : null;
  }

  async storeSummary(a: Parameters<AiStore["storeSummary"]>[0]): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const r = check<{ ok: boolean; id?: string; error?: string }>(
      "storeSummary",
      await this.db.rpc("zp_ai_store_summary", {
        p_actor: a.actorId,
        p_connection_id: a.connectionId,
        p_conversation_id: a.conversationId,
        p_namespace: a.namespace,
        p_kind: a.kind,
        p_topic: a.topic,
        p_period_start: a.periodStart.toISOString(),
        p_period_end: a.periodEnd.toISOString(),
        p_input_ids: a.inputIds,
        p_fingerprint: a.fingerprint,
        p_prompt_version: AI_PROMPT_VERSION,
        p_provider: a.provider,
        p_model: a.model.slice(0, 64),
        p_content: a.content,
        p_facts: a.facts,
      }),
    );
    return r.ok && r.id ? { ok: true, id: r.id } : { ok: false, error: r.error ?? "store_failed" };
  }

  async summaries(conversationId: string, limit: number): Promise<SummaryRecord[]> {
    const rows = check<Raw[]>("summaries", await this.db.from("ai_conversation_summaries").select(SUMMARY_COLS).eq("conversation_id", conversationId).in("status", ["fresh", "stale"]).order("created_at", { ascending: false }).limit(limit));
    return rows.map(summaryRow);
  }

  async facts(conversationId: string, limit: number): Promise<FactRecord[]> {
    const rows = check<Raw[]>("facts", await this.db.from("ai_memory_facts").select(FACT_COLS).eq("conversation_id", conversationId).in("status", ["active", "stale"]).order("created_at", { ascending: false }).limit(limit));
    if (rows.length === 0) return [];
    const src = check<Raw[]>("factSourcesOf", await this.db.from("ai_memory_sources").select("memory_id, message_id").eq("memory_kind", "fact").in("memory_id", rows.map((r) => String(r.id))));
    return rows.map((r) => this.fact_(r, src.filter((x) => x.memory_id === r.id).map((x) => String(x.message_id))));
  }

  async fact(id: string): Promise<FactRecord | null> {
    const r = check<Raw | null>("fact", await this.db.from("ai_memory_facts").select(FACT_COLS).eq("id", id).maybeSingle());
    return r ? this.fact_(r, []) : null;
  }

  async reviewFact(id: string, actorId: string, evidence: "user_confirmed" | "user_rejected"): Promise<boolean> {
    const rows = check<Raw[]>("reviewFact", await this.db.from("ai_memory_facts").update({ evidence_status: evidence, reviewed_by: actorId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).eq("status", "active").neq("evidence_status", evidence).select("id"));
    return rows.length > 0;
  }

  private fact_(r: Raw, sources: string[]): FactRecord {
    return {
      id: String(r.id),
      conversationId: String(r.conversation_id),
      connectionId: String(r.connection_id),
      summaryId: s(r.summary_id),
      kind: r.kind as FactKind,
      statement: String(r.statement),
      valueDate: s(r.value_date),
      confidence: num(r.confidence),
      evidenceStatus: r.evidence_status as FactRecord["evidenceStatus"],
      status: r.status as FactRecord["status"],
      staleReason: s(r.stale_reason),
      sourceMessageIds: sources,
      createdAt: String(r.created_at),
    };
  }
}
