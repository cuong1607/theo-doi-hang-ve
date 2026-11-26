// ============================================================
// ZALO PERSONAL Phase 03 — dashboard service (pure + injected store).
//
// Every function: load the reader's scope from the database by user id →
// check the capability on the ROW loaded from the database (never on an id or
// role sent by the client) → query only inside the scope → return a view
// model that never carries secrets (no worker secret, no session, no token).
// Out-of-scope ids answer "not_found" (no existence leak, IDOR-safe).
// ============================================================
import type { Role } from "../../auth/permissions.ts";
import { hasPermission } from "../../auth/permissions.ts";
import {
  accessLabel,
  buildScope,
  can,
  canReadConversation,
  canUseModule,
  conversationScope,
  hasAnyAccess,
  isEmptyConversationScope,
  visibleConnectionIds,
  type AccessScope,
  type Actor,
  type ConnectionRef,
  type ConversationScope,
  type GrantLevel,
  type GrantRef,
  type GrantScope,
} from "./access.ts";
import { escapeLike, vnDayRange, vnStartOfDay } from "./contracts.ts";
import { bestHealth, classifyWorker, NO_WORKER, type SyncSignals, type WorkerHealth } from "./status.ts";

// ------------------------------------------------------------ store rows

export interface ConnectionRow {
  id: string;
  connectionKey: string;
  ownerUserId: string;
  ownerName: string | null;
  zaloAccountId: string | null;
  status: "active" | "disabled";
  directMessageMode: "off" | "metadata" | "content";
  lastHeartbeatAt: string | null;
  lastConnectedAt: string | null;
  lastErrorCategory: string | null;
}

export interface SyncRow {
  workerVersion: string | null;
  workerStartedAt: string | null;
  lastHeartbeatAt: string | null;
  sessionState: SyncSignals["sessionState"];
  listenerState: SyncSignals["listenerState"];
  lastMessageReceivedAt: string | null;
  lastDeliveryOkAt: string | null;
  lastIngestedAt: string | null;
  lastEventAt: string | null;
  outboxDepth: number | null;
  deadLetterCount: number | null;
  outboxFullDrops: number | null;
  lastErrorCategory: string | null;
}

export interface WorkerRow {
  id: string;
  workerKey: string;
  connectionId: string;
  status: "active" | "revoked";
  lastSeenAt: string | null;
  sync: SyncRow | null;
}

export interface GroupRow {
  id: string;
  connectionId: string;
  externalGroupId: string;
  displayName: string | null;
  mode: "disabled" | "monitor" | "mention_only" | "interactive";
  consentStatus: "none" | "granted" | "withdrawn";
  consentRecordedAt: string | null;
  consentNote: string | null;
  sendVerifiedAt: string | null;
  discoveredVia: "discovery_token" | "event" | "admin";
  firstSeenAt: string;
  lastSeenAt: string;
  modeChangedAt: string | null;
  conversationId: string | null;
}

export interface ConversationRow {
  id: string;
  connectionId: string;
  conversationType: "user" | "group";
  externalConversationId: string;
  groupId: string | null;
  groupName: string | null;
  groupMode: GroupRow["mode"] | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

export interface SummaryRow {
  conversationId: string;
  messageCount: number;
  lastMessageType: string | null;
  lastText: string | null;
  lastContentStored: boolean | null;
  lastIsSelf: boolean | null;
  lastSentAt: string | null;
  lastIngestedAt: string | null;
}

export interface MessageRow {
  id: string;
  externalMessageId: string;
  senderExternalId: string;
  messageType: string;
  textContent: string | null;
  contentStored: boolean;
  textLength: number;
  mentions: unknown;
  mentionsSelf: boolean;
  isSelf: boolean;
  sentAt: string | null;
  receivedAt: string;
  messageAt: string;
  processingState?: string;
  // search results only
  connectionId?: string;
  conversationId?: string;
  conversationType?: "user" | "group";
  externalConversationId?: string;
  groupName?: string | null;
}

export interface StatusEventRow {
  id: number;
  workerId: string;
  kind: "first_seen" | "state_changed" | "resumed";
  observedAt: string;
  sessionState: string;
  listenerState: string;
  lastErrorCategory: string | null;
  outboxDepth: number | null;
  deadLetterCount: number | null;
  previousHeartbeatAt: string | null;
}

export interface IngestionSummaryRow {
  outcome: string;
  reason: string | null;
  events: number;
  redeliveredEvents: number;
  extraDeliveries: number;
  lastReceivedAt: string | null;
}

export interface IngestionEventRow {
  id: string;
  kind: string;
  conversationType: string | null;
  outcome: string;
  reason: string | null;
  deliveryCount: number;
  occurredAt: string | null;
  firstReceivedAt: string;
  lastReceivedAt: string;
}

export interface GrantRow {
  id: string;
  connectionId: string;
  granteeUserId: string;
  granteeName: string | null;
  granteeRole: string | null;
  scope: GrantScope;
  conversationId: string | null;
  level: GrantLevel;
  note: string | null;
  grantedAt: string;
  grantedByName: string | null;
}

export interface AuditRow {
  id: number;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  actorName: string | null;
  createdAt: string;
}

export interface ProfileRow {
  id: string;
  name: string | null;
  role: string;
  isActive: boolean;
}

export type StoreFailure = { ok: false; error: string };

export interface ConversationFilter {
  connectionId?: string;
  type?: "user" | "group";
  groupId?: string;
  /** already LIKE-escaped */
  name?: string;
}

export interface SearchFilter {
  text?: string; // already LIKE-escaped
  conversationId?: string;
  senderId?: string;
  messageType?: string;
  from: Date;
  to: Date;
  limit: number;
}

export interface DashboardStore {
  loadAccess(userId: string): Promise<{ connections: ConnectionRef[]; grants: GrantRef[] }>;
  connections(ids: string[]): Promise<ConnectionRow[]>;
  workers(connectionIds: string[]): Promise<WorkerRow[]>;
  groupCounts(connectionIds: string[]): Promise<{ connectionId: string; total: number; monitored: number }[]>;
  groups(q: { connectionIds: string[]; mode?: GroupRow["mode"]; offset: number; limit: number }): Promise<{ rows: GroupRow[]; total: number }>;
  group(id: string): Promise<GroupRow | null>;
  updateGroup(actorId: string, connectionId: string, groupId: string, action: string, mode: string | null, note: string | null): Promise<{ ok: true; changed: boolean; group: { id: string; mode: string; consentStatus: string } } | StoreFailure>;
  conversations(scope: ConversationScope, filter: ConversationFilter, offset: number, limit: number): Promise<{ rows: ConversationRow[]; total: number }>;
  conversation(id: string): Promise<ConversationRow | null>;
  summaries(conversationIds: string[]): Promise<SummaryRow[]>;
  messages(conversationId: string, before: { at: string; id: string } | null, limit: number): Promise<MessageRow[]>;
  search(scope: ConversationScope, filter: SearchFilter): Promise<MessageRow[]>;
  counts(scope: ConversationScope, since: Date): Promise<{ conversations: number; messagesSince: number; lastMessageAt: string | null }>;
  statusEvents(connectionId: string, limit: number): Promise<StatusEventRow[]>;
  ingestionSummary(connectionId: string, since: Date): Promise<IngestionSummaryRow[]>;
  ingestionEvents(connectionId: string, offset: number, limit: number): Promise<{ rows: IngestionEventRow[]; total: number }>;
  grants(connectionId: string): Promise<GrantRow[]>;
  grant(actorId: string, connectionId: string, g: { granteeUserId: string; scope: GrantScope; conversationId: string | null; level: GrantLevel; note: string | null }): Promise<{ ok: true; changed: boolean; grantId: string } | StoreFailure>;
  revoke(actorId: string, connectionId: string, grantId: string): Promise<{ ok: true; changed: boolean } | StoreFailure>;
  audit(connectionId: string, limit: number): Promise<AuditRow[]>;
  profile(id: string): Promise<ProfileRow | null>;
  activeProfiles(): Promise<ProfileRow[]>;
}

export interface DashboardDeps {
  store: DashboardStore;
  now?: () => Date;
}

// ------------------------------------------------------------ results

export type ErrorCode = "forbidden" | "not_found" | "invalid_input" | "conflict" | "server_error";

export type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorCode; code: string; message: string };

const STATUS: Record<ErrorCode, number> = { forbidden: 403, not_found: 404, invalid_input: 400, conflict: 409, server_error: 500 };
export const httpStatusOf = (e: ErrorCode): number => STATUS[e];

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = <T>(error: ErrorCode, code: string, message: string): Result<T> => ({ ok: false, error, code, message });
const NOT_FOUND = <T>(): Result<T> => fail("not_found", "not_found", "Không tìm thấy hoặc bạn không có quyền xem.");
const FORBIDDEN = <T>(message = "Bạn không có quyền thực hiện thao tác này."): Result<T> => fail("forbidden", "forbidden", message);

/** Messages for database refusals (codes from 00074 functions). */
const STORE_ERRORS: Record<string, { error: ErrorCode; message: string }> = {
  not_found: { error: "not_found", message: "Không tìm thấy hoặc bạn không có quyền xem." },
  consent_required: { error: "conflict", message: "Nhóm chưa được ghi nhận đồng ý: không thể bật theo dõi." },
  interactive_not_available: { error: "conflict", message: "Chế độ tương tác chưa khả dụng cho nhóm này: cần ít nhất một tin trả lời được duyệt tay và gửi thành công vào nhóm (đường gửi đã xác minh)." },
  invalid_mode: { error: "invalid_input", message: "Chế độ không hợp lệ." },
  note_required: { error: "invalid_input", message: "Cần ghi chú cách nhóm đã đồng ý (3–500 ký tự)." },
  grantee_is_owner: { error: "conflict", message: "Chủ sở hữu đã có toàn quyền." },
  grantee_invalid: { error: "invalid_input", message: "Người được cấp không tồn tại hoặc đã bị khóa." },
  invalid_grant: { error: "invalid_input", message: "Quyền cấp không hợp lệ." },
  actor_required: { error: "forbidden", message: "Bạn không có quyền thực hiện thao tác này." },
};
const fromStore = <T>(code: string): Result<T> => {
  const m = STORE_ERRORS[code] ?? { error: "server_error" as ErrorCode, message: "Không thể thực hiện thao tác. Vui lòng thử lại." };
  return fail(m.error, code, m.message);
};

// ------------------------------------------------------------ helpers

export function maskId(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length <= 4 ? "…" + id : `…${id.slice(-4)}`;
}

export const MESSAGE_TYPE_LABEL: Record<string, string> = {
  text: "Văn bản",
  image: "Hình ảnh",
  sticker: "Sticker",
  video: "Video",
  voice: "Tin thoại",
  file: "Tệp",
  link: "Liên kết",
  location: "Vị trí",
  other: "Loại khác",
};

export const GROUP_MODE_LABEL: Record<GroupRow["mode"], string> = {
  disabled: "Tắt",
  monitor: "Theo dõi",
  mention_only: "Chỉ khi được nhắc",
  interactive: "Tương tác",
};

export const CONSENT_LABEL: Record<GroupRow["consentStatus"], string> = { none: "Chưa ghi nhận", granted: "Đã đồng ý", withdrawn: "Đã rút lại" };

export function conversationTitle(c: { conversationType: "user" | "group"; externalConversationId: string; groupName?: string | null }): string {
  if (c.conversationType === "group") return c.groupName?.trim() || `Nhóm ${maskId(c.externalConversationId)}`;
  return `Chat 1-1 ${maskId(c.externalConversationId)}`;
}

async function loadScope(deps: DashboardDeps, actor: Actor): Promise<AccessScope> {
  if (!canUseModule(actor.role)) return buildScope(actor, [], []);
  const { connections, grants } = await deps.store.loadAccess(actor.userId);
  return buildScope(actor, connections, grants);
}

export function signalsOf(w: WorkerRow): SyncSignals {
  const s = w.sync;
  return {
    workerStatus: w.status,
    lastHeartbeatAt: s?.lastHeartbeatAt ?? null,
    sessionState: s?.sessionState ?? "unknown",
    listenerState: s?.listenerState ?? "unknown",
    lastDeliveryOkAt: s?.lastDeliveryOkAt ?? null,
    outboxDepth: s?.outboxDepth ?? null,
    deadLetterCount: s?.deadLetterCount ?? null,
    outboxFullDrops: s?.outboxFullDrops ?? null,
    lastErrorCategory: s?.lastErrorCategory ?? null,
  };
}

const maxIso = (values: (string | null | undefined)[]): string | null => values.filter((v): v is string => !!v).sort().at(-1) ?? null;

// ------------------------------------------------------------ view models

export interface WorkerView {
  /** worker row id (not a secret): used by the owner to revoke it */
  id: string;
  workerKey: string;
  status: "active" | "revoked";
  version: string | null;
  startedAt: string | null;
  lastSeenAt: string | null;
  lastHeartbeatAt: string | null;
  sessionState: string;
  listenerState: string;
  lastMessageReceivedAt: string | null;
  lastDeliveryOkAt: string | null;
  lastIngestedAt: string | null;
  outboxDepth: number | null;
  deadLetterCount: number | null;
  outboxFullDrops: number | null;
  lastErrorCategory: string | null;
  health: WorkerHealth;
}

export interface ConnectionView {
  id: string;
  connectionKey: string;
  /** Phase 02 stores no account display name; shown as "—" */
  accountDisplayName: string | null;
  accountIdMasked: string | null;
  status: "active" | "disabled";
  directMessageMode: ConnectionRow["directMessageMode"] | null;
  ownerName: string | null;
  isOwner: boolean;
  accessLabel: string;
  lastHeartbeatAt: string | null;
  lastConnectedAt: string | null;
  lastIngestedAt: string | null;
  lastErrorCategory: string | null;
  health: WorkerHealth;
  workers: WorkerView[];
  capabilities: { viewSync: boolean; viewGroups: boolean; manageGroups: boolean; manageAccess: boolean; viewAudit: boolean };
}

function connectionView(scope: AccessScope, c: ConnectionRow, workers: WorkerRow[], now: Date): ConnectionView {
  const ws: WorkerView[] = workers.map((w) => ({
    id: w.id,
    workerKey: w.workerKey,
    status: w.status,
    version: w.sync?.workerVersion ?? null,
    startedAt: w.sync?.workerStartedAt ?? null,
    lastSeenAt: w.lastSeenAt,
    lastHeartbeatAt: w.sync?.lastHeartbeatAt ?? null,
    sessionState: w.sync?.sessionState ?? "unknown",
    listenerState: w.sync?.listenerState ?? "unknown",
    lastMessageReceivedAt: w.sync?.lastMessageReceivedAt ?? null,
    lastDeliveryOkAt: w.sync?.lastDeliveryOkAt ?? null,
    lastIngestedAt: w.sync?.lastIngestedAt ?? null,
    outboxDepth: w.sync?.outboxDepth ?? null,
    deadLetterCount: w.sync?.deadLetterCount ?? null,
    outboxFullDrops: w.sync?.outboxFullDrops ?? null,
    lastErrorCategory: w.sync?.lastErrorCategory ?? null,
    health: classifyWorker(signalsOf(w), c, now),
  }));
  const active = ws.filter((w) => w.status === "active");
  const health = c.status !== "active" ? classifyWorker(signalsOf({ id: "", workerKey: "", connectionId: c.id, status: "active", lastSeenAt: null, sync: null }), c, now) : (bestHealth(active.map((w) => w.health)) ?? (ws.length ? ws[0]!.health : NO_WORKER));
  const isOwner = scope.connections.get(c.id)?.owner ?? false;
  return {
    id: c.id,
    connectionKey: c.connectionKey,
    accountDisplayName: null,
    accountIdMasked: maskId(c.zaloAccountId),
    status: c.status,
    directMessageMode: isOwner ? c.directMessageMode : null,
    ownerName: c.ownerName,
    isOwner,
    accessLabel: accessLabel(scope.connections.get(c.id)),
    lastHeartbeatAt: c.lastHeartbeatAt,
    lastConnectedAt: c.lastConnectedAt,
    lastIngestedAt: maxIso(ws.map((w) => w.lastIngestedAt)),
    lastErrorCategory: c.lastErrorCategory,
    health,
    workers: ws,
    capabilities: {
      viewSync: can(scope, c.id, "view_sync"),
      viewGroups: can(scope, c.id, "view_groups"),
      manageGroups: can(scope, c.id, "manage_groups"),
      manageAccess: can(scope, c.id, "manage_access"),
      viewAudit: can(scope, c.id, "view_audit"),
    },
  };
}

export interface MentionView {
  uidMasked: string | null;
  kind: "user" | "all";
}

export interface MessageView {
  id: string;
  senderId: string;
  senderLabel: string;
  isSelf: boolean;
  type: string;
  typeLabel: string;
  supported: boolean;
  /** plain text (rendered as text, never HTML); null when not stored */
  text: string | null;
  contentState: "stored" | "not_stored" | "no_text";
  textLength: number;
  mentions: MentionView[];
  mentionsSelf: boolean;
  at: string;
  sentAt: string | null;
  receivedAt: string;
  processingState: string | null;
  conversation?: { id: string; title: string; type: "user" | "group"; connectionId: string };
}

function mentionsOf(raw: unknown): MentionView[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map((m) => {
    const o = (m && typeof m === "object" ? m : {}) as { uid?: unknown; kind?: unknown };
    return { uidMasked: typeof o.uid === "string" ? maskId(o.uid) : null, kind: o.kind === "all" ? "all" : "user" };
  });
}

function messageView(m: MessageRow): MessageView {
  const supported = m.messageType in MESSAGE_TYPE_LABEL && m.messageType !== "other";
  const contentState: MessageView["contentState"] = m.contentStored ? (m.textContent ? "stored" : "no_text") : m.textLength > 0 ? "not_stored" : "no_text";
  const view: MessageView = {
    id: m.id,
    senderId: m.senderExternalId,
    senderLabel: m.isSelf ? "Bạn (tài khoản đang kết nối)" : `Người gửi ${maskId(m.senderExternalId)}`,
    isSelf: m.isSelf,
    type: m.messageType,
    typeLabel: MESSAGE_TYPE_LABEL[m.messageType] ?? "Loại chưa hỗ trợ",
    supported,
    text: m.contentStored ? m.textContent : null,
    contentState,
    textLength: m.textLength,
    mentions: mentionsOf(m.mentions),
    mentionsSelf: m.mentionsSelf,
    at: m.messageAt,
    sentAt: m.sentAt,
    receivedAt: m.receivedAt,
    processingState: m.processingState ?? null,
  };
  if (m.conversationId && m.conversationType && m.externalConversationId && m.connectionId) {
    view.conversation = { id: m.conversationId, type: m.conversationType, connectionId: m.connectionId, title: conversationTitle({ conversationType: m.conversationType, externalConversationId: m.externalConversationId, groupName: m.groupName }) };
  }
  return view;
}

// ------------------------------------------------------------ module gate

export interface ModuleAccess {
  allowed: boolean;
  reason: "ok" | "role" | "no_grant";
}

/** Role permission AND (owns a connection OR holds a grant). */
export async function moduleAccess(deps: DashboardDeps, actor: Actor): Promise<ModuleAccess> {
  if (!canUseModule(actor.role)) return { allowed: false, reason: "role" };
  const scope = await loadScope(deps, actor);
  return hasAnyAccess(scope) ? { allowed: true, reason: "ok" } : { allowed: false, reason: "no_grant" };
}

// ------------------------------------------------------------ overview

export interface Overview {
  connections: number;
  connectionStates: { id: string; connectionKey: string; health: WorkerHealth }[];
  groupsTotal: number | null;
  groupsMonitored: number | null;
  conversations: number;
  messagesToday: number;
  lastHeartbeatAt: string | null;
  lastMessageAt: string | null;
  unresolvedErrors: number | null;
  canViewGroups: boolean;
}

export async function getOverview(deps: DashboardDeps, actor: Actor): Promise<Result<Overview>> {
  const now = (deps.now ?? (() => new Date()))();
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  const connIds = visibleConnectionIds(scope);
  const groupConnIds = visibleConnectionIds(scope, "view_groups");
  const syncConnIds = visibleConnectionIds(scope, "view_sync");
  const cs = conversationScope(scope);
  const [conns, workers, groupCounts, counts] = await Promise.all([
    connIds.length ? deps.store.connections(connIds) : Promise.resolve([]),
    connIds.length ? deps.store.workers(connIds) : Promise.resolve([]),
    groupConnIds.length ? deps.store.groupCounts(groupConnIds) : Promise.resolve([]),
    isEmptyConversationScope(cs) ? Promise.resolve({ conversations: 0, messagesSince: 0, lastMessageAt: null }) : deps.store.counts(cs, vnStartOfDay(now)),
  ]);
  const views = conns.map((c) => connectionView(scope, c, workers.filter((w) => w.connectionId === c.id), now));
  const syncWorkers = workers.filter((w) => syncConnIds.includes(w.connectionId) && w.status === "active");
  return ok({
    connections: conns.length,
    connectionStates: views.map((v) => ({ id: v.id, connectionKey: v.connectionKey, health: v.health })),
    groupsTotal: groupConnIds.length ? groupCounts.reduce((a, g) => a + g.total, 0) : null,
    groupsMonitored: groupConnIds.length ? groupCounts.reduce((a, g) => a + g.monitored, 0) : null,
    conversations: counts.conversations,
    messagesToday: counts.messagesSince,
    lastHeartbeatAt: maxIso(conns.map((c) => c.lastHeartbeatAt)),
    lastMessageAt: counts.lastMessageAt,
    unresolvedErrors: syncConnIds.length ? syncWorkers.reduce((a, w) => a + (w.sync?.deadLetterCount ?? 0) + (w.sync?.outboxFullDrops ?? 0), 0) : null,
    canViewGroups: groupConnIds.length > 0,
  });
}

// ------------------------------------------------------------ connections

export async function listConnections(deps: DashboardDeps, actor: Actor): Promise<Result<ConnectionView[]>> {
  const now = (deps.now ?? (() => new Date()))();
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  const ids = visibleConnectionIds(scope);
  if (!ids.length) return ok([]);
  const [conns, workers] = await Promise.all([deps.store.connections(ids), deps.store.workers(ids)]);
  return ok(conns.map((c) => connectionView(scope, c, workers.filter((w) => w.connectionId === c.id), now)));
}

// ------------------------------------------------------------ groups

export interface GroupView {
  id: string;
  connectionId: string;
  connectionKey: string;
  name: string;
  externalIdMasked: string | null;
  mode: GroupRow["mode"];
  modeLabel: string;
  consentStatus: GroupRow["consentStatus"];
  consentLabel: string;
  consentRecordedAt: string | null;
  consentNote: string | null;
  discoveredVia: GroupRow["discoveredVia"];
  firstSeenAt: string;
  lastSeenAt: string;
  modeChangedAt: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  conversationId: string | null;
  canManage: boolean;
  interactiveAvailable: boolean;
}

export async function listGroups(deps: DashboardDeps, actor: Actor, q: { connectionId?: string; mode?: GroupRow["mode"]; page: number; size: number }): Promise<Result<{ rows: GroupView[]; total: number; page: number; size: number }>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  let ids = visibleConnectionIds(scope, "view_groups");
  if (q.connectionId) ids = ids.filter((id) => id === q.connectionId);
  if (!ids.length) return ok({ rows: [], total: 0, page: q.page, size: q.size });
  const [{ rows, total }, conns] = await Promise.all([deps.store.groups({ connectionIds: ids, mode: q.mode, offset: (q.page - 1) * q.size, limit: q.size }), deps.store.connections(ids)]);
  const convIds = rows.map((g) => g.conversationId).filter((v): v is string => !!v);
  const summaries = convIds.length ? await deps.store.summaries(convIds) : [];
  const keyOf = new Map(conns.map((c) => [c.id, c.connectionKey]));
  return ok({
    rows: rows.map((g) => {
      const s = summaries.find((x) => x.conversationId === g.conversationId);
      const manage = can(scope, g.connectionId, "manage_groups");
      return {
        id: g.id,
        connectionId: g.connectionId,
        connectionKey: keyOf.get(g.connectionId) ?? "",
        name: g.displayName?.trim() || `Nhóm ${maskId(g.externalGroupId)}`,
        externalIdMasked: maskId(g.externalGroupId),
        mode: g.mode,
        modeLabel: GROUP_MODE_LABEL[g.mode],
        consentStatus: g.consentStatus,
        consentLabel: CONSENT_LABEL[g.consentStatus],
        consentRecordedAt: g.consentRecordedAt,
        consentNote: manage ? g.consentNote : null,
        discoveredVia: g.discoveredVia,
        firstSeenAt: g.firstSeenAt,
        lastSeenAt: g.lastSeenAt,
        modeChangedAt: g.modeChangedAt,
        messageCount: s?.messageCount ?? 0,
        lastMessageAt: s?.lastSentAt ?? s?.lastIngestedAt ?? null,
        conversationId: g.conversationId,
        canManage: manage,
        interactiveAvailable: g.sendVerifiedAt !== null,
      };
    }),
    total,
    page: q.page,
    size: q.size,
  });
}

export type GroupChange = { action: "set_mode"; mode: GroupRow["mode"] } | { action: "grant_consent"; note: string; confirm: true } | { action: "withdraw_consent"; note?: string };

export async function updateGroup(deps: DashboardDeps, actor: Actor, groupId: string, change: GroupChange): Promise<Result<{ changed: boolean; mode: string; consentStatus: string }>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  const group = await deps.store.group(groupId);
  // existence is only revealed to readers of that connection's groups
  if (!group || !can(scope, group.connectionId, "view_groups")) return NOT_FOUND();
  if (!can(scope, group.connectionId, "manage_groups")) return FORBIDDEN("Bạn chỉ có quyền xem nhóm, không được đổi chế độ.");
  // checked here for a clear message; the database refuses it too
  if (change.action === "set_mode" && change.mode === "interactive" && group.sendVerifiedAt === null) return fromStore("interactive_not_available");
  if (change.action === "set_mode" && change.mode !== "disabled" && group.consentStatus !== "granted") return fromStore("consent_required");
  const res = await deps.store.updateGroup(actor.userId, group.connectionId, group.id, change.action, change.action === "set_mode" ? change.mode : null, change.action === "set_mode" ? null : (change.note ?? null));
  if (!res.ok) return fromStore(res.error);
  return ok({ changed: res.changed, mode: res.group.mode, consentStatus: res.group.consentStatus });
}

// ------------------------------------------------------------ conversations

export interface ConversationView {
  id: string;
  connectionId: string;
  connectionKey: string;
  type: "user" | "group";
  title: string;
  externalIdMasked: string | null;
  groupMode: GroupRow["mode"] | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  last: { type: string; typeLabel: string; preview: string | null; isSelf: boolean; at: string | null } | null;
}

function conversationView(c: ConversationRow, s: SummaryRow | undefined, connectionKey: string): ConversationView {
  return {
    id: c.id,
    connectionId: c.connectionId,
    connectionKey,
    type: c.conversationType,
    title: conversationTitle(c),
    externalIdMasked: maskId(c.externalConversationId),
    groupMode: c.groupMode,
    firstMessageAt: c.firstMessageAt,
    lastMessageAt: c.lastMessageAt,
    messageCount: s?.messageCount ?? 0,
    last: s?.lastMessageType
      ? { type: s.lastMessageType, typeLabel: MESSAGE_TYPE_LABEL[s.lastMessageType] ?? "Loại chưa hỗ trợ", preview: s.lastContentStored ? s.lastText : null, isSelf: !!s.lastIsSelf, at: s.lastSentAt ?? s.lastIngestedAt }
      : null,
  };
}

export async function listConversations(deps: DashboardDeps, actor: Actor, q: { connectionId?: string; type?: "user" | "group"; groupId?: string; name?: string; page: number; size: number }): Promise<Result<{ rows: ConversationView[]; total: number; page: number; size: number }>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  const cs = conversationScope(scope, q.connectionId);
  if (isEmptyConversationScope(cs)) return ok({ rows: [], total: 0, page: q.page, size: q.size });
  const filter: ConversationFilter = { connectionId: q.connectionId, type: q.type, groupId: q.groupId, name: q.name ? escapeLike(q.name) : undefined };
  let { rows, total } = await deps.store.conversations(cs, filter, (q.page - 1) * q.size, q.size);
  if (!rows.length && q.page > 1) total = (await deps.store.conversations(cs, filter, 0, 1)).total;
  // defence in depth: the SQL already filtered; re-check every row
  rows = rows.filter((r) => canReadConversation(scope, r));
  const [summaries, conns] = await Promise.all([rows.length ? deps.store.summaries(rows.map((r) => r.id)) : Promise.resolve([]), deps.store.connections([...new Set(rows.map((r) => r.connectionId))])]);
  const keyOf = new Map(conns.map((c) => [c.id, c.connectionKey]));
  return ok({ rows: rows.map((r) => conversationView(r, summaries.find((s) => s.conversationId === r.id), keyOf.get(r.connectionId) ?? "")), total, page: q.page, size: q.size });
}

export async function getConversation(deps: DashboardDeps, actor: Actor, id: string): Promise<Result<ConversationView>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  const c = await deps.store.conversation(id);
  if (!c || !canReadConversation(scope, c)) return NOT_FOUND();
  const [summaries, conns] = await Promise.all([deps.store.summaries([c.id]), deps.store.connections([c.connectionId])]);
  return ok(conversationView(c, summaries[0], conns[0]?.connectionKey ?? ""));
}

export async function listMessages(deps: DashboardDeps, actor: Actor, conversationId: string, q: { beforeAt?: string; beforeId?: string; limit: number }): Promise<Result<{ rows: MessageView[]; nextCursor: { beforeAt: string; beforeId: string } | null }>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  const c = await deps.store.conversation(conversationId);
  if (!c || !canReadConversation(scope, c)) return NOT_FOUND();
  // one extra row tells whether there is more — never loads the whole history
  const rows = await deps.store.messages(c.id, q.beforeAt && q.beforeId ? { at: q.beforeAt, id: q.beforeId } : null, q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return ok({ rows: page.map(messageView), nextCursor: rows.length > q.limit && last ? { beforeAt: last.messageAt, beforeId: last.id } : null });
}

// ------------------------------------------------------------ search

export async function searchMessages(deps: DashboardDeps, actor: Actor, q: { text?: string; conversationId?: string; senderId?: string; messageType?: string; from: string; to: string; limit: number }): Promise<Result<{ rows: MessageView[]; limit: number; truncated: boolean }>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  let cs = conversationScope(scope);
  if (q.conversationId) {
    const c = await deps.store.conversation(q.conversationId);
    if (!c || !canReadConversation(scope, c)) return NOT_FOUND();
    cs = { full: [], group: [], ids: [c.id] };
  }
  if (isEmptyConversationScope(cs)) return ok({ rows: [], limit: q.limit, truncated: false });
  const { start, end } = vnDayRange(q.from, q.to);
  const rows = await deps.store.search(cs, { text: q.text ? escapeLike(q.text) : undefined, conversationId: q.conversationId, senderId: q.senderId, messageType: q.messageType, from: start, to: end, limit: q.limit + 1 });
  const visible = rows.filter((r) => r.conversationId && r.connectionId && r.conversationType && canReadConversation(scope, { id: r.conversationId, connectionId: r.connectionId, conversationType: r.conversationType }));
  return ok({ rows: visible.slice(0, q.limit).map(messageView), limit: q.limit, truncated: visible.length > q.limit });
}

// ------------------------------------------------------------ sync monitoring

export interface SyncView {
  connection: ConnectionView;
  statusEvents: StatusEventRow[];
  summary24h: IngestionSummaryRow[];
  summary7d: IngestionSummaryRow[];
  events: { rows: IngestionEventRow[]; total: number; page: number; size: number };
}

export async function getSync(deps: DashboardDeps, actor: Actor, connectionId: string, q: { page: number; size: number }): Promise<Result<SyncView>> {
  const now = (deps.now ?? (() => new Date()))();
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  if (!can(scope, connectionId, "view_sync")) return NOT_FOUND();
  const [conns, workers, statusEvents, summary24h, summary7d, events] = await Promise.all([
    deps.store.connections([connectionId]),
    deps.store.workers([connectionId]),
    deps.store.statusEvents(connectionId, 50),
    deps.store.ingestionSummary(connectionId, new Date(now.getTime() - 86_400_000)),
    deps.store.ingestionSummary(connectionId, new Date(now.getTime() - 7 * 86_400_000)),
    deps.store.ingestionEvents(connectionId, (q.page - 1) * q.size, q.size),
  ]);
  const c = conns[0];
  if (!c) return NOT_FOUND();
  return ok({ connection: connectionView(scope, c, workers, now), statusEvents, summary24h, summary7d, events: { ...events, page: q.page, size: q.size } });
}

// ------------------------------------------------------------ access management (owner only) + audit

export interface GrantView extends GrantRow {
  conversationTitle: string | null;
}

export async function listGrants(deps: DashboardDeps, actor: Actor, connectionId: string): Promise<Result<{ grants: GrantView[]; candidates: { id: string; name: string; role: string }[]; conversations: { id: string; title: string }[] }>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  if (!scope.connections.has(connectionId)) return NOT_FOUND();
  if (!can(scope, connectionId, "manage_access")) return FORBIDDEN("Chỉ chủ sở hữu kết nối mới quản lý quyền truy cập.");
  const [grants, profiles, convs] = await Promise.all([
    deps.store.grants(connectionId),
    deps.store.activeProfiles(),
    deps.store.conversations({ full: [connectionId], group: [], ids: [] }, { connectionId }, 0, 100),
  ]);
  const titleOf = new Map(convs.rows.map((c) => [c.id, conversationTitle(c)]));
  return ok({
    grants: grants.map((g) => ({ ...g, conversationTitle: g.conversationId ? (titleOf.get(g.conversationId) ?? "Hội thoại") : null })),
    candidates: profiles.filter((p) => p.id !== actor.userId && p.isActive && hasPermission(p.role as Role, "zalo_personal:use")).map((p) => ({ id: p.id, name: p.name ?? "Người dùng", role: p.role })),
    conversations: convs.rows.map((c) => ({ id: c.id, title: conversationTitle(c) })),
  });
}

export async function grantAccess(deps: DashboardDeps, actor: Actor, connectionId: string, g: { granteeUserId: string; scope: GrantScope; conversationId?: string; level: GrantLevel; note?: string }): Promise<Result<{ changed: boolean; grantId: string }>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  if (!scope.connections.has(connectionId)) return NOT_FOUND();
  if (!can(scope, connectionId, "manage_access")) return FORBIDDEN("Chỉ chủ sở hữu kết nối mới quản lý quyền truy cập.");
  const grantee = await deps.store.profile(g.granteeUserId);
  if (!grantee || !grantee.isActive) return fromStore("grantee_invalid");
  // the grantee's role comes from the database, not from the request
  if (!hasPermission(grantee.role as Role, "zalo_personal:use")) return fail("conflict", "grantee_role_not_allowed", "Vai trò của người này không được dùng Zalo cá nhân (chỉ Quản trị và Nhân viên).");
  if (g.scope === "conversation") {
    const c = g.conversationId ? await deps.store.conversation(g.conversationId) : null;
    if (!c || c.connectionId !== connectionId) return NOT_FOUND();
  }
  const res = await deps.store.grant(actor.userId, connectionId, { granteeUserId: g.granteeUserId, scope: g.scope, conversationId: g.conversationId ?? null, level: g.level, note: g.note ?? null });
  if (!res.ok) return fromStore(res.error);
  return ok({ changed: res.changed, grantId: res.grantId });
}

export async function revokeAccess(deps: DashboardDeps, actor: Actor, connectionId: string, grantId: string): Promise<Result<{ changed: boolean }>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  if (!scope.connections.has(connectionId)) return NOT_FOUND();
  if (!can(scope, connectionId, "manage_access")) return FORBIDDEN("Chỉ chủ sở hữu kết nối mới quản lý quyền truy cập.");
  const res = await deps.store.revoke(actor.userId, connectionId, grantId);
  if (!res.ok) return fromStore(res.error);
  return ok({ changed: res.changed });
}

export const AUDIT_LABEL: Record<string, string> = {
  "group.mode_changed": "Đổi chế độ nhóm",
  "group.consent_granted": "Ghi nhận đồng ý của nhóm",
  "group.consent_withdrawn": "Rút lại đồng ý (nhóm về Tắt)",
  "access.granted": "Cấp quyền truy cập",
  "access.revoked": "Thu hồi quyền truy cập",
  "connection.created": "Tạo kết nối",
  "connection.paused": "Tạm dừng kết nối",
  "connection.resumed": "Bật lại kết nối",
  "worker.issued": "Cấp worker",
  "worker.revoked": "Thu hồi worker",
};

export async function listAudit(deps: DashboardDeps, actor: Actor, connectionId: string): Promise<Result<AuditRow[]>> {
  const scope = await loadScope(deps, actor);
  if (!hasAnyAccess(scope)) return FORBIDDEN("Bạn chưa được cấp quyền xem Zalo cá nhân.");
  if (!can(scope, connectionId, "view_audit")) return NOT_FOUND();
  return ok(await deps.store.audit(connectionId, 50));
}
