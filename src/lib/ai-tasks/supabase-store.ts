// ============================================================
// PHASE 06 — TaskEngineStore + TaskServiceStore over the service-role client
// (server only; trusted backend code). Writes go through the 00078 SQL
// functions (atomic, lease-checked); reads are bounded. Nothing here logs
// message text.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AiLimits } from "../ai-assistant/config.ts";
import { hasPermission, isRole } from "../auth/permissions.ts";
import type { ConversationScope } from "../zalo-personal/dashboard/access.ts";
import { SupabaseDashboardStore } from "../zalo-personal/dashboard/supabase-store.ts";
import type { ReserveResult } from "../zalo-personal/ai/service.ts";
import type { DeliveryRecord, ExternalChannel } from "./channels.ts";
import type { ScannedMessage } from "./detect.ts";
import type { TaskStatus } from "./lifecycle.ts";
import type { InboxNotification } from "./messages.ts";
import { prefsOf, type ClaimedOccurrence, type ReminderKind, type ReminderPrefs } from "./reminders.ts";
import type { ApplyArgs, ActivityRow, AssignmentRow, NotificationRow, ScheduleRow, SourceRow, TaskListRow, TaskRow, TaskServiceStore } from "./service.ts";
import type { CandidateResult, ClaimedCandidate, ContextRow, ConversationInfo, OpenTaskRow, ProfileInfo, ProposalPayload, ResolveItem, ScanCommit, ScanConnection, StoredTaskPayload, TaskEngineStore } from "./store.ts";

type Raw = Record<string, unknown>;

class TaskStoreError extends Error {
  /** safe for logs / ai_task_worker_runs.error_category: operation + database error code, never data */
  readonly category: string;
  constructor(op: string, code: string | undefined) {
    super(`ai-tasks store: ${op} failed (${code ?? "unknown"})`);
    this.name = "TaskStoreError";
    this.category = `store_${op}_${code ?? "unknown"}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
  }
}

function check<T>(op: string, res: { data: T | null; error: { code?: string } | null }): T {
  if (res.error) throw new TaskStoreError(op, res.error.code);
  return res.data as T;
}

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const date = (v: unknown): Date | null => (typeof v === "string" ? new Date(v) : null);
const vnDateOnly = (v: unknown) => String(v).slice(0, 10);

/** The notification JSON the SQL functions take (camelCase keys). */
const noteJson = (n: InboxNotification) => ({
  userId: n.userId,
  kind: n.kind,
  title: n.title,
  body: n.body,
  taskId: n.taskId ?? null,
  taskIds: n.taskIds ?? [],
  connectionId: n.connectionId ?? null,
  conversationId: n.conversationId ?? null,
  messageId: n.messageId ?? null,
  link: n.link,
  dedupeKey: n.dedupeKey,
});

const TASK_COLS =
  "id, connection_id, conversation_id, title, description, assignor_external_id, status, deadline_at, deadline_precision, deadline_phrase, deadline_assumed, deadline_confirmed, proposed_deadline_at, proposed_deadline_phrase, proposed_deadline_message_id, priority, confidence, missing_information, evidence, extractor, progress, progress_note, version, revision, confirmed_by, confirmed_at, completed_by, completed_at, closed_reason, source_message_at, created_at, updated_at";

function taskRow(r: Raw): TaskRow {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    conversationId: String(r.conversation_id),
    title: String(r.title),
    description: s(r.description),
    assignorExternalId: s(r.assignor_external_id),
    status: r.status as TaskStatus,
    deadlineAt: s(r.deadline_at),
    deadlinePrecision: r.deadline_precision as TaskRow["deadlinePrecision"],
    deadlinePhrase: s(r.deadline_phrase),
    deadlineAssumed: r.deadline_assumed === true,
    deadlineConfirmed: r.deadline_confirmed === true,
    proposedDeadlineAt: s(r.proposed_deadline_at),
    proposedDeadlinePhrase: s(r.proposed_deadline_phrase),
    proposedDeadlineMessageId: s(r.proposed_deadline_message_id),
    priority: (r.priority as TaskRow["priority"]) ?? null,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    missing: (r.missing_information as string[] | null) ?? [],
    evidence: (r.evidence as TaskRow["evidence"]) ?? [],
    extractor: r.extractor as TaskRow["extractor"],
    progress: num(r.progress),
    progressNote: s(r.progress_note),
    version: num(r.version),
    revision: num(r.revision),
    confirmedBy: s(r.confirmed_by),
    confirmedAt: s(r.confirmed_at),
    completedBy: s(r.completed_by),
    completedAt: s(r.completed_at),
    closedReason: s(r.closed_reason),
    sourceMessageAt: String(r.source_message_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export class SupabaseTaskStore implements TaskEngineStore, TaskServiceStore {
  private readonly db: SupabaseClient;
  private readonly dashboard: SupabaseDashboardStore;

  constructor(db: SupabaseClient) {
    this.db = db;
    this.dashboard = new SupabaseDashboardStore(db);
  }

  // ------------------------------------------------------------ access
  loadAccess(userId: string) {
    return this.dashboard.loadAccess(userId);
  }

  async profiles(ids: string[]): Promise<ProfileInfo[]> {
    if (!ids.length) return [];
    const rows = check<Raw[]>("profiles", await this.db.from("profiles").select("id, role, is_active, full_name").in("id", [...new Set(ids)].slice(0, 500)));
    return rows.map((r) => ({ id: String(r.id), role: String(r.role), isActive: r.is_active === true, name: s(r.full_name) }));
  }

  async conversationInfo(id: string): Promise<ConversationInfo | null> {
    const r = check<Raw | null>(
      "conversation",
      await this.db.from("zalo_personal_conversations").select("id, connection_id, conversation_type, group:zalo_personal_groups!zalo_personal_conversations_group_id_connection_id_fkey(display_name)").eq("id", id).maybeSingle(),
    );
    if (!r) return null;
    const g = r.group as Raw | Raw[] | null;
    const name = Array.isArray(g) ? s(g[0]?.display_name) : s(g?.display_name);
    return { id: String(r.id), connectionId: String(r.connection_id), conversationType: r.conversation_type as "user" | "group", groupName: name };
  }

  async connectionManagers(connectionId: string): Promise<string[]> {
    const c = check<Raw | null>("connection", await this.db.from("zalo_personal_connections").select("owner_user_id").eq("id", connectionId).maybeSingle());
    const grants = check<Raw[]>("grants(manage)", await this.db.from("zalo_personal_access_grants").select("grantee_user_id").eq("connection_id", connectionId).eq("scope", "connection").eq("level", "manage").is("revoked_at", null).limit(200));
    return [...new Set([...(c ? [String(c.owner_user_id)] : []), ...grants.map((g) => String(g.grantee_user_id))])];
  }

  async connectionPeople(connectionId: string): Promise<string[]> {
    const c = check<Raw | null>("connection", await this.db.from("zalo_personal_connections").select("owner_user_id").eq("id", connectionId).maybeSingle());
    const grants = check<Raw[]>("grants(all)", await this.db.from("zalo_personal_access_grants").select("grantee_user_id").eq("connection_id", connectionId).is("revoked_at", null).limit(500));
    return [...new Set([...(c ? [String(c.owner_user_id)] : []), ...grants.map((g) => String(g.grantee_user_id))])];
  }

  async prefs(userIds: string[]): Promise<Map<string, ReminderPrefs>> {
    const out = new Map<string, ReminderPrefs>();
    const ids = [...new Set(userIds)];
    if (!ids.length) return out;
    const rows = check<Raw[]>("prefs", await this.db.from("ai_reminder_preferences").select("*").in("user_id", ids));
    const byId = new Map(rows.map((r) => [String(r.user_id), r]));
    for (const id of ids) out.set(id, prefsOf(byId.get(id) as Partial<ReminderPrefs> | undefined));
    return out;
  }

  async savePrefs(userId: string, p: ReminderPrefs): Promise<void> {
    check("savePrefs", await this.db.from("ai_reminder_preferences").upsert({ user_id: userId, ...p }, { onConflict: "user_id" }));
  }

  // ------------------------------------------------------------ runs
  async startRun(workerId: string): Promise<number> {
    const r = check<Raw>("startRun", await this.db.from("ai_task_worker_runs").insert({ worker_id: workerId }).select("id").single());
    return num(r.id);
  }

  async finishRun(id: number, status: "ok" | "partial" | "error", stats: Record<string, number>, errorCategory: string | null): Promise<void> {
    check("finishRun", await this.db.from("ai_task_worker_runs").update({ status, stats, error_category: errorCategory, finished_at: new Date().toISOString() }).eq("id", id));
  }

  async pruneRuns(before: Date): Promise<void> {
    check("pruneRuns", await this.db.from("ai_task_worker_runs").delete().lt("started_at", before.toISOString()));
  }

  // ------------------------------------------------------------ scan
  async claimScan(worker: string, leaseSeconds: number, backfillMinutes: number, limit: number): Promise<ScanConnection[]> {
    const rows = check<Raw[]>("claimScan", await this.db.rpc("ai_task_scan_claim", { p_worker: worker, p_lease_seconds: leaseSeconds, p_backfill_minutes: backfillMinutes, p_limit: limit }));
    return rows.map((r) => ({ connectionId: String(r.connection_id), ownerUserId: String(r.owner_user_id), accountId: String(r.zalo_account_id), directMessageMode: r.direct_message_mode as ScanConnection["directMessageMode"], cursorAt: String(r.cursor_at), cursorId: String(r.cursor_id) }));
  }

  async scanMessages(connectionId: string, after: { at: string; id: string }, until: Date, limit: number): Promise<ScannedMessage[]> {
    const rows = check<Raw[]>("scanMessages", await this.db.rpc("ai_task_scan_messages", { p_connection_id: connectionId, p_after_at: after.at, p_after_id: after.id, p_until: until.toISOString(), p_limit: limit }));
    return rows.map((r) => ({
      id: String(r.id),
      conversationId: String(r.conversation_id),
      conversationType: r.conversation_type as "user" | "group",
      groupName: s(r.group_name),
      eligible: r.eligible === true,
      mentionEligible: r.mention_eligible === true,
      senderExternalId: String(r.sender_external_id),
      text: s(r.text_content),
      mentions: r.mentions,
      mentionsSelf: r.mentions_self === true,
      isSelf: r.is_self === true,
      messageAt: new Date(String(r.message_at)),
      // kept as the database's own text: microseconds must survive the round trip (cursor)
      ingestedAt: String(r.ingested_at),
    }));
  }

  async identities(connectionId: string): Promise<Map<string, string>> {
    const rows = check<Raw[]>("identities", await this.db.from("ai_channel_identities").select("external_user_id, internal_user_id").eq("connection_id", connectionId).eq("status", "active").limit(1000));
    return new Map(rows.map((r) => [String(r.external_user_id), String(r.internal_user_id)]));
  }

  async commitScan(c: ScanCommit) {
    const r = check<Raw>(
      "commitScan",
      await this.db.rpc("ai_task_scan_commit", {
        p_connection_id: c.connectionId,
        p_worker: c.worker,
        p_cursor_at: c.cursorAt,
        p_cursor_id: c.cursorId,
        p_scanned: c.scanned,
        p_mentions: c.mentions,
        p_candidates: c.candidates,
        p_notifications: c.notifications.map(noteJson),
        p_day_start: c.dayStart.toISOString(),
        p_max_candidates_per_day: c.maxCandidatesPerDay,
        p_release: c.release,
      }),
    );
    if (r.ok !== true) return { ok: false as const, error: String(r.error ?? "unknown") };
    return { ok: true as const, mentions: num(r.mentions), candidates: num(r.candidates), capped: num(r.capped), notifications: num(r.notifications) };
  }

  async releaseScan(connectionId: string, worker: string): Promise<void> {
    check("releaseScan", await this.db.rpc("ai_task_scan_release", { p_connection_id: connectionId, p_worker: worker }));
  }

  // ------------------------------------------------------------ extraction
  async claimCandidates(worker: string, limit: number, leaseSeconds: number): Promise<ClaimedCandidate[]> {
    const rows = check<Raw[]>("claimCandidates", await this.db.rpc("ai_task_claim_candidates", { p_worker: worker, p_limit: limit, p_lease_seconds: leaseSeconds }));
    return rows.map((r) => ({
      id: String(r.id),
      connectionId: String(r.connection_id),
      conversationId: String(r.conversation_id),
      messageId: String(r.message_id),
      messageAt: new Date(String(r.message_at)),
      score: num(r.score),
      attempts: num(r.attempts),
      ownerUserId: String(r.owner_user_id),
      accountId: s(r.zalo_account_id),
      connectionStatus: r.connection_status as "active" | "disabled",
      directMessageMode: r.direct_message_mode as ClaimedCandidate["directMessageMode"],
      conversationType: r.conversation_type as "user" | "group",
      groupName: s(r.group_name),
      groupMode: s(r.group_mode),
      consentStatus: s(r.consent_status),
    }));
  }

  async context(conversationId: string, messageIds: string[], before: number): Promise<ContextRow[]> {
    const rows = check<Raw[]>("context", await this.db.rpc("ai_task_context", { p_conversation_id: conversationId, p_message_ids: messageIds, p_before: before }));
    return rows.map((r) => ({ id: String(r.id), senderExternalId: String(r.sender_external_id), isSelf: r.is_self === true, text: String(r.text_content ?? ""), mentions: r.mentions, messageAt: new Date(String(r.message_at)), isCandidate: r.is_candidate === true }));
  }

  async openTasksOfConversation(conversationId: string) {
    const rows = check<Raw[]>(
      "openTasks",
      await this.db.from("ai_tasks").select("id, title, deadline_at").eq("conversation_id", conversationId).in("status", ["pending_confirmation", "accepted", "in_progress", "overdue"]).order("created_at", { ascending: false }).limit(10),
    );
    return rows.map((r) => ({ id: String(r.id), title: String(r.title), deadlineAt: date(r.deadline_at) }));
  }

  async extractionsSince(since: Date): Promise<number> {
    const res = await this.db.from("ai_request_usage").select("id", { count: "exact", head: true }).eq("feature", "task_extract").in("status", ["running", "completed", "failed"]).gte("created_at", since.toISOString());
    if (res.error) throw new TaskStoreError("extractionsSince", res.error.code);
    return res.count ?? 0;
  }

  async reserve(userId: string, provider: string, model: string, estimated: number, dayStart: Date, l: AiLimits): Promise<ReserveResult> {
    const r = check<{ ok: boolean; id?: string; reason?: string }>(
      "reserve",
      await this.db.rpc("zp_ai_reserve", {
        p_user: userId,
        p_feature: "task_extract",
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

  async finishUsage(id: string, r: { status: "completed" | "failed"; reason: string | null; inputTokens: number; outputTokens: number; confirmed: boolean; attempts: number; redactions: number; durationMs: number }): Promise<void> {
    check("finishUsage", await this.db.rpc("zp_ai_finish", { p_id: id, p_status: r.status, p_reason: r.reason, p_input: r.inputTokens, p_output: r.outputTokens, p_confirmed: r.confirmed, p_attempts: r.attempts, p_redactions: r.redactions, p_duration: r.durationMs }));
  }

  async storeExtraction(worker: string, candidates: CandidateResult[], tasks: StoredTaskPayload[], proposals: ProposalPayload[]) {
    const r = check<Raw>("storeExtraction", await this.db.rpc("ai_task_store_extraction", { p_worker: worker, p_candidates: candidates, p_tasks: tasks, p_proposals: proposals }));
    return { ok: true as const, created: (r.created as Array<{ dedupeKey: string; id: string }>) ?? [], duplicates: num(r.duplicates), invalid: num(r.invalid), proposals: num(r.proposals) };
  }

  // ------------------------------------------------------------ reminders
  async markOverdue(graceSeconds: number): Promise<number> {
    return num(check<number>("markOverdue", await this.db.rpc("ai_task_mark_overdue", { p_grace_seconds: graceSeconds })));
  }

  async ensureMorning(localDate: string, scheduledFor: Date): Promise<number> {
    return num(check<number>("ensureMorning", await this.db.rpc("ai_reminder_ensure_morning", { p_local_date: localDate, p_scheduled_for: scheduledFor.toISOString() })));
  }

  async claimReminders(worker: string, limit: number, leaseSeconds: number): Promise<ClaimedOccurrence[]> {
    const rows = check<Raw[]>("claimReminders", await this.db.rpc("ai_reminder_claim", { p_worker: worker, p_limit: limit, p_lease_seconds: leaseSeconds }));
    return rows.map((r) => ({
      id: String(r.id),
      kind: r.kind as ReminderKind,
      taskId: s(r.task_id),
      userId: String(r.user_id),
      taskVersion: r.task_version === null ? null : num(r.task_version),
      scheduledFor: new Date(String(r.scheduled_for)),
      localDate: vnDateOnly(r.local_date),
      attempts: num(r.attempts),
      maxAttempts: num(r.max_attempts),
      task: r.task_status
        ? { status: r.task_status as TaskStatus, version: num(r.task_current_version), deadlineAt: date(r.task_deadline_at), title: String(r.task_title), connectionId: String(r.connection_id), conversationId: String(r.conversation_id), conversationType: (r.conversation_type as "user" | "group") ?? "group" }
        : null,
      userActive: r.user_active === true,
      userMayUseModule: isRole(r.user_role) && hasPermission(r.user_role, "zalo_personal:use"),
      prefs: prefsOf(r.prefs as Partial<ReminderPrefs> | null),
    }));
  }

  async resolveReminders(worker: string, items: ResolveItem[], notification: InboxNotification | null) {
    const r = check<Raw>("resolveReminders", await this.db.rpc("ai_reminder_resolve", { p_worker: worker, p_items: items, p_notification: notification ? noteJson(notification) : null }));
    return { ok: true as const, notificationId: s(r.notificationId), created: r.created === true, items: ((r.items as Raw[]) ?? []).map((i) => ({ id: String(i.id), status: i.status as ResolveItem["status"], reason: s(i.reason) })), lost: num(r.lost) };
  }

  async retryReminder(id: string, worker: string, error: string, delaySeconds: number) {
    return check<string>("retryReminder", await this.db.rpc("ai_reminder_retry", { p_id: id, p_worker: worker, p_error: error, p_delay_seconds: delaySeconds })) as "retry" | "failed" | "lease_lost";
  }

  async openTasksForUser(userId: string): Promise<OpenTaskRow[]> {
    const rows = check<Raw[]>("openTasksForUser", await this.db.rpc("ai_task_open_for_user", { p_user: userId, p_limit: 100 }));
    return rows.map((r) => ({ id: String(r.id), connectionId: String(r.connection_id), conversationId: String(r.conversation_id), conversationType: r.conversation_type as "user" | "group", title: String(r.title), status: r.status as TaskStatus, deadlineAt: date(r.deadline_at) }));
  }

  // ------------------------------------------------------------ external channels (no sender exists yet)
  async externalRecipient(userId: string, channel: ExternalChannel, connectionId: string | null): Promise<string | null> {
    if (channel === "zalo_personal") {
      if (!connectionId) return null;
      const r = check<Raw | null>("externalRecipient", await this.db.from("ai_channel_identities").select("external_user_id").eq("internal_user_id", userId).eq("connection_id", connectionId).eq("status", "active").limit(1).maybeSingle());
      return r ? String(r.external_user_id) : null;
    }
    const r = check<Raw | null>("externalRecipient", await this.db.from("zalo_user_links").select("zalo_user_id").eq("internal_user_id", userId).eq("status", "active").limit(1).maybeSingle());
    return r ? String(r.zalo_user_id) : null;
  }

  async externalSentLastHour(userId: string, channel: ExternalChannel): Promise<number> {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const res = await this.db.from("notification_deliveries").select("id, notification:user_notifications!inner(user_id)", { count: "exact", head: true }).eq("channel", channel).in("status", ["sent", "sending", "unknown"]).eq("notification.user_id", userId).gte("created_at", since);
    if (res.error) throw new TaskStoreError("externalSentLastHour", res.error.code);
    return res.count ?? 0;
  }

  async recordDelivery(notificationId: string, channel: ExternalChannel, record: DeliveryRecord): Promise<void> {
    check(
      "recordDelivery",
      await this.db.from("notification_deliveries").upsert(
        { notification_id: notificationId, channel, status: record.status, reason: record.reason, attempts: record.status === "skipped" ? 0 : 1, provider_message_id: record.status === "sent" ? record.providerMessageId : null },
        { onConflict: "notification_id,channel" },
      ),
    );
  }

  // ------------------------------------------------------------ dashboard
  async listTasks(scope: ConversationScope, q: Parameters<TaskServiceStore["listTasks"]>[1]) {
    const rows = check<Raw[]>(
      "listTasks",
      await this.db.rpc("ai_task_list", {
        p_full: scope.full,
        p_group: scope.group,
        p_ids: scope.ids,
        p_user: q.userId,
        p_view: q.view,
        p_status: q.status,
        p_conversation_id: q.conversationId,
        p_assignee: q.assigneeUserId,
        p_due: q.due,
        p_now: q.now.toISOString(),
        p_day_end: q.dayEnd.toISOString(),
        p_week_end: q.weekEnd.toISOString(),
        p_offset: q.offset,
        p_limit: q.limit,
      }),
    );
    return {
      total: rows.length ? num(rows[0]!.total_count) : 0,
      rows: rows.map(
        (r): TaskListRow => ({
          id: String(r.id),
          connectionId: String(r.connection_id),
          conversationId: String(r.conversation_id),
          conversationType: r.conversation_type as "user" | "group",
          externalConversationId: String(r.external_conversation_id),
          groupName: s(r.group_name),
          title: String(r.title),
          status: r.status as TaskStatus,
          deadlineAt: s(r.deadline_at),
          deadlinePrecision: String(r.deadline_precision),
          deadlineAssumed: r.deadline_assumed === true,
          deadlineConfirmed: r.deadline_confirmed === true,
          priority: s(r.priority),
          confidence: r.confidence === null ? null : Number(r.confidence),
          extractor: String(r.extractor),
          progress: num(r.progress),
          hasProposal: r.has_proposal === true,
          revision: num(r.revision),
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
          mine: r.mine === true,
        }),
      ),
    };
  }

  async task(id: string): Promise<TaskRow | null> {
    const r = check<Raw | null>("task", await this.db.from("ai_tasks").select(TASK_COLS).eq("id", id).maybeSingle());
    return r ? taskRow(r) : null;
  }

  async assignments(taskId: string, connectionId: string): Promise<AssignmentRow[]> {
    const rows = check<Raw[]>("assignments", await this.db.from("ai_task_assignments").select("external_user_id, internal_user_id, source").eq("task_id", taskId).order("created_at"));
    const ext = rows.map((r) => s(r.external_user_id)).filter((x): x is string => Boolean(x));
    const resolved = new Map<string, string>();
    if (ext.length) {
      const conn = check<Raw | null>("connection", await this.db.from("zalo_personal_connections").select("owner_user_id, zalo_account_id").eq("id", connectionId).maybeSingle());
      if (conn?.zalo_account_id) resolved.set(String(conn.zalo_account_id), String(conn.owner_user_id));
      const links = check<Raw[]>("links", await this.db.from("ai_channel_identities").select("external_user_id, internal_user_id").eq("connection_id", connectionId).eq("status", "active").in("external_user_id", ext));
      for (const l of links) if (!resolved.has(String(l.external_user_id))) resolved.set(String(l.external_user_id), String(l.internal_user_id));
    }
    return rows.map((r) => ({ externalUserId: s(r.external_user_id), internalUserId: s(r.internal_user_id), source: r.source as AssignmentRow["source"], resolvedUserId: s(r.external_user_id) ? resolved.get(String(r.external_user_id)) ?? null : null }));
  }

  async sources(taskId: string): Promise<SourceRow[]> {
    const rows = check<Raw[]>(
      "sources",
      await this.db.from("ai_task_source_messages").select("role, message:zalo_personal_messages!inner(id, sender_external_id, is_self, text_content, content_stored, sent_at, received_at)").eq("task_id", taskId).limit(20),
    );
    return rows
      .map((r) => {
        const m = (Array.isArray(r.message) ? r.message[0] : r.message) as Raw;
        return { messageId: String(m.id), role: r.role as SourceRow["role"], senderExternalId: String(m.sender_external_id), isSelf: m.is_self === true, text: m.content_stored === true ? s(m.text_content) : null, messageAt: String(m.sent_at ?? m.received_at) };
      })
      .sort((a, b) => a.messageAt.localeCompare(b.messageAt));
  }

  async activity(taskId: string, limit: number): Promise<ActivityRow[]> {
    const rows = check<Raw[]>("activity", await this.db.from("ai_task_activity").select("id, actor_user_id, actor_kind, action, from_status, to_status, details, created_at").eq("task_id", taskId).order("created_at", { ascending: false }).limit(limit));
    return rows.map((r) => ({ id: num(r.id), actorUserId: s(r.actor_user_id), actorKind: r.actor_kind as ActivityRow["actorKind"], action: String(r.action), fromStatus: s(r.from_status), toStatus: s(r.to_status), details: (r.details as Record<string, unknown>) ?? {}, createdAt: String(r.created_at) }));
  }

  async taskSchedules(taskId: string, limit: number): Promise<ScheduleRow[]> {
    const rows = check<Raw[]>("taskSchedules", await this.db.from("ai_reminder_schedules").select("id, kind, task_id, user_id, scheduled_for, status, outcome_reason, attempts, processed_at").eq("task_id", taskId).order("scheduled_for", { ascending: false }).limit(limit));
    return rows.map((r) => ({ id: String(r.id), kind: String(r.kind), taskId: s(r.task_id), userId: String(r.user_id), scheduledFor: String(r.scheduled_for), status: String(r.status), outcomeReason: s(r.outcome_reason), attempts: num(r.attempts), processedAt: s(r.processed_at), taskTitle: null, conversationId: null, connectionId: null, conversationType: null }));
  }

  async applyTask(a: ApplyArgs) {
    const r = check<Raw>(
      "applyTask",
      await this.db.rpc("ai_task_apply", {
        p_task_id: a.taskId,
        p_actor: a.actorId,
        p_expected_revision: a.expectedRevision,
        p_set: a.set,
        p_action: a.action,
        p_details: a.details,
        p_assignees: a.assignees,
        p_recipients: a.recipients,
        p_replan: a.replan,
        p_schedules: a.schedules,
        p_notifications: [],
      }),
    );
    if (r.ok !== true) return { ok: false as const, error: String(r.error ?? "unknown") };
    return { ok: true as const, revision: num(r.revision), version: num(r.version), status: r.status as TaskStatus, planned: num(r.planned), cancelled: num(r.cancelled) };
  }

  async notifications(userId: string, unreadOnly: boolean, offset: number, limit: number) {
    let q = this.db.from("user_notifications").select("id, kind, title, body, task_id, connection_id, conversation_id, link, read_at, created_at", { count: "exact" }).eq("user_id", userId);
    if (unreadOnly) q = q.is("read_at", null);
    const res = await q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    if (res.error) throw new TaskStoreError("notifications", res.error.code);
    const unread = await this.db.from("user_notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null);
    if (unread.error) throw new TaskStoreError("unread", unread.error.code);
    return {
      rows: ((res.data as Raw[]) ?? []).map((r): NotificationRow => ({ id: String(r.id), kind: r.kind as NotificationRow["kind"], title: String(r.title), body: s(r.body), taskId: s(r.task_id), connectionId: s(r.connection_id), conversationId: s(r.conversation_id), link: s(r.link), readAt: s(r.read_at), createdAt: String(r.created_at) })),
      total: res.count ?? 0,
      unread: unread.count ?? 0,
    };
  }

  async markRead(userId: string, ids: string[] | null): Promise<number> {
    let q = this.db.from("user_notifications").update({ read_at: new Date().toISOString() }).eq("user_id", userId).is("read_at", null);
    if (ids) q = q.in("id", ids.slice(0, 200));
    const rows = check<Raw[]>("markRead", await q.select("id"));
    return rows.length;
  }

  async userSchedules(userId: string, offset: number, limit: number) {
    const res = await this.db
      .from("ai_reminder_schedules")
      .select("id, kind, task_id, user_id, scheduled_for, status, outcome_reason, attempts, processed_at, task:ai_tasks(title, conversation_id, connection_id, conversation:zalo_personal_conversations!ai_tasks_conversation_id_connection_id_fkey(conversation_type))", { count: "exact" })
      .eq("user_id", userId)
      .order("scheduled_for", { ascending: false })
      .range(offset, offset + limit - 1);
    if (res.error) throw new TaskStoreError("userSchedules", res.error.code);
    return {
      total: res.count ?? 0,
      rows: ((res.data as Raw[]) ?? []).map((r): ScheduleRow => {
        const t = (Array.isArray(r.task) ? r.task[0] : r.task) as Raw | null;
        const c = t ? ((Array.isArray(t.conversation) ? t.conversation[0] : t.conversation) as Raw | null) : null;
        return { id: String(r.id), kind: String(r.kind), taskId: s(r.task_id), userId: String(r.user_id), scheduledFor: String(r.scheduled_for), status: String(r.status), outcomeReason: s(r.outcome_reason), attempts: num(r.attempts), processedAt: s(r.processed_at), taskTitle: t ? s(t.title) : null, conversationId: t ? s(t.conversation_id) : null, connectionId: t ? s(t.connection_id) : null, conversationType: (c?.conversation_type as "user" | "group" | undefined) ?? null };
      }),
    };
  }

  async health(since: Date): Promise<Record<string, unknown>> {
    return check<Record<string, unknown>>("health", await this.db.rpc("ai_task_health", { p_since: since.toISOString() }));
  }
}
