// ============================================================
// ZALO PERSONAL Phase 04 — Ask AI, summaries and memory over the Zalo
// Personal conversations a user may ALREADY read (Phase 03 scope: owner /
// grants). Pure orchestration over injected stores + provider (unit tested).
//
// RAG pipeline (ask):
//   1 authenticate (route) → 2 role zalo_personal:ai + data scope (access.ts)
//   3 conversations picked by the client are re-loaded and re-authorized
//   4 period resolved on the server clock (time-range.ts) + route (router.ts)
//   5 retrieve inside the scope (full-text / recent) + fact-linked sources
//   6 neighbours of the best hits → 7 dedupe → 8 token budget (context.ts)
//   9 data policy + budget reservation → provider (Gemini) with bounded retry
//  10 answer JSON validated → 11 citations checked against the retrieved set
//  12 stored per user (session), re-checked against the CURRENT scope on read
// Without permission to send data / budget / AI on, the user still gets the
// retrieved sources ("sources_only"), never a made-up answer.
//
// Never: Web / OA history as input, tools for the model, sending Zalo
// messages, logging prompts or answers.
// ============================================================
import { createHash } from "node:crypto";

import { hasPermission } from "../../auth/permissions.ts";
import { estimateTokens, generateWithRetry, AI_ERROR_TEXT, AiProviderError, type AiErrorCategory, type AiTextProvider } from "../../ai-assistant/provider.ts";
import { AI_PROMPT_VERSION, providerReadiness, type AiConfig, type AiUnavailableReason } from "../../ai-assistant/config.ts";
import { buildContext, type SourceMessage } from "../../ai-assistant/context.ts";
import { parseModelJson, validateClaims, type CitedClaim } from "../../ai-assistant/citations.ts";
import { namespaceOf, sharingDecision, SHARING_TEXT } from "../../ai-assistant/policy.ts";
import {
  ANSWER_JSON_SCHEMA,
  answerSchema,
  askSystemPrompt,
  askUserPrompt,
  INSUFFICIENT_TEXT,
  SUMMARY_JSON_SCHEMA,
  summarySchema,
  summarySystemPrompt,
  summaryUserPrompt,
  type SummaryKind,
} from "../../ai-assistant/prompts.ts";
import { redact } from "../../ai-assistant/redact.ts";
import { route } from "../../ai-assistant/router.ts";
import { foldVi, topicKeywords } from "../../ai-assistant/text.ts";
import { presetPeriod, resolvePeriod, PERIOD_ERROR_TEXT, type Period, type PeriodPreset } from "../../ai-assistant/time-range.ts";
import { buildScope, can, canReadConversation, conversationScope, hasAnyAccess, isEmptyConversationScope, type AccessScope, type Actor, type ConversationScope } from "../dashboard/access.ts";
import { conversationTitle, maskId, MESSAGE_TYPE_LABEL, signalsOf, type ConversationRow, type DashboardStore } from "../dashboard/service.ts";
import { classifyWorker, HEALTH_LABEL } from "../dashboard/status.ts";

// ------------------------------------------------------------ store contract

export interface AiMessageRow {
  id: string;
  connectionId: string;
  conversationId: string;
  conversationType?: "user" | "group";
  externalConversationId?: string;
  groupName?: string | null;
  senderExternalId: string;
  messageType: string;
  textContent: string | null;
  contentStored: boolean;
  textLength: number;
  isSelf: boolean;
  messageAt: string;
  rank?: number;
}

export interface AiSearchFilter {
  conversationIds: string[] | null;
  connectionId: string | null;
  from: Date;
  to: Date;
  terms: string[];
  limit: number;
}

export type ReserveResult = { ok: true; id: string } | { ok: false; reason: "concurrent" | "quota_cooldown" | "global_daily" | "user_daily" | "model_minute" };

export interface UsageRecord {
  userId: string;
  feature: "ask" | "summarize";
  provider: string;
  model: string;
  status: "rejected" | "skipped" | "cache_hit";
  reason: string | null;
}

export interface UsageAggregate {
  calls: number;
  completed: number;
  failed: number;
  rejected: number;
  skipped: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  confirmedCalls: number;
  reasons: Record<string, number>;
  models: Record<string, number>;
  lastQuotaErrorAt: string | null;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  userId: string;
  question: string;
  status: "answered" | "insufficient" | "sources_only" | "failed";
  notice: string | null;
  answer: { answer?: string; points?: Array<{ text: string; messageIds: string[] }> };
  sourceMessageIds: string[];
  scopeConversationIds: string[];
  period: { label: string; fromDate: string; toDate: string; preset: string };
  provider: string | null;
  model: string | null;
  cacheKey: string | null;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns?: number;
}

export interface SummaryRecord {
  id: string;
  namespace: string;
  connectionId: string;
  conversationId: string;
  kind: SummaryKind;
  topic: string | null;
  periodStart: string;
  periodEnd: string;
  messageCount: number;
  sourceFingerprint: string;
  summaryVersion: number;
  promptVersion: string;
  provider: string;
  model: string;
  content: StoredSummaryContent;
  status: "fresh" | "stale" | "superseded";
  staleReason: string | null;
  createdAt: string;
}

export interface FactRecord {
  id: string;
  conversationId: string;
  connectionId: string;
  summaryId: string | null;
  kind: FactKind;
  statement: string;
  valueDate: string | null;
  confidence: number;
  evidenceStatus: "ai_inferred" | "user_confirmed" | "user_rejected";
  status: "active" | "stale" | "superseded";
  staleReason: string | null;
  sourceMessageIds: string[];
  createdAt: string;
}

export type FactKind = "fact" | "decision" | "project_ref" | "assignment" | "open_question" | "important_date";

export interface StoredSummaryContent {
  summary: string;
  points: CitedClaim[];
  decisions: CitedClaim[];
  assignments: CitedClaim[];
  openQuestions: CitedClaim[];
  importantDates: CitedClaim[];
  projectRefs: CitedClaim[];
  truncated: boolean;
  periodLabel: string;
}

export interface AiStore {
  search(scope: ConversationScope, f: AiSearchFilter): Promise<AiMessageRow[]>;
  context(conversationId: string, at: string, id: string, before: number, after: number): Promise<AiMessageRow[]>;
  range(conversationId: string, from: Date, to: Date, limit: number): Promise<{ rows: AiMessageRow[]; total: number }>;
  messagesByIds(ids: string[]): Promise<AiMessageRow[]>;
  factSources(conversationIds: string[], terms: string[], limit: number): Promise<string[]>;
  reserve(userId: string, feature: "ask" | "summarize", provider: string, model: string, estimated: number, dayStart: Date, c: AiConfig["limits"]): Promise<ReserveResult>;
  finish(id: string, r: { status: "completed" | "failed"; reason: string | null; inputTokens: number; outputTokens: number; confirmed: boolean; attempts: number; redactions: number; durationMs: number }): Promise<void>;
  record(r: UsageRecord): Promise<void>;
  apiCallsSince(userId: string, since: Date): Promise<number>;
  usage(userId: string | null, since: Date): Promise<UsageAggregate>;
  cachedTurn(userId: string, cacheKey: string, since: Date): Promise<TurnRecord | null>;
  session(id: string): Promise<SessionRecord | null>;
  sessions(userId: string, limit: number): Promise<SessionRecord[]>;
  createSession(userId: string, title: string): Promise<string>;
  touchSession(id: string): Promise<void>;
  insertTurn(t: Omit<TurnRecord, "id" | "createdAt"> & { promptVersion: string; usageId: string | null }): Promise<TurnRecord>;
  turns(sessionId: string): Promise<TurnRecord[]>;
  validateMemory(conversationIds: string[]): Promise<void>;
  freshSummary(conversationId: string, kind: SummaryKind, topic: string | null, start: Date, end: Date): Promise<SummaryRecord | null>;
  storeSummary(a: {
    actorId: string;
    connectionId: string;
    conversationId: string;
    namespace: string;
    kind: SummaryKind;
    topic: string | null;
    periodStart: Date;
    periodEnd: Date;
    inputIds: string[];
    fingerprint: string;
    provider: string;
    model: string;
    content: StoredSummaryContent;
    facts: Array<{ kind: FactKind; statement: string; valueDate: string | null; confidence: number; messageIds: string[] }>;
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  summaries(conversationId: string, limit: number): Promise<SummaryRecord[]>;
  facts(conversationId: string, limit: number): Promise<FactRecord[]>;
  fact(id: string): Promise<FactRecord | null>;
  reviewFact(id: string, actorId: string, evidence: "user_confirmed" | "user_rejected"): Promise<boolean>;
}

export interface AiDeps {
  dashboard: DashboardStore;
  store: AiStore;
  config: AiConfig;
  /** creates the provider lazily (may throw AiProviderError config_missing / model_invalid) */
  provider: () => AiTextProvider;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

// ------------------------------------------------------------ results

export type AiErrorCode = "forbidden" | "not_found" | "invalid_input" | "rate_limited" | "conflict" | "server_error";
export type AiResult<T> = { ok: true; data: T } | { ok: false; error: AiErrorCode; code: string; message: string };
const STATUS: Record<AiErrorCode, number> = { forbidden: 403, not_found: 404, invalid_input: 400, rate_limited: 429, conflict: 409, server_error: 500 };
export const aiHttpStatus = (e: AiErrorCode): number => STATUS[e];

const ok = <T>(data: T): AiResult<T> => ({ ok: true, data });
const fail = <T>(error: AiErrorCode, code: string, message: string): AiResult<T> => ({ ok: false, error, code, message });
const NOT_FOUND = <T>(): AiResult<T> => fail("not_found", "not_found", "Không tìm thấy hoặc bạn không có quyền xem.");
const FORBIDDEN = <T>(m = "Bạn không có quyền dùng Hỏi AI cho Zalo cá nhân."): AiResult<T> => fail("forbidden", "forbidden", m);

// ------------------------------------------------------------ views

export interface CitationView {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  conversationType: "user" | "group";
  senderLabel: string;
  at: string;
  typeLabel: string;
  /** plain text snippet (rendered as text) */
  snippet: string | null;
  href: string;
}

export interface NoticeView {
  code: string;
  text: string;
  tone: "info" | "warning" | "danger";
}

export interface TurnView {
  id: string;
  question: string;
  status: TurnRecord["status"];
  notice: NoticeView | null;
  answer: string | null;
  points: Array<{ text: string; citations: CitationView[] }>;
  sources: CitationView[];
  period: { label: string; fromDate: string; toDate: string };
  createdAt: string;
  model: string | null;
  cached: boolean;
  hiddenForAccess: boolean;
}

export interface CoverageView {
  messagesConsidered: number;
  droppedForBudget: number;
  lastSyncAt: string | null;
  warnings: string[];
}

export interface AskResult {
  sessionId: string;
  turn: TurnView;
  coverage: CoverageView;
}

const NOTICE: Record<string, NoticeView> = {
  no_sources: { code: "no_sources", text: INSUFFICIENT_TEXT, tone: "info" },
  insufficient: { code: "insufficient", text: INSUFFICIENT_TEXT, tone: "info" },
  ai_disabled: { code: "ai_disabled", text: "AI đang tắt (AI_ENABLED). Dưới đây là các tin liên quan tìm được, chưa được AI xử lý.", tone: "info" },
  feature_disabled: { code: "feature_disabled", text: "Hỏi AI cho Zalo cá nhân đang tắt (ZALO_PERSONAL_AI_ENABLED). Dưới đây là các tin liên quan tìm được.", tone: "info" },
  config_missing: { code: "config_missing", text: `${AI_ERROR_TEXT.config_missing} Dưới đây là các tin liên quan tìm được.`, tone: "warning" },
  model_invalid: { code: "model_invalid", text: `${AI_ERROR_TEXT.model_invalid} Dưới đây là các tin liên quan tìm được.`, tone: "warning" },
  policy_none: { code: "policy_none", text: SHARING_TEXT.policy_none, tone: "info" },
  free_tier_not_approved: { code: "free_tier_not_approved", text: SHARING_TEXT.free_tier_not_approved, tone: "warning" },
  user_daily: { code: "user_daily", text: "Bạn đã dùng hết lượt hỏi AI hôm nay. Dưới đây là các tin liên quan tìm được.", tone: "warning" },
  global_daily: { code: "global_daily", text: "Hệ thống đã dùng hết hạn mức AI hôm nay. Dưới đây là các tin liên quan tìm được.", tone: "warning" },
  model_minute: { code: "model_minute", text: "AI đang nhận quá nhiều yêu cầu. Vui lòng thử lại sau 1 phút. Dưới đây là các tin liên quan tìm được.", tone: "warning" },
  concurrent: { code: "concurrent", text: "Bạn đang có một yêu cầu AI chưa xong. Vui lòng đợi rồi thử lại.", tone: "warning" },
  quota_cooldown: { code: "quota_cooldown", text: "AI tạm hết hạn mức (nhà cung cấp báo hết quota). Hệ thống tạm dừng gọi AI một thời gian. Dưới đây là các tin liên quan tìm được.", tone: "warning" },
  access_changed: { code: "access_changed", text: "Câu trả lời này dựa trên hội thoại bạn không còn quyền xem nên đã được ẩn.", tone: "warning" },
};

const noticeOf = (code: string | null): NoticeView | null => {
  if (!code) return null;
  if (NOTICE[code]) return NOTICE[code]!;
  const cat = code as AiErrorCategory;
  if (cat in AI_ERROR_TEXT) return { code, text: `${AI_ERROR_TEXT[cat]} Dưới đây là các tin liên quan tìm được.`, tone: cat === "quota_exceeded" || cat === "rate_limit" ? "warning" : "danger" };
  return { code, text: "Không xử lý được bằng AI. Dưới đây là các tin liên quan tìm được.", tone: "warning" };
};

// ------------------------------------------------------------ helpers

const SENDER = (m: AiMessageRow) => (m.isSelf ? "Chủ tài khoản" : `Người gửi ${maskId(m.senderExternalId)}`);
const titleOf = (m: { conversationType?: "user" | "group"; externalConversationId?: string; groupName?: string | null }) =>
  m.conversationType && m.externalConversationId ? conversationTitle({ conversationType: m.conversationType, externalConversationId: m.externalConversationId, groupName: m.groupName }) : "Hội thoại";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const VN_DAY_START = (now: Date) => presetPeriod("today", now).start;

function citation(m: AiMessageRow): CitationView {
  return {
    messageId: m.id,
    conversationId: m.conversationId,
    conversationTitle: titleOf(m),
    conversationType: m.conversationType ?? "group",
    senderLabel: SENDER(m),
    at: m.messageAt,
    typeLabel: MESSAGE_TYPE_LABEL[m.messageType] ?? "Loại chưa hỗ trợ",
    snippet: m.contentStored && m.textContent ? m.textContent.replace(/\s+/g, " ").slice(0, 240) : null,
    href: `/apps/zalo/personal/conversations/${m.conversationId}?focus=${m.id}&at=${encodeURIComponent(m.messageAt)}`,
  };
}

function toSource(m: AiMessageRow, priority: number): SourceMessage {
  return {
    id: m.id,
    conversationId: m.conversationId,
    conversationTitle: titleOf(m),
    conversationType: m.conversationType ?? "group",
    senderLabel: SENDER(m),
    isSelf: m.isSelf,
    at: m.messageAt,
    messageType: m.messageType,
    text: m.contentStored ? m.textContent : null,
    priority,
  };
}

async function loadScope(deps: AiDeps, actor: Actor): Promise<AccessScope> {
  if (!hasPermission(actor.role, "zalo_personal:use")) return buildScope(actor, [], []);
  const { connections, grants } = await deps.dashboard.loadAccess(actor.userId);
  return buildScope(actor, connections, grants);
}

const readable = (scope: AccessScope, m: AiMessageRow) => !!m.conversationType && canReadConversation(scope, { id: m.conversationId, connectionId: m.connectionId, conversationType: m.conversationType });

async function gate(deps: AiDeps, actor: Actor): Promise<{ ok: true; scope: AccessScope } | { ok: false; result: AiResult<never> }> {
  if (!hasPermission(actor.role, "zalo_personal:ai") || !hasPermission(actor.role, "zalo_personal:use")) return { ok: false, result: FORBIDDEN() };
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return { ok: false, result: FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.") };
  return { ok: true, scope };
}

async function rateLimited(deps: AiDeps, actor: Actor, now: Date): Promise<boolean> {
  return (await deps.store.apiCallsSince(actor.userId, new Date(now.getTime() - 60_000))) >= deps.config.limits.maxApiCallsPerUserPerMinute;
}

/** Resolves the conversations a request may use. Client ids are re-loaded and re-authorized. */
async function resolveConversations(deps: AiDeps, scope: AccessScope, ids: string[] | undefined, connectionId: string | undefined): Promise<AiResult<{ cs: ConversationScope; rows: ConversationRow[]; picked: boolean }>> {
  if (ids && ids.length > 0) {
    const rows: ConversationRow[] = [];
    for (const id of [...new Set(ids)]) {
      const c = await deps.dashboard.conversation(id);
      if (!c || !canReadConversation(scope, c)) return NOT_FOUND();
      if (connectionId && c.connectionId !== connectionId) return NOT_FOUND();
      rows.push(c);
    }
    return ok({ cs: { full: [], group: [], ids: rows.map((r) => r.id) }, rows, picked: true });
  }
  if (connectionId && !scope.connections.has(connectionId)) return NOT_FOUND();
  return ok({ cs: conversationScope(scope, connectionId ?? null), rows: [], picked: false });
}

async function coverage(deps: AiDeps, scope: AccessScope, connectionIds: string[], rows: ConversationRow[], period: Period, considered: number, dropped: number, now: Date): Promise<CoverageView> {
  const warnings: string[] = [];
  const ids = [...new Set(connectionIds)].filter((id) => can(scope, id, "view_connection") || scope.connections.get(id)?.owner);
  let lastSyncAt: string | null = null;
  if (ids.length > 0) {
    const [conns, workers] = await Promise.all([deps.dashboard.connections(ids), deps.dashboard.workers(ids)]);
    for (const c of conns) {
      const ws = workers.filter((w) => w.connectionId === c.id);
      const health = ws.map((w) => classifyWorker(signalsOf(w), { status: c.status, lastErrorCategory: c.lastErrorCategory }, now));
      const best = health.sort((a, b) => (a.heartbeatAgeMs ?? Infinity) - (b.heartbeatAgeMs ?? Infinity))[0];
      const last = ws.map((w) => w.sync?.lastIngestedAt ?? null).filter(Boolean).sort().at(-1) ?? null;
      if (last && (!lastSyncAt || last > lastSyncAt)) lastSyncAt = last;
      if (!best || best.health !== "connected") {
        warnings.push(`Kết nối ${c.connectionKey}: worker ${best ? HEALTH_LABEL[best.health].toLowerCase() : "chưa từng gửi heartbeat"}. Tin nhắn ${c.lastHeartbeatAt ? "sau lần đồng bộ cuối" : ""} có thể chưa được lưu, nên câu trả lời có thể thiếu.`.replace(/\s+/g, " "));
      }
    }
  }
  const firsts = rows.map((r) => r.firstMessageAt).filter((v): v is string => !!v).sort();
  if (rows.length > 0 && firsts[0] && Date.parse(firsts[0]) > period.start.getTime()) {
    warnings.push(`Hệ thống chỉ có tin của hội thoại đã chọn từ ${new Date(Date.parse(firsts[0]) + 7 * 3_600_000).toISOString().slice(0, 10).split("-").reverse().join("/")} (thời điểm bắt đầu lưu). Không có lịch sử trước đó.`);
  }
  if (dropped > 0) warnings.push(`Có ${dropped} tin liên quan không đưa vào AI vì vượt giới hạn ngữ cảnh. Hãy thu hẹp khoảng thời gian hoặc chọn một hội thoại.`);
  return { messagesConsidered: considered, droppedForBudget: dropped, lastSyncAt, warnings };
}

// ------------------------------------------------------------ status

export interface AiStatusView {
  enabled: boolean;
  unavailable: AiUnavailableReason | null;
  sharing: "allowed" | "policy_none" | "free_tier_not_approved";
  redacted: boolean;
  provider: string;
  model: string | null;
  tier: string;
  limits: { perUserPerDay: number; perDay: number; perMinute: number; maxInputTokens: number; maxOutputTokens: number };
  today: { calls: number; remaining: number };
}

export async function aiStatus(deps: AiDeps, actor: Actor): Promise<AiResult<AiStatusView>> {
  const g = await gate(deps, actor);
  if (!g.ok) return g.result;
  const now = (deps.now ?? (() => new Date()))();
  const r = providerReadiness(deps.config);
  const s = sharingDecision(deps.config);
  const own = await deps.store.usage(actor.userId, VN_DAY_START(now));
  const l = deps.config.limits;
  return ok({
    enabled: r.ready && s.allowed,
    unavailable: r.ready ? null : r.reason,
    sharing: s.allowed ? "allowed" : s.reason,
    redacted: s.allowed && s.redact,
    provider: deps.config.provider,
    model: deps.config.model,
    tier: deps.config.tier,
    limits: { perUserPerDay: l.maxRequestsPerUserPerDay, perDay: l.maxRequestsPerDay, perMinute: l.maxRequestsPerMinute, maxInputTokens: l.maxInputTokens, maxOutputTokens: l.maxOutputTokens },
    today: { calls: own.calls, remaining: Math.max(0, l.maxRequestsPerUserPerDay - own.calls) },
  });
}

// ------------------------------------------------------------ ask

export interface AskInput {
  sessionId?: string;
  question: string;
  conversationIds?: string[];
  connectionId?: string;
  period?: { preset: PeriodPreset; from?: string; to?: string };
}

const CONTEXT_OVERHEAD_TOKENS = 900; // system prompt + question framing (estimated)

export async function ask(deps: AiDeps, actor: Actor, input: AskInput): Promise<AiResult<AskResult>> {
  const now = (deps.now ?? (() => new Date()))();
  const g = await gate(deps, actor);
  if (!g.ok) return g.result;
  const scope = g.scope;
  if (await rateLimited(deps, actor, now)) return fail("rate_limited", "rate_limited", "Bạn hỏi quá nhanh. Vui lòng đợi 1 phút rồi thử lại.");

  const period = resolvePeriod(input.period, input.question, now);
  if (typeof period === "string") return fail("invalid_input", "invalid_period", PERIOD_ERROR_TEXT[period]);

  const conv = await resolveConversations(deps, scope, input.conversationIds, input.connectionId);
  if (!conv.ok) return conv;
  const { cs, rows: pickedRows } = conv.data;

  let session: SessionRecord | null = null;
  if (input.sessionId) {
    session = await deps.store.session(input.sessionId);
    if (!session || session.userId !== actor.userId) return NOT_FOUND();
  }

  // ---- retrieve (inside the scope only)
  const r = route(input.question);
  const filter = (terms: string[], limit: number): AiSearchFilter => ({ conversationIds: conv.data.picked ? cs.ids : null, connectionId: input.connectionId ?? null, from: period.start, to: period.end, terms, limit });
  const empty = isEmptyConversationScope(cs);
  const hits = !empty && r.strategy !== "recent" ? await deps.store.search(cs, filter(r.keywords, 40)) : [];
  const recent = !empty && r.strategy !== "keyword" ? await deps.store.search(cs, filter([], 80)) : [];
  const visibleHits = hits.filter((m) => readable(scope, m));
  const visibleRecent = recent.filter((m) => readable(scope, m));

  const convOf = new Map<string, AiMessageRow>();
  for (const m of [...visibleHits, ...visibleRecent]) if (!convOf.has(m.conversationId)) convOf.set(m.conversationId, m);
  for (const c of pickedRows) if (!convOf.has(c.id)) convOf.set(c.id, { id: "", connectionId: c.connectionId, conversationId: c.id, conversationType: c.conversationType, externalConversationId: c.externalConversationId, groupName: c.groupName, senderExternalId: "0", messageType: "text", textContent: null, contentStored: false, textLength: 0, isSelf: false, messageAt: now.toISOString() });
  const withConv = (m: AiMessageRow): AiMessageRow => {
    const c = convOf.get(m.conversationId);
    return c ? { ...m, conversationType: m.conversationType ?? c.conversationType, externalConversationId: m.externalConversationId ?? c.externalConversationId, groupName: m.groupName ?? c.groupName } : m;
  };

  // memory-assisted: raw sources of matching facts (facts are never evidence themselves)
  let factRows: AiMessageRow[] = [];
  if (r.keywords.length > 0 && convOf.size > 0) {
    const ids = await deps.store.factSources([...convOf.keys()], r.keywords, 20);
    if (ids.length) factRows = (await deps.store.messagesByIds(ids)).filter((m) => readable(scope, m) && Date.parse(m.messageAt) >= period.start.getTime() && Date.parse(m.messageAt) < period.end.getTime());
  }

  // neighbours of the best hits (same conversation → same authorization)
  const neighbours: AiMessageRow[] = [];
  for (const h of visibleHits.slice(0, 8)) {
    for (const n of await deps.store.context(h.conversationId, h.messageAt, h.id, 2, 2)) neighbours.push(withConv({ ...n, connectionId: h.connectionId, conversationId: h.conversationId }));
  }

  const candidates: SourceMessage[] = [
    ...visibleHits.map((m, i) => toSource(withConv(m), 1 + i / 1000)),
    ...factRows.map((m) => toSource(withConv(m), 1.5)),
    ...neighbours.filter((m) => Date.parse(m.messageAt) >= period.start.getTime() && Date.parse(m.messageAt) < period.end.getTime()).map((m) => toSource(m, 2)),
    ...visibleRecent.map((m, i) => toSource(withConv(m), 3 + i / 1000)),
  ];
  const byId = new Map<string, AiMessageRow>();
  for (const m of [...visibleHits, ...factRows, ...neighbours, ...visibleRecent]) if (!byId.has(m.id)) byId.set(m.id, withConv(m));
  const uniqueCount = new Set(candidates.map((c) => c.id)).size;

  const connIds = [...new Set([...[...convOf.values()].map((m) => m.connectionId), ...(input.connectionId ? [input.connectionId] : [])])];
  const finishTurn = async (t: { status: TurnRecord["status"]; notice: string | null; answer: TurnRecord["answer"]; sourceIds: string[]; usageId: string | null; cacheKey: string | null; dropped: number }) => {
    const sessionId = session?.id ?? (await deps.store.createSession(actor.userId, input.question.slice(0, 120)));
    if (session) await deps.store.touchSession(session.id);
    const saved = await deps.store.insertTurn({
      sessionId,
      userId: actor.userId,
      question: input.question,
      status: t.status,
      notice: t.notice,
      answer: t.answer,
      sourceMessageIds: t.sourceIds.slice(0, 200),
      scopeConversationIds: [...new Set(t.sourceIds.map((id) => byId.get(id)?.conversationId).filter((v): v is string => !!v))].slice(0, 50),
      period: { label: period.label, fromDate: period.fromDate, toDate: period.toDate, preset: period.preset },
      provider: deps.config.provider,
      model: deps.config.model,
      cacheKey: t.cacheKey,
      promptVersion: AI_PROMPT_VERSION,
      usageId: t.usageId,
    });
    const cov = await coverage(deps, scope, connIds, pickedRows, period, uniqueCount, t.dropped, now);
    return ok<AskResult>({ sessionId, turn: turnView(saved, byId, scope, false), coverage: cov });
  };
  const sourcesOnly = async (notice: string, usage: UsageRecord["status"] | null, reason: string | null, dropped = 0) => {
    if (usage) await deps.store.record({ userId: actor.userId, feature: "ask", provider: deps.config.provider, model: deps.config.model ?? "unconfigured", status: usage, reason });
    const ids = [...byId.keys()].slice(0, 30);
    return finishTurn({ status: "sources_only", notice, answer: {}, sourceIds: ids, usageId: null, cacheKey: null, dropped });
  };

  if (uniqueCount === 0) {
    await deps.store.record({ userId: actor.userId, feature: "ask", provider: deps.config.provider, model: deps.config.model ?? "unconfigured", status: "skipped", reason: "no_sources" });
    return finishTurn({ status: "insufficient", notice: "no_sources", answer: {}, sourceIds: [], usageId: null, cacheKey: null, dropped: 0 });
  }

  // ---- may we call the provider at all?
  const ready = providerReadiness(deps.config);
  if (!ready.ready) return sourcesOnly(ready.reason, "skipped", ready.reason);
  const sharing = sharingDecision(deps.config);
  if (!sharing.allowed) return sourcesOnly(sharing.reason, "skipped", sharing.reason);

  const system = askSystemPrompt(now.toISOString(), period);
  const budget = Math.max(500, deps.config.limits.maxInputTokens - CONTEXT_OVERHEAD_TOKENS - estimateTokens(system + input.question));
  const ctx = buildContext(candidates, { maxTokens: budget, redact: sharing.redact });
  const user = askUserPrompt(input.question, ctx.block, { truncated: ctx.droppedForBudget > 0, included: ctx.included.length });
  const model = deps.config.model ?? "fake";
  const cacheKey = sha256([actor.userId, AI_PROMPT_VERSION, deps.config.provider, model, foldVi(input.question).replace(/\s+/g, " ").trim(), period.fromDate, period.toDate, sharing.redact ? "r" : "f", ...ctx.included.map((m) => m.id).sort()].join("|"));

  // ---- same question, same sources, same model within 30 min → no new call
  const cached = await deps.store.cachedTurn(actor.userId, cacheKey, new Date(now.getTime() - 30 * 60_000));
  if (cached && (cached.status === "answered" || cached.status === "insufficient")) {
    await deps.store.record({ userId: actor.userId, feature: "ask", provider: deps.config.provider, model, status: "cache_hit", reason: null });
    const res = await finishTurn({ status: cached.status, notice: cached.notice, answer: cached.answer, sourceIds: cached.sourceMessageIds, usageId: null, cacheKey, dropped: ctx.droppedForBudget });
    if (res.ok) res.data.turn.cached = true;
    return res;
  }

  // ---- budget (atomic in the database)
  const reserved = await deps.store.reserve(actor.userId, "ask", deps.config.provider, model, estimateTokens(system + user), VN_DAY_START(now), deps.config.limits);
  if (!reserved.ok) return sourcesOnly(reserved.reason, "rejected", reserved.reason, ctx.droppedForBudget);

  const started = Date.now();
  let attempts = 0;
  try {
    const provider = deps.provider();
    const out = await generateWithRetry(provider, { system, user, responseSchema: ANSWER_JSON_SCHEMA, maxOutputTokens: deps.config.limits.maxOutputTokens, timeoutMs: deps.config.limits.timeoutMs }, deps.config.limits.maxRetries, deps.sleep);
    attempts = out.attempts;
    const redactions = Object.values(ctx.redaction).reduce((a, b) => a + b, 0);
    const parsed = parseModelJson(out.result.text, answerSchema);
    if (!parsed.ok) {
      await deps.store.finish(reserved.id, { status: "failed", reason: "invalid_response", inputTokens: out.result.usage.inputTokens, outputTokens: out.result.usage.outputTokens, confirmed: out.result.usage.confirmed, attempts, redactions, durationMs: Date.now() - started });
      return finishTurn({ status: "sources_only", notice: "invalid_response", answer: {}, sourceIds: ctx.included.map((m) => m.id).slice(0, 30), usageId: reserved.id, cacheKey: null, dropped: ctx.droppedForBudget });
    }
    const v = validateClaims(parsed.value.points, ctx.labels);
    await deps.store.finish(reserved.id, { status: "completed", reason: v.invalidLabels > 0 ? "invalid_citations" : null, inputTokens: out.result.usage.inputTokens, outputTokens: out.result.usage.outputTokens, confirmed: out.result.usage.confirmed, attempts, redactions, durationMs: Date.now() - started });
    const answered = parsed.value.status === "answered" && v.claims.length > 0;
    const cited = [...new Set(v.claims.flatMap((c) => c.messageIds))];
    return finishTurn({
      status: answered ? "answered" : "insufficient",
      notice: answered ? null : "insufficient",
      answer: answered ? { answer: parsed.value.answer.replace(/<[^>]{0,200}>/g, "").slice(0, 1500), points: v.claims.map((c) => ({ text: c.text, messageIds: c.messageIds })) } : {},
      sourceIds: answered ? [...cited, ...ctx.included.map((m) => m.id).filter((id) => !cited.includes(id))].slice(0, 60) : ctx.included.map((m) => m.id).slice(0, 30),
      usageId: reserved.id,
      cacheKey,
      dropped: ctx.droppedForBudget,
    });
  } catch (err) {
    const e = err instanceof AiProviderError ? err : new AiProviderError("provider_error", "unexpected");
    await deps.store.finish(reserved.id, { status: "failed", reason: e.category, inputTokens: 0, outputTokens: 0, confirmed: false, attempts: Math.max(attempts, 1), redactions: 0, durationMs: Date.now() - started });
    console.error(JSON.stringify({ source: "zalo-personal-ai", op: "ask", category: e.category }));
    return finishTurn({ status: "sources_only", notice: e.category, answer: {}, sourceIds: ctx.included.map((m) => m.id).slice(0, 30), usageId: reserved.id, cacheKey: null, dropped: ctx.droppedForBudget });
  }
}

/**
 * Builds the view of a stored turn against the CURRENT scope: if any message it
 * rests on is gone or no longer readable, the answer is hidden (not just the
 * citation) — an answer may summarise what the reader can't see any more.
 */
function turnView(t: TurnRecord, messages: ReadonlyMap<string, AiMessageRow>, scope: AccessScope, checkAccess: boolean): TurnView {
  const cited = new Set((t.answer.points ?? []).flatMap((p) => p.messageIds));
  const visible = (id: string) => {
    const m = messages.get(id);
    return !!m && (!checkAccess || readable(scope, m));
  };
  const hidden = checkAccess && ([...cited].some((id) => !visible(id)) || t.scopeConversationIds.some((cid) => ![...messages.values()].some((m) => m.conversationId === cid && readable(scope, m))));
  const cite = (id: string) => (visible(id) ? citation(messages.get(id)!) : null);
  return {
    id: t.id,
    question: t.question,
    status: t.status,
    notice: hidden ? NOTICE.access_changed! : noticeOf(t.notice),
    answer: hidden ? null : t.answer.answer ?? null,
    points: hidden ? [] : (t.answer.points ?? []).map((p) => ({ text: p.text, citations: p.messageIds.map(cite).filter((c): c is CitationView => c !== null) })),
    sources: hidden ? [] : t.sourceMessageIds.map(cite).filter((c): c is CitationView => c !== null),
    period: { label: t.period.label, fromDate: t.period.fromDate, toDate: t.period.toDate },
    createdAt: t.createdAt,
    model: t.model,
    cached: false,
    hiddenForAccess: hidden,
  };
}

// ------------------------------------------------------------ sessions

export async function listSessions(deps: AiDeps, actor: Actor, limit: number): Promise<AiResult<SessionRecord[]>> {
  const g = await gate(deps, actor);
  if (!g.ok) return g.result;
  // only the caller's own sessions — an admin never lists anybody else's
  return ok(await deps.store.sessions(actor.userId, limit));
}

export async function getSession(deps: AiDeps, actor: Actor, id: string): Promise<AiResult<{ session: SessionRecord; turns: TurnView[] }>> {
  const g = await gate(deps, actor);
  if (!g.ok) return g.result;
  const s = await deps.store.session(id);
  if (!s || s.userId !== actor.userId) return NOT_FOUND();
  const turns = await deps.store.turns(s.id);
  const ids = [...new Set(turns.flatMap((t) => [...t.sourceMessageIds, ...(t.answer.points ?? []).flatMap((p) => p.messageIds)]))];
  const rows = ids.length ? await deps.store.messagesByIds(ids) : [];
  const map = new Map(rows.map((m) => [m.id, m]));
  return ok({ session: s, turns: turns.map((t) => turnView(t, map, g.scope, true)) });
}

// ------------------------------------------------------------ summaries + memory

export interface SummarizeInput {
  conversationId: string;
  kind: SummaryKind;
  topic?: string;
  period?: { preset: PeriodPreset; from?: string; to?: string };
  force?: boolean;
}

export interface SummaryView {
  id: string;
  kind: SummaryKind;
  topic: string | null;
  periodLabel: string;
  status: SummaryRecord["status"];
  staleReason: string | null;
  summary: string;
  sections: Array<{ key: string; title: string; items: Array<{ text: string; confidence?: number; date?: string; citations: CitationView[] }> }>;
  messageCount: number;
  truncated: boolean;
  model: string;
  version: number;
  createdAt: string;
  reused: boolean;
}

export interface SummarizeResult {
  summary: SummaryView | null;
  notice: NoticeView | null;
}

const SECTION_TITLE: Record<string, string> = { points: "Ý chính", decisions: "Quyết định", assignments: "Việc được nhắc tới", openQuestions: "Câu hỏi còn mở", importantDates: "Mốc thời gian", projectRefs: "Dự án / lô hàng được nhắc" };
const FACT_KIND: Record<string, FactKind> = { decisions: "decision", assignments: "assignment", openQuestions: "open_question", importantDates: "important_date", projectRefs: "project_ref", facts: "fact" };

function summaryView(s: SummaryRecord, messages: ReadonlyMap<string, AiMessageRow>, scope: AccessScope, reused: boolean): SummaryView {
  const cite = (id: string) => {
    const m = messages.get(id);
    return m && readable(scope, m) ? citation(m) : null;
  };
  const sections = (["points", "decisions", "assignments", "openQuestions", "importantDates", "projectRefs"] as const).map((key) => ({
    key,
    title: SECTION_TITLE[key]!,
    items: (s.content[key] ?? []).map((c) => ({ text: c.text, confidence: c.confidence, date: c.date, citations: c.messageIds.map(cite).filter((x): x is CitationView => x !== null) })).filter((i) => i.citations.length > 0),
  }));
  return { id: s.id, kind: s.kind, topic: s.topic, periodLabel: s.content.periodLabel, status: s.status, staleReason: s.staleReason, summary: s.content.summary, sections, messageCount: s.messageCount, truncated: s.content.truncated, model: s.model, version: s.summaryVersion, createdAt: s.createdAt, reused };
}

const SUMMARY_MAX_MESSAGES = 300;

export async function summarize(deps: AiDeps, actor: Actor, input: SummarizeInput): Promise<AiResult<SummarizeResult>> {
  const now = (deps.now ?? (() => new Date()))();
  const g = await gate(deps, actor);
  if (!g.ok) return g.result;
  if (await rateLimited(deps, actor, now)) return fail("rate_limited", "rate_limited", "Bạn thao tác quá nhanh. Vui lòng đợi 1 phút rồi thử lại.");
  const c = await deps.dashboard.conversation(input.conversationId);
  if (!c || !canReadConversation(g.scope, c)) return NOT_FOUND();

  const period = input.kind === "daily" && !input.period ? presetPeriod("today", now) : resolvePeriod(input.period, "", now);
  if (typeof period === "string") return fail("invalid_input", "invalid_period", PERIOD_ERROR_TEXT[period]);
  if (input.kind === "daily" && period.fromDate !== period.toDate) return fail("invalid_input", "invalid_period", "Tóm tắt theo ngày chỉ dùng cho một ngày.");
  const topic = input.kind === "topic" ? (input.topic ?? "").trim() : null;

  await deps.store.validateMemory([c.id]);
  const conv = { conversationType: c.conversationType, externalConversationId: c.externalConversationId, groupName: c.groupName };
  let rows: AiMessageRow[];
  let total: number;
  if (topic) {
    rows = (await deps.store.search({ full: [], group: [], ids: [c.id] }, { conversationIds: [c.id], connectionId: null, from: period.start, to: period.end, terms: topicKeywords(topic), limit: 200 })).filter((m) => m.conversationId === c.id);
    total = rows.length;
  } else {
    const r = await deps.store.range(c.id, period.start, period.end, SUMMARY_MAX_MESSAGES);
    rows = r.rows;
    total = r.total;
  }
  rows = rows.map((m) => ({ ...m, ...conv, connectionId: c.connectionId, conversationId: c.id }));
  const notice = (code: string): AiResult<SummarizeResult> => ok({ summary: null, notice: noticeOf(code) });
  if (rows.length === 0) return notice("no_sources");

  const fingerprint = sha256(rows.map((m) => m.id).sort().join("|"));
  const existing = await deps.store.freshSummary(c.id, input.kind, topic, period.start, period.end);
  const messages = async (s: SummaryRecord) => {
    const ids = [...new Set((["points", "decisions", "assignments", "openQuestions", "importantDates", "projectRefs"] as const).flatMap((k) => (s.content[k] ?? []).flatMap((x) => x.messageIds)))];
    const found = ids.length ? await deps.store.messagesByIds(ids) : [];
    return new Map(found.map((m) => [m.id, m]));
  };
  if (existing && existing.sourceFingerprint === fingerprint && existing.promptVersion === AI_PROMPT_VERSION && !input.force) {
    // same input messages → reuse, no provider call
    await deps.store.record({ userId: actor.userId, feature: "summarize", provider: deps.config.provider, model: deps.config.model ?? "unconfigured", status: "cache_hit", reason: null });
    return ok({ summary: summaryView(existing, await messages(existing), g.scope, true), notice: null });
  }

  const ready = providerReadiness(deps.config);
  const sharing = sharingDecision(deps.config);
  if (!ready.ready || !sharing.allowed) {
    const reason = !ready.ready ? ready.reason : (sharing as { reason: string }).reason;
    await deps.store.record({ userId: actor.userId, feature: "summarize", provider: deps.config.provider, model: deps.config.model ?? "unconfigured", status: "skipped", reason });
    return notice(reason);
  }

  const system = summarySystemPrompt(now.toISOString(), period, input.kind, topic);
  // newest first keeps the latest messages when the budget is short
  const sorted = [...rows].sort((a, b) => Date.parse(b.messageAt) - Date.parse(a.messageAt));
  const ctx = buildContext(sorted.map((m, i) => toSource(m, i)), { maxTokens: Math.max(500, deps.config.limits.maxInputTokens - CONTEXT_OVERHEAD_TOKENS - estimateTokens(system)), redact: sharing.redact });
  const truncated = total > rows.length || ctx.droppedForBudget > 0;
  const user = summaryUserPrompt(ctx.block, { truncated, included: ctx.included.length });
  const model = deps.config.model ?? "fake";
  const reserved = await deps.store.reserve(actor.userId, "summarize", deps.config.provider, model, estimateTokens(system + user), VN_DAY_START(now), deps.config.limits);
  if (!reserved.ok) {
    await deps.store.record({ userId: actor.userId, feature: "summarize", provider: deps.config.provider, model, status: "rejected", reason: reserved.reason });
    return notice(reserved.reason);
  }

  const started = Date.now();
  let attempts = 0;
  try {
    const out = await generateWithRetry(deps.provider(), { system, user, responseSchema: SUMMARY_JSON_SCHEMA, maxOutputTokens: deps.config.limits.maxOutputTokens, timeoutMs: deps.config.limits.timeoutMs }, deps.config.limits.maxRetries, deps.sleep);
    attempts = out.attempts;
    const redactions = Object.values(ctx.redaction).reduce((a, b) => a + b, 0);
    const parsed = parseModelJson(out.result.text, summarySchema);
    const usage = { inputTokens: out.result.usage.inputTokens, outputTokens: out.result.usage.outputTokens, confirmed: out.result.usage.confirmed, attempts, redactions, durationMs: Date.now() - started };
    if (!parsed.ok) {
      await deps.store.finish(reserved.id, { status: "failed", reason: "invalid_response", ...usage });
      return notice("invalid_response");
    }
    const j = parsed.value;
    const sec = (k: keyof typeof SECTION_TITLE | "facts") => validateClaims((j as unknown as Record<string, Array<{ text: string; sourceIds: string[]; confidence?: number; date?: string }>>)[k] ?? [], ctx.labels).claims;
    const content: StoredSummaryContent = {
      summary: j.summary.replace(/<[^>]{0,200}>/g, "").slice(0, 2500),
      points: sec("points"),
      decisions: sec("decisions"),
      assignments: sec("assignments"),
      openQuestions: sec("openQuestions"),
      importantDates: sec("importantDates"),
      projectRefs: sec("projectRefs"),
      truncated,
      periodLabel: period.label,
    };
    const anyClaim = content.points.length + content.decisions.length + content.assignments.length + content.openQuestions.length + content.importantDates.length + content.projectRefs.length > 0;
    await deps.store.finish(reserved.id, { status: "completed", reason: null, ...usage });
    if (j.status !== "answered" || !anyClaim) return notice("insufficient");

    // structured memory: each claim keeps its sources; AI output stays "ai_inferred";
    // anything that looks sensitive (codes, phones, accounts, secrets) is not memorised
    const facts: Array<{ kind: FactKind; statement: string; valueDate: string | null; confidence: number; messageIds: string[] }> = [];
    for (const [key, kind] of Object.entries(FACT_KIND)) {
      const claims = key === "facts" ? sec("facts") : (content[key as keyof StoredSummaryContent] as CitedClaim[]);
      for (const cl of claims) {
        const st = redact(cl.text).stats;
        if (Object.values(st).some((n) => n > 0)) continue;
        const conf = cl.confidence ?? (cl.messageIds.length > 1 ? 0.6 : 0.5);
        facts.push({ kind, statement: cl.text.slice(0, 500), valueDate: cl.date ?? null, confidence: cl.messageIds.length === 1 ? Math.min(conf, 0.7) : conf, messageIds: cl.messageIds });
      }
    }
    const stored = await deps.store.storeSummary({
      actorId: actor.userId,
      connectionId: c.connectionId,
      conversationId: c.id,
      namespace: namespaceOf(c.conversationType),
      kind: input.kind,
      topic,
      periodStart: period.start,
      periodEnd: period.end,
      inputIds: ctx.included.map((m) => m.id),
      fingerprint,
      provider: deps.config.provider,
      model,
      content,
      facts: facts.slice(0, 40),
    });
    if (!stored.ok) return fail("server_error", stored.error, "Không lưu được bản tóm tắt.");
    const record: SummaryRecord = { id: stored.id, namespace: namespaceOf(c.conversationType), connectionId: c.connectionId, conversationId: c.id, kind: input.kind, topic, periodStart: period.start.toISOString(), periodEnd: period.end.toISOString(), messageCount: ctx.included.length, sourceFingerprint: fingerprint, summaryVersion: (existing?.summaryVersion ?? 0) + 1, promptVersion: AI_PROMPT_VERSION, provider: deps.config.provider, model, content, status: "fresh", staleReason: null, createdAt: now.toISOString() };
    const map = new Map(rows.map((m) => [m.id, m]));
    return ok({ summary: summaryView(record, map, g.scope, false), notice: truncated ? { code: "truncated", text: "Khoảng thời gian có nhiều tin hơn giới hạn: bản tóm tắt chỉ dựa trên phần tin mới nhất.", tone: "info" } : null });
  } catch (err) {
    const e = err instanceof AiProviderError ? err : new AiProviderError("provider_error", "unexpected");
    await deps.store.finish(reserved.id, { status: "failed", reason: e.category, inputTokens: 0, outputTokens: 0, confirmed: false, attempts: Math.max(attempts, 1), redactions: 0, durationMs: Date.now() - started });
    console.error(JSON.stringify({ source: "zalo-personal-ai", op: "summarize", category: e.category }));
    return notice(e.category);
  }
}

export interface FactView {
  id: string;
  kind: FactKind;
  statement: string;
  valueDate: string | null;
  confidence: number;
  evidenceStatus: FactRecord["evidenceStatus"];
  status: FactRecord["status"];
  staleReason: string | null;
  citations: CitationView[];
  createdAt: string;
}

export interface MemoryView {
  conversation: { id: string; title: string; type: "user" | "group" };
  summaries: SummaryView[];
  facts: FactView[];
  canReview: boolean;
}

export async function getMemory(deps: AiDeps, actor: Actor, conversationId: string): Promise<AiResult<MemoryView>> {
  const g = await gate(deps, actor);
  if (!g.ok) return g.result;
  const c = await deps.dashboard.conversation(conversationId);
  if (!c || !canReadConversation(g.scope, c)) return NOT_FOUND();
  await deps.store.validateMemory([c.id]);
  const [summaries, facts] = await Promise.all([deps.store.summaries(c.id, 10), deps.store.facts(c.id, 100)]);
  const ids = [...new Set([...summaries.flatMap((s) => (["points", "decisions", "assignments", "openQuestions", "importantDates", "projectRefs"] as const).flatMap((k) => (s.content[k] ?? []).flatMap((x) => x.messageIds))), ...facts.flatMap((f) => f.sourceMessageIds)])];
  const rows = ids.length ? await deps.store.messagesByIds(ids) : [];
  const map = new Map(rows.map((m) => [m.id, m]));
  const cite = (id: string) => {
    const m = map.get(id);
    return m && readable(g.scope, m) ? citation(m) : null;
  };
  return ok({
    conversation: { id: c.id, title: conversationTitle(c), type: c.conversationType },
    summaries: summaries.map((s) => summaryView(s, map, g.scope, false)),
    facts: facts.map((f) => ({ id: f.id, kind: f.kind, statement: f.statement, valueDate: f.valueDate, confidence: f.confidence, evidenceStatus: f.evidenceStatus, status: f.status, staleReason: f.staleReason, citations: f.sourceMessageIds.map(cite).filter((x): x is CitationView => x !== null), createdAt: f.createdAt })),
    canReview: can(g.scope, c.connectionId, "manage_groups"),
  });
}

export async function reviewFact(deps: AiDeps, actor: Actor, factId: string, evidence: "user_confirmed" | "user_rejected"): Promise<AiResult<{ changed: boolean }>> {
  const g = await gate(deps, actor);
  if (!g.ok) return g.result;
  const f = await deps.store.fact(factId);
  if (!f) return NOT_FOUND();
  const c = await deps.dashboard.conversation(f.conversationId);
  if (!c || !canReadConversation(g.scope, c)) return NOT_FOUND();
  if (!can(g.scope, c.connectionId, "manage_groups")) return FORBIDDEN("Chỉ chủ kết nối hoặc người được cấp quyền quản lý mới xác nhận được ghi nhớ.");
  if (f.status !== "active") return fail("conflict", "not_active", "Ghi nhớ này đã cũ hoặc đã được thay thế.");
  return ok({ changed: await deps.store.reviewFact(f.id, actor.userId, evidence) });
}

// ------------------------------------------------------------ usage

export interface UsageView {
  own: UsageAggregate & { remaining: number };
  global: (UsageAggregate & { remaining: number }) | null;
  budget: "ok" | "near_limit" | "exhausted" | "cooldown";
  limits: AiStatusView["limits"];
}

export async function getUsage(deps: AiDeps, actor: Actor): Promise<AiResult<UsageView>> {
  const g = await gate(deps, actor);
  if (!g.ok) return g.result;
  const now = (deps.now ?? (() => new Date()))();
  const since = VN_DAY_START(now);
  const l = deps.config.limits;
  const own = await deps.store.usage(actor.userId, since);
  // system-wide totals (no per-user breakdown) only for admins
  const global = actor.role === "admin" ? await deps.store.usage(null, since) : null;
  const total = global ?? own;
  const cooldown = total.lastQuotaErrorAt !== null && now.getTime() - Date.parse(total.lastQuotaErrorAt) < l.quotaCooldownMinutes * 60_000;
  const usedRatio = Math.max(own.calls / Math.max(1, l.maxRequestsPerUserPerDay), global ? global.calls / Math.max(1, l.maxRequestsPerDay) : 0);
  return ok({
    own: { ...own, remaining: Math.max(0, l.maxRequestsPerUserPerDay - own.calls) },
    global: global ? { ...global, remaining: Math.max(0, l.maxRequestsPerDay - global.calls) } : null,
    budget: cooldown ? "cooldown" : usedRatio >= 1 ? "exhausted" : usedRatio >= 0.8 ? "near_limit" : "ok",
    limits: { perUserPerDay: l.maxRequestsPerUserPerDay, perDay: l.maxRequestsPerDay, perMinute: l.maxRequestsPerMinute, maxInputTokens: l.maxInputTokens, maxOutputTokens: l.maxOutputTokens },
  });
}
