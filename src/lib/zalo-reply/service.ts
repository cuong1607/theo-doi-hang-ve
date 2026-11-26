// ============================================================
// PHASE 04.5 — REPLY-05 / REPLY-09: dashboard services (AI Reply Inbox,
// Outbound History, Reply Settings, account linking). Pure + injected.
//
// Access (re-derived from the server-side Phase 03 scope on every call):
//   see / review a draft   canReview: owner (1-1 + group) or manage grant
//                          (group), AND the reviewer's role holds every
//                          permission the answer's data needed
//   settings / allowlist / block list / pause    connection owner
//   emergency stop         anyone with module access (stopping is always safe)
//   emergency resume       admin role only
// Unknown or out-of-scope ids → not_found (no existence leak).
// ============================================================
import { hasPermission } from "../auth/permissions.ts";
import { issuePersonalLinkCode, type IdentityStore } from "../ai-system/identity.ts";
import { buildScope, type AccessScope, type Actor } from "../zalo-personal/dashboard/access.ts";
import { conversationTitle, maskId, type DashboardStore } from "../zalo-personal/dashboard/service.ts";
import type { ReplyConfig } from "./config.ts";
import type { ActionInput, ControlInput, SettingsInput } from "./contracts.ts";
import { ACTION_LABEL, allowedActions, ERROR_LABEL, HOLD_LABEL, STATUS_LABEL, type DraftStatus, type ReviewAction } from "./lifecycle.ts";
import { canConfigure, canReview, type DraftCitation } from "./policy.ts";
import { SKIP_REASON_LABEL } from "./router.ts";
import { DEFAULT_SETTINGS, type BlockRow, type ConversationOption, type DraftRow, type ReplySettings, type ReviewStore } from "./store.ts";

export type { Actor };

export interface ReviewDeps {
  store: ReviewStore;
  dashboard: DashboardStore;
  identity: IdentityStore;
  config: ReplyConfig;
  now?: () => Date;
}

export type ErrorKind = "forbidden" | "not_found" | "invalid_input" | "conflict" | "server_error";
export type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorKind; code: string; message: string };
const STATUS: Record<ErrorKind, number> = { forbidden: 403, not_found: 404, invalid_input: 400, conflict: 409, server_error: 500 };
export const httpStatusOf = (e: ErrorKind) => STATUS[e];
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = <T>(error: ErrorKind, code: string, message: string): Result<T> => ({ ok: false, error, code, message });
const NOT_FOUND = <T>(): Result<T> => fail("not_found", "not_found", "Không tìm thấy hoặc bạn không có quyền xem.");

async function scopeOf(deps: ReviewDeps, actor: Actor): Promise<AccessScope> {
  const { connections, grants } = await deps.dashboard.loadAccess(actor.userId);
  return buildScope(actor, connections, grants);
}

/** Connections whose GROUP drafts / 1-1 drafts the reader may list (fine-grained check per draft follows). */
function listable(scope: AccessScope): { group: string[]; direct: string[] } {
  const group: string[] = [];
  const direct: string[] = [];
  for (const a of scope.connections.values()) {
    if (a.owner) {
      group.push(a.connectionId);
      direct.push(a.connectionId);
    } else if (a.level === "manage") group.push(a.connectionId);
  }
  return { group, direct };
}

// ---------------------------------------------------------------- views

export interface DraftView {
  id: string;
  status: DraftStatus;
  statusLabel: string;
  kind: DraftRow["kind"];
  pipeline: DraftRow["pipeline"];
  conversation: { id: string; type: "user" | "group"; title: string; href: string };
  asker: { label: string; linkedName: string | null };
  source: { text: string | null; at: string | null; href: string };
  text: string;
  originalText: string;
  edited: boolean;
  version: number;
  citations: DraftCitation[];
  caveats: string[];
  approval: "manual" | "auto" | null;
  approvedByName: string | null;
  approvedAt: string | null;
  expiresAt: string;
  expired: boolean;
  createdAt: string;
  sendingStartedAt: string | null;
  sentAt: string | null;
  attempts: number;
  error: { code: string; label: string } | null;
  hold: { code: string; label: string } | null;
  model: string | null;
  actions: Array<{ action: ReviewAction; label: string }>;
}

function viewOf(d: DraftRow, now: Date, reviewable: boolean): DraftView {
  const expired = Date.parse(d.expiresAt) <= now.getTime();
  const title = conversationTitle({ conversationType: d.conversationType, externalConversationId: d.externalConversationId, groupName: d.groupName });
  const convHref = `/apps/zalo/personal/conversations/${d.conversationId}`;
  return {
    id: d.id,
    status: d.status,
    statusLabel: STATUS_LABEL[d.status],
    kind: d.kind,
    pipeline: d.pipeline,
    conversation: { id: d.conversationId, type: d.conversationType, title, href: convHref },
    asker: { label: `Người gửi ${maskId(d.askerExternalId) ?? ""}`.trim(), linkedName: d.askerName },
    source: { text: d.sourceText, at: d.sourceAt, href: d.sourceAt ? `${convHref}?focus=${d.sourceMessageId}&at=${encodeURIComponent(d.sourceAt)}` : convHref },
    text: d.text,
    originalText: d.originalText,
    edited: d.edited,
    version: d.version,
    citations: d.citations,
    caveats: d.caveats,
    approval: d.approval,
    approvedByName: d.approval === "auto" ? "Tự động" : d.approvedByName,
    approvedAt: d.approvedAt,
    expiresAt: d.expiresAt,
    expired,
    createdAt: d.createdAt,
    sendingStartedAt: d.sendingStartedAt,
    sentAt: d.sentAt,
    attempts: d.attempts,
    error: d.errorCategory ? { code: d.errorCategory, label: ERROR_LABEL[d.errorCategory] ?? d.errorCategory } : null,
    hold: d.holdReason && d.status === "queued" ? { code: d.holdReason, label: HOLD_LABEL[d.holdReason] ?? d.holdReason } : null,
    model: d.model,
    actions: reviewable ? allowedActions(d.status, expired).map((a) => ({ action: a, label: ACTION_LABEL[a] })) : [],
  };
}

const REVIEW: DraftStatus[] = ["pending_approval", "queued", "sending", "delivery_unknown"];
const OUTBOUND: DraftStatus[] = ["queued", "sending", "sent", "failed", "delivery_unknown", "cancelled", "expired"];

export interface InboxView {
  rows: DraftView[];
  counts: Record<string, number>;
  flags: { replyEnabled: boolean; sendEnabled: boolean; autoReplyEnabled: boolean };
  emergencyStop: boolean;
  pausedConnections: number;
}

export async function listDrafts(deps: ReviewDeps, actor: Actor, q: { status: string; connectionId?: string }): Promise<Result<InboxView>> {
  const now = deps.now?.() ?? new Date();
  const scope = await scopeOf(deps, actor);
  let { group, direct } = listable(scope);
  if (q.connectionId) {
    group = group.filter((c) => c === q.connectionId);
    direct = direct.filter((c) => c === q.connectionId);
  }
  const statuses = q.status === "review" ? REVIEW : q.status === "outbound" ? OUTBOUND : q.status === "all" ? undefined : [q.status as DraftStatus];
  const [rows, counts, control, settings] = await Promise.all([
    group.length ? deps.store.drafts({ connectionIds: group, directConnectionIds: direct, statuses, limit: 100 }) : Promise.resolve([]),
    group.length ? deps.store.statusCounts(group, direct) : Promise.resolve({}),
    deps.store.control(),
    deps.store.settingsFor(direct),
  ]);
  const visible = rows.filter((d) => canReview(scope, actor.role, d));
  return ok({
    rows: visible.map((d) => viewOf(d, now, true)),
    counts,
    flags: { replyEnabled: deps.config.enabled, sendEnabled: deps.config.sendEnabled, autoReplyEnabled: deps.config.autoReplyEnabled },
    emergencyStop: control.emergencyStop,
    pausedConnections: [...settings.values()].filter((s) => s.sendPaused).length,
  });
}

export interface DraftDetail extends DraftView {
  audit: Array<{ id: number; at: string; actor: string; action: string; fromStatus: string | null; toStatus: string | null; detail: string | null }>;
  requiredPermissions: string[];
}

const AUDIT_ACTION_LABEL: Record<string, string> = {
  "draft.created": "Tạo bản nháp",
  "draft.auto_approved": "Tự động duyệt",
  "draft.approve": "Duyệt",
  "draft.edit": "Sửa nội dung",
  "draft.reject": "Từ chối",
  "draft.cancel": "Hủy",
  "draft.expired": "Hết hạn",
  "draft.confirm_sent": "Xác nhận đã gửi",
  "draft.confirm_not_sent": "Xác nhận chưa gửi",
  "outbound.claimed": "Worker nhận gửi",
  "outbound.sent": "Đã gửi",
  "outbound.not_sent": "Chưa gửi được (sẽ thử lại)",
  "outbound.failed": "Zalo từ chối",
  "outbound.unknown": "Chưa rõ kết quả",
  "outbound.lease_expired": "Worker không báo kết quả",
  "outbound.cancelled": "Hủy trước khi gửi",
  "group.send_verified": "Xác minh đường gửi của nhóm",
};

export async function getDraft(deps: ReviewDeps, actor: Actor, id: string): Promise<Result<DraftDetail>> {
  const now = deps.now?.() ?? new Date();
  const [scope, d] = await Promise.all([scopeOf(deps, actor), deps.store.draft(id)]);
  if (!d || !canReview(scope, actor.role, d)) return NOT_FOUND();
  const audit = await deps.store.audit(d.id);
  return ok({
    ...viewOf(d, now, true),
    requiredPermissions: d.requiredPermissions,
    audit: audit.map((a) => ({
      id: a.id,
      at: a.createdAt,
      actor: a.actorKind === "user" ? a.actorName ?? "Người dùng" : a.actorKind === "worker" ? "Worker" : "Hệ thống",
      action: AUDIT_ACTION_LABEL[a.action] ?? a.action,
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      detail: typeof a.details.reason === "string" ? ERROR_LABEL[a.details.reason] ?? a.details.reason : typeof a.details.error === "string" ? ERROR_LABEL[a.details.error] ?? a.details.error : typeof a.details.note === "string" ? a.details.note : null,
    })),
  });
}

const ACT_ERROR: Record<string, { error: ErrorKind; message: string }> = {
  version_conflict: { error: "conflict", message: "Bản nháp vừa được người khác thay đổi. Trang đã được tải lại." },
  invalid_transition: { error: "conflict", message: "Không thể thực hiện thao tác này ở trạng thái hiện tại." },
  expired: { error: "conflict", message: "Bản nháp đã hết hạn (câu trả lời có thể đã lỗi thời) nên không thể duyệt." },
  invalid_text: { error: "invalid_input", message: "Nội dung phải dài 1–1800 ký tự." },
  not_found: { error: "not_found", message: "Không tìm thấy hoặc bạn không có quyền xem." },
};

export async function actOnDraft(deps: ReviewDeps, actor: Actor, id: string, input: ActionInput): Promise<Result<{ status: DraftStatus; version: number }>> {
  const [scope, d] = await Promise.all([scopeOf(deps, actor), deps.store.draft(id)]);
  if (!d || !canReview(scope, actor.role, d)) return NOT_FOUND();
  if (!deps.config.enabled) return fail("conflict", "not_enabled", "Trả lời AI đang tắt.");
  const r = await deps.store.act(actor.userId, d.id, input.action, input.version, input.action === "edit" ? input.text ?? null : null, input.note ?? null);
  if (!r.ok) {
    const e = ACT_ERROR[r.error] ?? { error: "server_error" as const, message: "Không thực hiện được thao tác." };
    return fail(e.error, r.error, e.message);
  }
  return ok({ status: r.status, version: r.version });
}

// ---------------------------------------------------------------- settings

export interface ConnectionSettingsView {
  connectionId: string;
  connectionKey: string;
  settings: ReplySettings;
  conversations: Array<ConversationOption & { title: string }>;
  blocks: Array<BlockRow & { label: string }>;
  sentToday: number;
}

export interface SettingsView {
  connections: ConnectionSettingsView[];
  control: { emergencyStop: boolean; changedAt: string | null; changedByName: string | null; reason: string | null; canResume: boolean };
  flags: { replyEnabled: boolean; sendEnabled: boolean; autoReplyEnabled: boolean; globalDailyLimit: number };
  identities: Array<{ id: string; connectionKey: string; externalLabel: string; linkedAt: string }>;
  canLink: boolean;
}

export async function getSettings(deps: ReviewDeps, actor: Actor): Promise<Result<SettingsView>> {
  const now = deps.now?.() ?? new Date();
  const scope = await scopeOf(deps, actor);
  const owned = [...scope.connections.values()].filter((a) => a.owner).map((a) => a.connectionId);
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  const dayStart = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3_600_000);
  const [conns, settings, conversations, blocks, control, identities] = await Promise.all([
    owned.length ? deps.dashboard.connections(owned) : Promise.resolve([]),
    deps.store.settingsFor(owned),
    owned.length ? deps.store.conversations(owned) : Promise.resolve([]),
    owned.length ? deps.store.blocks(owned) : Promise.resolve([]),
    deps.store.control(),
    deps.identity.listPersonalIdentities(actor.userId),
  ]);
  const keyOf = new Map(conns.map((c) => [c.id, c.connectionKey]));
  const allConn = [...scope.connections.keys()];
  const allConns = allConn.length ? await deps.dashboard.connections(allConn) : [];
  for (const c of allConns) keyOf.set(c.id, c.connectionKey);
  const views: ConnectionSettingsView[] = [];
  for (const id of owned) {
    views.push({
      connectionId: id,
      connectionKey: keyOf.get(id) ?? id.slice(0, 8),
      settings: settings.get(id) ?? DEFAULT_SETTINGS,
      conversations: conversations.filter((c) => c.connectionId === id).map((c) => ({ ...c, title: conversationTitle(c) })),
      blocks: blocks.filter((b) => b.connectionId === id).map((b) => ({ ...b, label: maskId(b.externalUserId) ?? b.externalUserId })),
      sentToday: await deps.store.sentToday([id], dayStart),
    });
  }
  return ok({
    connections: views,
    control: { ...control, canResume: actor.role === "admin" },
    flags: { replyEnabled: deps.config.enabled, sendEnabled: deps.config.sendEnabled, autoReplyEnabled: deps.config.autoReplyEnabled, globalDailyLimit: deps.config.globalDailyLimit },
    identities: identities.map((i) => ({ id: i.id, connectionKey: keyOf.get(i.connectionId) ?? "—", externalLabel: maskId(i.externalUserId) ?? "—", linkedAt: i.linkedAt })),
    canLink: hasPermission(actor.role, "ai_system:use"),
  });
}

const ADMIN_ERROR: Record<string, { error: ErrorKind; message: string }> = {
  note_required: { error: "invalid_input", message: "Cần ghi chú lý do / sự đồng ý (ít nhất 3 ký tự)." },
  invalid_input: { error: "invalid_input", message: "Giá trị không hợp lệ." },
  not_found: { error: "not_found", message: "Không tìm thấy hoặc bạn không có quyền." },
  invalid_action: { error: "invalid_input", message: "Thao tác không hợp lệ." },
};

export async function saveSettings(deps: ReviewDeps, actor: Actor, input: SettingsInput): Promise<Result<{ saved: true }>> {
  const scope = await scopeOf(deps, actor);
  if (!canConfigure(scope, input.connectionId)) return NOT_FOUND();
  if (input.replyMode === "auto" && !deps.config.autoReplyEnabled) return fail("conflict", "auto_disabled", "Tự động gửi đang tắt ở cấp hệ thống (PERSONAL_AUTO_REPLY_ENABLED). Chỉ có thể dùng chế độ nháp.");
  const { connectionId, ...rest } = input;
  const r = await deps.store.admin(actor.userId, "save_settings", connectionId, rest);
  if (!r.ok) {
    const e = ADMIN_ERROR[r.error] ?? { error: "server_error" as const, message: "Không lưu được cài đặt." };
    return fail(e.error, r.error, e.message);
  }
  return ok({ saved: true });
}

export async function control(deps: ReviewDeps, actor: Actor, input: ControlInput): Promise<Result<{ done: true }>> {
  const scope = await scopeOf(deps, actor);
  if (input.action === "emergency_stop") {
    if (scope.connections.size === 0) return fail("forbidden", "forbidden", "Bạn không có quyền với Zalo cá nhân.");
  } else if (input.action === "emergency_resume") {
    if (actor.role !== "admin") return fail("forbidden", "forbidden", "Chỉ quản trị viên mới được gỡ dừng khẩn cấp.");
  } else if (!canConfigure(scope, input.connectionId)) return NOT_FOUND();
  if (input.action === "allow_conversation") {
    const conv = await deps.dashboard.conversation(input.conversationId);
    if (!conv || conv.connectionId !== input.connectionId) return NOT_FOUND();
  }
  const { action, ...payload } = input;
  const connectionId = "connectionId" in input ? input.connectionId : null;
  const r = await deps.store.admin(actor.userId, action, connectionId, payload);
  if (!r.ok) {
    const e = ADMIN_ERROR[r.error] ?? { error: "server_error" as const, message: "Không thực hiện được thao tác." };
    return fail(e.error, r.error, e.message);
  }
  return ok({ done: true });
}

/** Phase 05 issuePersonalLinkCode (one-time, 10 min, only its hash is stored) — the UI that phase lacked. */
export async function createLinkCode(deps: ReviewDeps, actor: Actor): Promise<Result<{ code: string; expiresAt: string }>> {
  const r = await issuePersonalLinkCode(deps.identity, { userId: actor.userId, role: actor.role, active: true }, deps.now?.() ?? new Date());
  if (!r.ok) return fail("forbidden", "not_allowed", "Tài khoản của bạn chưa được dùng trợ lý (cần quyền Trợ lý hệ thống).");
  return ok({ code: r.code, expiresAt: r.expiresAt.toISOString() });
}

export async function revokeIdentity(deps: ReviewDeps, actor: Actor, id: string): Promise<Result<{ revoked: true }>> {
  const done = await deps.identity.revokePersonalIdentity(id, actor.userId, actor.userId);
  return done ? ok({ revoked: true }) : NOT_FOUND();
}

export { SKIP_REASON_LABEL };

export interface InboundView {
  id: string;
  conversationTitle: string;
  trigger: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

/** Router decisions (why a message was / was not answered) — reviewers only. */
export async function recentInbound(deps: ReviewDeps, actor: Actor): Promise<Result<InboundView[]>> {
  const scope = await scopeOf(deps, actor);
  const { group, direct } = listable(scope);
  if (!group.length) return ok([]);
  const rows = await deps.store.inbound(group, direct, 50);
  const TRIGGER: Record<string, string> = { direct: "Chat 1-1", mention: "@nhắc bot", command: "/bot", link: "LINK" };
  return ok(rows.map((r) => ({ id: r.id, conversationTitle: r.conversationType === "group" ? "Nhóm" : "Chat 1-1", trigger: TRIGGER[r.trigger] ?? r.trigger, status: r.status, reason: r.reason ? SKIP_REASON_LABEL[r.reason] ?? r.reason : null, createdAt: r.createdAt })));
}
