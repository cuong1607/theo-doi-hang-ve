// ============================================================
// PHASE 06 — Task dashboard service (TASK-05 / 10 / 12 / 13). Pure + injected.
//
// Every function: role (zalo_personal:use) → the reader's Phase 03 scope →
// the task's SOURCE conversation decides visibility (out of scope = not_found,
// no existence leak) → the per-task role (manager / assignee / reader) decides
// actions → ONE atomic SQL call (ai_task_apply) with optimistic concurrency.
// Source messages and notification bodies are re-checked against the CURRENT
// scope every time they are shown.
// ============================================================
import { hasPermission, type Role } from "../auth/permissions.ts";
import { conversationScope, type ConversationScope } from "../zalo-personal/dashboard/access.ts";
import { maskId } from "../zalo-personal/dashboard/service.ts";
import { TaskAccess } from "./access.ts";
import type { ReminderWindows } from "./config.ts";
import { allowedActions, canPerform, needsReplan, nextStatus, STATUS_LABEL, ACTION_LABEL, type TaskAction, type TaskRole, type TaskStatus } from "./lifecycle.ts";
import { KIND_LABEL, type InboxNotification } from "./messages.ts";
import { planReminders, prefsOf, type ReminderPrefs } from "./reminders.ts";
import type { AccessStore, ConversationInfo } from "./store.ts";
import { DAY_MS, formatVn, vnStartOfDay } from "./time.ts";

// ------------------------------------------------------------------ store rows

export interface TaskListRow {
  id: string;
  connectionId: string;
  conversationId: string;
  conversationType: "user" | "group";
  externalConversationId: string;
  groupName: string | null;
  title: string;
  status: TaskStatus;
  deadlineAt: string | null;
  deadlinePrecision: string;
  deadlineAssumed: boolean;
  deadlineConfirmed: boolean;
  priority: string | null;
  confidence: number | null;
  extractor: string;
  progress: number;
  hasProposal: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  mine: boolean;
}

export interface TaskRow {
  id: string;
  connectionId: string;
  conversationId: string;
  title: string;
  description: string | null;
  assignorExternalId: string | null;
  status: TaskStatus;
  deadlineAt: string | null;
  deadlinePrecision: "exact" | "day_part" | "date" | "range" | "none";
  deadlinePhrase: string | null;
  deadlineAssumed: boolean;
  deadlineConfirmed: boolean;
  proposedDeadlineAt: string | null;
  proposedDeadlinePhrase: string | null;
  proposedDeadlineMessageId: string | null;
  priority: "low" | "normal" | "high" | null;
  confidence: number | null;
  missing: string[];
  evidence: Array<{ messageId: string; quote: string }>;
  extractor: "gemini" | "rules" | "manual";
  progress: number;
  progressNote: string | null;
  version: number;
  revision: number;
  confirmedBy: string | null;
  confirmedAt: string | null;
  completedBy: string | null;
  completedAt: string | null;
  closedReason: string | null;
  sourceMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentRow {
  externalUserId: string | null;
  internalUserId: string | null;
  source: "mention" | "ai" | "manual";
  /** user behind the UID: connection owner (own account) or a verified link; null = unlinked */
  resolvedUserId: string | null;
}

export interface SourceRow {
  messageId: string;
  role: "primary" | "context" | "deadline_update";
  senderExternalId: string;
  isSelf: boolean;
  text: string | null;
  messageAt: string;
}

export interface ActivityRow {
  id: number;
  actorUserId: string | null;
  actorKind: "user" | "system" | "ai";
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ScheduleRow {
  id: string;
  kind: string;
  taskId: string | null;
  userId: string;
  scheduledFor: string;
  status: string;
  outcomeReason: string | null;
  attempts: number;
  processedAt: string | null;
  taskTitle: string | null;
  conversationId: string | null;
  connectionId: string | null;
  conversationType: "user" | "group" | null;
}

export interface NotificationRow {
  id: string;
  kind: InboxNotification["kind"];
  title: string;
  body: string | null;
  taskId: string | null;
  connectionId: string | null;
  conversationId: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ApplyArgs {
  taskId: string;
  actorId: string;
  expectedRevision: number;
  set: Record<string, unknown>;
  action: string;
  details: Record<string, unknown>;
  assignees: Array<{ externalId?: string; internalUserId?: string; source: "mention" | "ai" | "manual" }> | null;
  recipients: Array<{ userId: string; reason: "assignee" | "confirmer" }> | null;
  replan: boolean;
  schedules: Array<{ kind: string; userId: string; scheduledFor: string; localDate: string }>;
}

export interface TaskServiceStore extends AccessStore {
  listTasks(scope: ConversationScope, q: { userId: string; view: string; status: string | null; conversationId: string | null; assigneeUserId: string | null; due: string | null; now: Date; dayEnd: Date; weekEnd: Date; offset: number; limit: number }): Promise<{ rows: TaskListRow[]; total: number }>;
  task(id: string): Promise<TaskRow | null>;
  assignments(taskId: string, connectionId: string): Promise<AssignmentRow[]>;
  sources(taskId: string): Promise<SourceRow[]>;
  activity(taskId: string, limit: number): Promise<ActivityRow[]>;
  taskSchedules(taskId: string, limit: number): Promise<ScheduleRow[]>;
  applyTask(a: ApplyArgs): Promise<{ ok: true; revision: number; version: number; status: TaskStatus; planned: number; cancelled: number } | { ok: false; error: string }>;
  notifications(userId: string, unreadOnly: boolean, offset: number, limit: number): Promise<{ rows: NotificationRow[]; total: number; unread: number }>;
  markRead(userId: string, ids: string[] | null): Promise<number>;
  savePrefs(userId: string, prefs: ReminderPrefs): Promise<void>;
  userSchedules(userId: string, offset: number, limit: number): Promise<{ rows: ScheduleRow[]; total: number }>;
  health(since: Date): Promise<Record<string, unknown>>;
  /** users who could be assigned: connection owner + active grantees (the service re-checks each can read the chat) */
  connectionPeople(connectionId: string): Promise<string[]>;
}

export interface TaskServiceDeps {
  store: TaskServiceStore;
  reminders: ReminderWindows;
  now?: () => Date;
}

export interface Actor {
  userId: string;
  role: Role;
}

// ------------------------------------------------------------------ results

export type ErrorCode = "forbidden" | "not_found" | "invalid_input" | "conflict" | "server_error";
export type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorCode; code: string; message: string };
const STATUS: Record<ErrorCode, number> = { forbidden: 403, not_found: 404, invalid_input: 400, conflict: 409, server_error: 500 };
export const httpStatusOf = (e: ErrorCode) => STATUS[e];
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = <T>(error: ErrorCode, code: string, message: string): Result<T> => ({ ok: false, error, code, message });
const NOT_FOUND = <T>(): Result<T> => fail("not_found", "not_found", "Không tìm thấy công việc hoặc bạn không có quyền xem.");
const FORBIDDEN_MODULE = <T>(): Result<T> => fail("forbidden", "forbidden", "Bạn không có quyền dùng chức năng Công việc của Zalo cá nhân.");

const conversationTitle = (c: { conversationType: "user" | "group"; groupName: string | null; externalConversationId?: string }) =>
  c.conversationType === "group" ? c.groupName?.trim() || `Nhóm ${maskId(c.externalConversationId ?? "") ?? ""}`.trim() : `Chat 1-1 ${maskId(c.externalConversationId ?? "") ?? ""}`.trim();

export function deadlineLabel(t: { deadlineAt: string | null; deadlinePrecision: string; deadlineAssumed: boolean; deadlineConfirmed: boolean }): string {
  if (!t.deadlineAt) return "Chưa có hạn";
  const base = formatVn(new Date(t.deadlineAt));
  if (t.deadlineConfirmed) return base;
  return t.deadlineAssumed || t.deadlinePrecision !== "exact" ? `${base} (giả định, cần xác nhận)` : base;
}

// ------------------------------------------------------------------ list

export interface ListQuery {
  view?: "all" | "pending" | "mine" | "overdue";
  status?: TaskStatus;
  conversationId?: string;
  assignee?: "me";
  due?: "today" | "week" | "none";
  page: number;
  size: number;
}

export interface TaskListItem {
  id: string;
  title: string;
  status: TaskStatus;
  statusLabel: string;
  conversationId: string;
  conversationTitle: string;
  conversationType: "user" | "group";
  deadlineAt: string | null;
  deadlineLabel: string;
  deadlineNeedsConfirmation: boolean;
  overdue: boolean;
  priority: string | null;
  extractor: string;
  confidence: number | null;
  progress: number;
  hasProposal: boolean;
  mine: boolean;
  createdAt: string;
}

export async function listTasks(deps: TaskServiceDeps, actor: Actor, q: ListQuery): Promise<Result<{ rows: TaskListItem[]; total: number; page: number; size: number }>> {
  if (!hasPermission(actor.role, "zalo_personal:use")) return FORBIDDEN_MODULE();
  const access = new TaskAccess(deps.store);
  const scope = await access.scope(actor.userId);
  if (!scope) return FORBIDDEN_MODULE();
  const cs = conversationScope(scope);
  const now = (deps.now ?? (() => new Date()))();
  const dayEnd = new Date(vnStartOfDay(now).getTime() + DAY_MS);
  const { rows, total } = await deps.store.listTasks(cs, {
    userId: actor.userId,
    view: q.view ?? "all",
    status: q.status ?? null,
    conversationId: q.conversationId ?? null,
    assigneeUserId: q.assignee === "me" ? actor.userId : null,
    due: q.due ?? null,
    now,
    dayEnd,
    weekEnd: new Date(dayEnd.getTime() + 6 * DAY_MS),
    offset: (q.page - 1) * q.size,
    limit: q.size,
  });
  return ok({
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status],
      conversationId: r.conversationId,
      conversationTitle: conversationTitle(r),
      conversationType: r.conversationType,
      deadlineAt: r.deadlineAt,
      deadlineLabel: deadlineLabel(r),
      deadlineNeedsConfirmation: Boolean(r.deadlineAt && !r.deadlineConfirmed && (r.deadlineAssumed || r.deadlinePrecision !== "exact")),
      overdue: r.status === "overdue" || Boolean(r.deadlineAt && (r.status === "accepted" || r.status === "in_progress") && Date.parse(r.deadlineAt) < now.getTime()),
      priority: r.priority,
      extractor: r.extractor,
      confidence: r.confidence,
      progress: r.progress,
      hasProposal: r.hasProposal,
      mine: r.mine,
      createdAt: r.createdAt,
    })),
    total,
    page: q.page,
    size: q.size,
  });
}

export async function taskCounts(deps: TaskServiceDeps, actor: Actor): Promise<Result<{ pending: number; mine: number; overdue: number; unread: number }>> {
  const base = { page: 1, size: 1 };
  const [p, m, o] = await Promise.all([listTasks(deps, actor, { ...base, view: "pending" }), listTasks(deps, actor, { ...base, view: "mine" }), listTasks(deps, actor, { ...base, view: "overdue" })]);
  if (!p.ok) return p;
  const n = await deps.store.notifications(actor.userId, true, 0, 1);
  return ok({ pending: p.data.total, mine: m.ok ? m.data.total : 0, overdue: o.ok ? o.data.total : 0, unread: n.unread });
}

// ------------------------------------------------------------------ detail

interface Loaded {
  task: TaskRow;
  conversation: ConversationInfo;
  assignments: AssignmentRow[];
  assigneeUserIds: string[];
  role: TaskRole;
  access: TaskAccess;
}

async function load(deps: TaskServiceDeps, actor: Actor, taskId: string): Promise<Result<Loaded>> {
  if (!hasPermission(actor.role, "zalo_personal:use")) return FORBIDDEN_MODULE();
  const task = await deps.store.task(taskId);
  if (!task) return NOT_FOUND();
  const conversation = await deps.store.conversationInfo(task.conversationId);
  if (!conversation || conversation.connectionId !== task.connectionId) return NOT_FOUND();
  const access = new TaskAccess(deps.store);
  const assignments = await deps.store.assignments(task.id, task.connectionId);
  const assigneeUserIds = [...new Set(assignments.map((a) => a.internalUserId ?? a.resolvedUserId).filter((x): x is string => Boolean(x)))];
  const role = await access.roleFor(actor.userId, conversation, assigneeUserIds);
  if (role === "none") return NOT_FOUND();
  return ok({ task, conversation, assignments, assigneeUserIds, role, access });
}

export interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  statusLabel: string;
  role: TaskRole;
  actions: Array<{ action: TaskAction; label: string }>;
  revision: number;
  conversation: { id: string; title: string; type: "user" | "group" };
  deadline: { at: string | null; label: string; precision: string; phrase: string | null; assumed: boolean; confirmed: boolean };
  proposal: { at: string; label: string; phrase: string | null; messageId: string | null } | null;
  priority: string | null;
  confidence: number | null;
  extractor: string;
  missing: string[];
  evidence: Array<{ messageId: string; quote: string }>;
  progress: number;
  progressNote: string | null;
  closedReason: string | null;
  assignor: string | null;
  assignees: Array<{ label: string; userId: string | null; linked: boolean; source: string }>;
  confirmedBy: string | null;
  confirmedAt: string | null;
  completedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  sources: Array<{ id: string; role: string; sender: string; isSelf: boolean; text: string | null; at: string; link: string }>;
  activity: Array<{ id: number; actor: string; action: string; fromStatus: string | null; toStatus: string | null; details: Record<string, unknown>; at: string }>;
  reminders: Array<{ id: string; kind: string; scheduledFor: string; status: string; reason: string | null; mine: boolean }>;
  assignable: Array<{ userId: string; name: string }>;
}

const ACTIVITY_LABEL: Record<string, string> = {
  proposed: "Hệ thống đề xuất việc",
  confirm: "Xác nhận",
  dismiss: "Bỏ qua (không phải việc)",
  edit: "Chỉnh sửa",
  start: "Bắt đầu làm",
  progress: "Cập nhật tiến độ",
  complete: "Hoàn thành",
  cancel: "Hủy",
  reopen: "Mở lại",
  accept_proposal: "Áp dụng hạn mới",
  reject_proposal: "Giữ hạn cũ",
  deadline_proposed: "Tin nhắn mới đề xuất đổi hạn",
  marked_overdue: "Hệ thống đánh dấu quá hạn",
};

export async function getTask(deps: TaskServiceDeps, actor: Actor, taskId: string): Promise<Result<TaskDetail>> {
  const l = await load(deps, actor, taskId);
  if (!l.ok) return l;
  const { task, conversation, assignments, role, access } = l.data;
  const [sources, activity, schedules] = await Promise.all([deps.store.sources(task.id), deps.store.activity(task.id, 100), deps.store.taskSchedules(task.id, 100)]);
  const people = new Set<string>([...assignments.flatMap((a) => [a.internalUserId, a.resolvedUserId]), task.confirmedBy, task.completedBy, ...activity.map((a) => a.actorUserId)].filter((x): x is string => Boolean(x)));
  const assignableIds = role === "manager" ? await deps.store.connectionPeople(task.connectionId) : [];
  for (const id of assignableIds) people.add(id);
  const profiles = new Map((await deps.store.profiles([...people])).map((p) => [p.id, p]));
  const nameOf = (id: string | null) => (id ? profiles.get(id)?.name?.trim() || "Người dùng" : null);
  const assignable: TaskDetail["assignable"] = [];
  for (const id of assignableIds) if (await access.canRead(id, conversation)) assignable.push({ userId: id, name: nameOf(id)! });

  const snapshot = { status: task.status, deadlineAt: task.deadlineAt ? new Date(task.deadlineAt) : null, progress: task.progress, hasProposal: Boolean(task.proposedDeadlineAt) };
  return ok({
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    statusLabel: STATUS_LABEL[task.status],
    role,
    actions: allowedActions(role, snapshot).map((a) => ({ action: a, label: ACTION_LABEL[a] })),
    revision: task.revision,
    conversation: { id: conversation.id, title: conversationTitle(conversation), type: conversation.conversationType },
    deadline: { at: task.deadlineAt, label: deadlineLabel(task), precision: task.deadlinePrecision, phrase: task.deadlinePhrase, assumed: task.deadlineAssumed, confirmed: task.deadlineConfirmed },
    proposal: task.proposedDeadlineAt ? { at: task.proposedDeadlineAt, label: formatVn(new Date(task.proposedDeadlineAt)), phrase: task.proposedDeadlinePhrase, messageId: task.proposedDeadlineMessageId } : null,
    priority: task.priority,
    confidence: task.confidence,
    extractor: task.extractor,
    missing: task.missing,
    evidence: task.evidence,
    progress: task.progress,
    progressNote: task.progressNote,
    closedReason: task.closedReason,
    assignor: task.assignorExternalId ? `Zalo ${maskId(task.assignorExternalId)}` : null,
    assignees: assignments.map((a) => {
      const uid = a.internalUserId ?? a.resolvedUserId;
      return { label: uid ? nameOf(uid)! : `Zalo ${maskId(a.externalUserId)} (chưa liên kết)`, userId: uid, linked: Boolean(uid), source: a.source };
    }),
    confirmedBy: nameOf(task.confirmedBy),
    confirmedAt: task.confirmedAt,
    completedBy: nameOf(task.completedBy),
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    // the reader can read the conversation (role ≠ none) — sources are re-loaded, never cached text
    sources: sources.map((s) => ({
      id: s.messageId,
      role: s.role,
      sender: s.isSelf ? "Chủ tài khoản" : `Zalo ${maskId(s.senderExternalId)}`,
      isSelf: s.isSelf,
      text: s.text,
      at: s.messageAt,
      link: `/apps/zalo/personal/conversations/${conversation.id}?focus=${s.messageId}&at=${encodeURIComponent(s.messageAt)}`,
    })),
    activity: activity.map((a) => ({ id: a.id, actor: a.actorKind === "user" ? nameOf(a.actorUserId) ?? "Người dùng" : a.actorKind === "ai" ? "AI" : "Hệ thống", action: ACTIVITY_LABEL[a.action] ?? a.action, fromStatus: a.fromStatus, toStatus: a.toStatus, details: a.details, at: a.createdAt })),
    reminders: schedules.map((s) => ({ id: s.id, kind: s.kind, scheduledFor: s.scheduledFor, status: s.status, reason: s.outcomeReason, mine: s.userId === actor.userId })),
    assignable,
  });
}

// ------------------------------------------------------------------ actions

export type ActionInput =
  | { action: "confirm"; revision: number; title?: string; description?: string | null; deadlineAt?: string | null; assigneeUserIds?: string[]; keepExternal?: string[] }
  | { action: "edit"; revision: number; title?: string; description?: string | null; deadlineAt?: string | null; priority?: "low" | "normal" | "high" | null; assigneeUserIds?: string[]; keepExternal?: string[] }
  | { action: "dismiss" | "cancel"; revision: number; reason?: string | null }
  | { action: "start" | "reopen" | "accept_proposal" | "reject_proposal"; revision: number }
  | { action: "progress"; revision: number; progress: number; note?: string | null }
  | { action: "complete"; revision: number; note?: string | null };

export async function actOnTask(deps: TaskServiceDeps, actor: Actor, taskId: string, input: ActionInput): Promise<Result<{ status: TaskStatus; revision: number; planned: number; cancelled: number }>> {
  const l = await load(deps, actor, taskId);
  if (!l.ok) return l;
  const { task, conversation, assignments, role, access } = l.data;
  const now = (deps.now ?? (() => new Date()))();
  const before = { status: task.status, deadlineAt: task.deadlineAt ? new Date(task.deadlineAt) : null, progress: task.progress, hasProposal: Boolean(task.proposedDeadlineAt) };
  const perm = canPerform(input.action, role, before);
  if (!perm.ok) {
    return perm.reason === "forbidden"
      ? fail("forbidden", "forbidden", role === "reader" ? "Bạn chỉ có quyền xem công việc này." : "Bạn không có quyền thực hiện thao tác này.")
      : fail("conflict", "invalid_state", `Không thể "${ACTION_LABEL[input.action]}" khi việc đang ở trạng thái "${STATUS_LABEL[task.status]}".`);
  }

  const set: Record<string, unknown> = {};
  const details: Record<string, unknown> = {};
  let deadlineAt = before.deadlineAt;
  let progress = task.progress;
  let assigneesPayload: ApplyArgs["assignees"] = null;
  let assigneeIds = l.data.assigneeUserIds;

  if (input.action === "confirm" || input.action === "edit") {
    if (input.title !== undefined) {
      const t = input.title.replace(/\s+/g, " ").trim();
      if (!t || t.length > 300) return fail("invalid_input", "invalid_title", "Tiêu đề cần 1–300 ký tự.");
      if (t !== task.title) {
        set.title = t;
        details.title = true;
      }
    }
    if (input.description !== undefined && (input.description ?? null) !== task.description) {
      set.description = input.description ?? "";
      details.description = true;
    }
    if (input.action === "edit" && input.priority !== undefined) {
      set.priority = input.priority;
      details.priority = input.priority;
    }
    if (input.deadlineAt !== undefined) {
      const d = input.deadlineAt === null ? null : new Date(input.deadlineAt);
      if (d && Number.isNaN(d.getTime())) return fail("invalid_input", "invalid_deadline", "Hạn không hợp lệ.");
      if ((d?.getTime() ?? null) !== (before.deadlineAt?.getTime() ?? null)) {
        deadlineAt = d;
        Object.assign(set, { deadlineAt: d?.toISOString() ?? null, deadlinePrecision: d ? "exact" : "none", deadlinePhrase: null, deadlineAssumed: false, deadlineConfirmed: Boolean(d) });
        details.deadline = { from: task.deadlineAt, to: d?.toISOString() ?? null };
      }
    }
    if (input.assigneeUserIds !== undefined || input.keepExternal !== undefined) {
      const keep = new Set(input.keepExternal ?? assignments.filter((a) => a.externalUserId).map((a) => a.externalUserId!));
      const ext = assignments.filter((a) => a.externalUserId && keep.has(a.externalUserId)).map((a) => ({ externalId: a.externalUserId!, source: a.source }));
      const manual = [...new Set(input.assigneeUserIds ?? assignments.filter((a) => a.internalUserId).map((a) => a.internalUserId!))];
      // never assign somebody who could not read the source conversation (would leak it through reminders)
      for (const u of manual) if (!(await access.canRead(u, conversation))) return fail("invalid_input", "assignee_no_access", "Người được giao không có quyền xem hội thoại nguồn.");
      assigneesPayload = [...ext, ...manual.map((u) => ({ internalUserId: u, source: "manual" as const }))];
      const resolved = new Map(assignments.filter((a) => a.externalUserId).map((a) => [a.externalUserId!, a.resolvedUserId]));
      assigneeIds = [...new Set([...ext.map((e) => resolved.get(e.externalId)).filter((x): x is string => Boolean(x)), ...manual])];
      details.assignees = { external: ext.length, internal: manual.length };
    }
    if (input.action === "confirm") {
      Object.assign(set, { confirmedBy: actor.userId, confirmedAt: now.toISOString() });
      if (deadlineAt && !("deadlineConfirmed" in set)) set.deadlineConfirmed = true;
    }
  } else if (input.action === "progress") {
    if (!Number.isInteger(input.progress) || input.progress < 0 || input.progress > 100) return fail("invalid_input", "invalid_progress", "Tiến độ là số từ 0 đến 100.");
    progress = input.progress;
    Object.assign(set, { progress, progressNote: input.note ?? "" });
    details.progress = progress;
  } else if (input.action === "complete") {
    Object.assign(set, { completedBy: actor.userId, completedAt: now.toISOString(), progress: 100, closedReason: input.note ?? "" });
  } else if (input.action === "dismiss" || input.action === "cancel") {
    set.closedReason = input.reason ?? "";
  } else if (input.action === "reopen") {
    Object.assign(set, { completedBy: null, completedAt: null, closedReason: "" });
  } else if (input.action === "accept_proposal") {
    deadlineAt = new Date(task.proposedDeadlineAt!);
    Object.assign(set, { deadlineAt: deadlineAt.toISOString(), deadlinePrecision: "exact", deadlinePhrase: task.proposedDeadlinePhrase, deadlineAssumed: false, deadlineConfirmed: true, clearProposal: true });
    details.deadline = { from: task.deadlineAt, to: deadlineAt.toISOString() };
  } else if (input.action === "reject_proposal") {
    set.clearProposal = true;
  }

  const status = nextStatus(input.action, task.status, { deadlineAt, progress }, now);
  if (status !== task.status) set.status = status;
  const replan = needsReplan(input.action, before, { status, deadlineAt }, assigneesPayload !== null);

  // recipients: resolved assignees who can read the chat; nobody → whoever confirmed
  let recipients: ApplyArgs["recipients"] = null;
  let schedules: ApplyArgs["schedules"] = [];
  if (replan) {
    const list: Array<{ userId: string; reason: "assignee" | "confirmer" }> = [];
    for (const u of assigneeIds) if (await access.canRead(u, conversation)) list.push({ userId: u, reason: "assignee" });
    const confirmer = input.action === "confirm" ? actor.userId : task.confirmedBy;
    if (!list.length && confirmer && (await access.canRead(confirmer, conversation))) list.push({ userId: confirmer, reason: "confirmer" });
    recipients = list;
    const prefs = await deps.store.prefs(list.map((r) => r.userId));
    schedules = planReminders({ status, deadlineAt }, list.map((r) => ({ userId: r.userId, prefs: prefs.get(r.userId) ?? prefsOf(null) })), now, deps.reminders).map((p) => ({ kind: p.kind, userId: p.userId, scheduledFor: p.scheduledFor.toISOString(), localDate: p.localDate }));
  }

  const res = await deps.store.applyTask({ taskId, actorId: actor.userId, expectedRevision: input.revision, set, action: input.action, details, assignees: assigneesPayload, recipients, replan, schedules });
  if (!res.ok) {
    if (res.error === "conflict") return fail("conflict", "conflict", "Công việc vừa được người khác thay đổi. Tải lại trang để xem bản mới nhất.");
    if (res.error === "not_found") return NOT_FOUND();
    return fail("server_error", res.error, "Không thể lưu thay đổi. Vui lòng thử lại.");
  }
  return ok({ status: res.status, revision: res.revision, planned: res.planned, cancelled: res.cancelled });
}

// ------------------------------------------------------------------ inbox

export interface NotificationView {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
  hidden: boolean;
}

export async function listNotifications(deps: TaskServiceDeps, actor: Actor, q: { unread: boolean; page: number; size: number }): Promise<Result<{ rows: NotificationView[]; total: number; unread: number; page: number; size: number }>> {
  if (!hasPermission(actor.role, "zalo_personal:use")) return FORBIDDEN_MODULE();
  const access = new TaskAccess(deps.store);
  const { rows, total, unread } = await deps.store.notifications(actor.userId, q.unread, (q.page - 1) * q.size, q.size);
  const out: NotificationView[] = [];
  for (const r of rows) {
    // re-checked NOW: a reader who lost access to the source chat sees no title / body / link
    let visible = true;
    if (r.conversationId) {
      const c = await deps.store.conversationInfo(r.conversationId);
      visible = Boolean(c && (await access.canRead(actor.userId, c)));
    } else if (r.connectionId) {
      visible = Boolean(await access.scope(actor.userId));
    }
    out.push(
      visible
        ? { id: r.id, kind: r.kind, kindLabel: KIND_LABEL[r.kind] ?? r.kind, title: r.title, body: r.body, link: r.link, read: Boolean(r.readAt), createdAt: r.createdAt, hidden: false }
        : { id: r.id, kind: r.kind, kindLabel: KIND_LABEL[r.kind] ?? r.kind, title: "Thông báo không còn trong phạm vi bạn được xem", body: null, link: null, read: Boolean(r.readAt), createdAt: r.createdAt, hidden: true },
    );
  }
  return ok({ rows: out, total, unread, page: q.page, size: q.size });
}

export async function markNotificationsRead(deps: TaskServiceDeps, actor: Actor, ids: string[] | null): Promise<Result<{ updated: number }>> {
  if (!hasPermission(actor.role, "zalo_personal:use")) return FORBIDDEN_MODULE();
  return ok({ updated: await deps.store.markRead(actor.userId, ids) });
}

// ------------------------------------------------------------------ preferences / history

export async function getPreferences(deps: TaskServiceDeps, actor: Actor): Promise<Result<ReminderPrefs>> {
  if (!hasPermission(actor.role, "zalo_personal:use")) return FORBIDDEN_MODULE();
  return ok(prefsOf((await deps.store.prefs([actor.userId])).get(actor.userId)));
}

export async function savePreferences(deps: TaskServiceDeps, actor: Actor, prefs: ReminderPrefs): Promise<Result<ReminderPrefs>> {
  if (!hasPermission(actor.role, "zalo_personal:use")) return FORBIDDEN_MODULE();
  await deps.store.savePrefs(actor.userId, prefs);
  return ok(prefs);
}

export interface HistoryView {
  rows: Array<{ id: string; kind: string; scheduledFor: string; status: string; reason: string | null; attempts: number; processedAt: string | null; taskId: string | null; taskTitle: string | null }>;
  total: number;
  page: number;
  size: number;
  health: Record<string, unknown>;
}

/** The reader's OWN reminder occurrences (+ engine health, counts only). */
export async function reminderHistory(deps: TaskServiceDeps, actor: Actor, q: { page: number; size: number }): Promise<Result<HistoryView>> {
  if (!hasPermission(actor.role, "zalo_personal:use")) return FORBIDDEN_MODULE();
  const access = new TaskAccess(deps.store);
  const now = (deps.now ?? (() => new Date()))();
  const [{ rows, total }, health] = await Promise.all([deps.store.userSchedules(actor.userId, (q.page - 1) * q.size, q.size), deps.store.health(new Date(now.getTime() - DAY_MS))]);
  const out: HistoryView["rows"] = [];
  for (const r of rows) {
    const readable = r.conversationId && r.connectionId && r.conversationType ? await access.canRead(actor.userId, { id: r.conversationId, connectionId: r.connectionId, conversationType: r.conversationType }) : false;
    out.push({ id: r.id, kind: r.kind, scheduledFor: r.scheduledFor, status: r.status, reason: r.outcomeReason, attempts: r.attempts, processedAt: r.processedAt, taskId: readable ? r.taskId : null, taskTitle: readable ? r.taskTitle : r.taskId ? "(không còn quyền xem)" : null });
  }
  return ok({ rows: out, total, page: q.page, size: q.size, health });
}
