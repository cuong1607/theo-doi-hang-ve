// ============================================================
// ZALO PERSONAL Phase 03 — dashboard unit tests (pure; in-memory store).
//   node --test src/lib/zalo-personal/dashboard/dashboard.test.ts
// Scope / capabilities, IDOR, admin-without-grant, worker health states, input
// validation, group mode rules + audit, pagination, search scope, no secret in
// view models, untrusted text kept as text, static guards on the UI files.
// ============================================================
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { buildScope, can, canReadConversation, conversationScope, type ConnectionRef, type ConversationScope, type GrantRef } from "./access.ts";
import { escapeLike, grantBody, listConversationsQuery, listGroupsQuery, listMessagesQuery, searchBody, updateGroupBody, vnDayRange, vnStartOfDay } from "./contracts.ts";
import {
  getConversation,
  getOverview,
  getSync,
  grantAccess,
  listConnections,
  listConversations,
  listGrants,
  listGroups,
  listMessages,
  moduleAccess,
  revokeAccess,
  searchMessages,
  updateGroup,
  type AuditRow,
  type ConnectionRow,
  type ConversationFilter,
  type ConversationRow,
  type DashboardDeps,
  type DashboardStore,
  type GrantRow,
  type GroupRow,
  type MessageRow,
  type ProfileRow,
  type SearchFilter,
  type WorkerRow,
} from "./service.ts";
import { classifyWorker, type SyncSignals } from "./status.ts";

// ------------------------------------------------------------ fixture

const U = {
  owner: "00000000-0000-4000-8000-000000000001",
  staff: "00000000-0000-4000-8000-000000000002",
  admin: "00000000-0000-4000-8000-000000000003",
  viewer: "00000000-0000-4000-8000-000000000004",
  owner2: "00000000-0000-4000-8000-000000000005",
};
const C1 = "10000000-0000-4000-8000-000000000001";
const C2 = "10000000-0000-4000-8000-000000000002";
const G1 = "20000000-0000-4000-8000-000000000001"; // consent granted, monitor
const G2 = "20000000-0000-4000-8000-000000000002"; // disabled, no consent
const G3 = "20000000-0000-4000-8000-000000000003"; // on connection 2
const CV_G1 = "30000000-0000-4000-8000-000000000001";
const CV_DM = "30000000-0000-4000-8000-000000000002";
const CV_G3 = "30000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-11-24T05:00:00Z"); // 12:00 Asia/Ho_Chi_Minh
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

const XSS = `<script>alert("x")</script><img src=x onerror=alert(1)> **bold** https://evil.example/a.png`;

class MemoryStore implements DashboardStore {
  connectionsRows: ConnectionRow[] = [
    { id: C1, connectionKey: "primary", ownerUserId: U.owner, ownerName: "Chủ 1", zaloAccountId: "8000000000000008623", status: "active", directMessageMode: "metadata", lastHeartbeatAt: ago(MIN), lastConnectedAt: ago(MIN), lastErrorCategory: null },
    { id: C2, connectionKey: "second", ownerUserId: U.owner2, ownerName: "Chủ 2", zaloAccountId: "8000000000000009999", status: "active", directMessageMode: "content", lastHeartbeatAt: ago(MIN), lastConnectedAt: ago(MIN), lastErrorCategory: null },
  ];
  workerRows: WorkerRow[] = [
    { id: "w1", workerKey: "win-01", connectionId: C1, status: "active", lastSeenAt: ago(MIN), sync: { workerVersion: "0.2.0", workerStartedAt: ago(60 * MIN), lastHeartbeatAt: ago(MIN), sessionState: "authenticated", listenerState: "active", lastMessageReceivedAt: ago(2 * MIN), lastDeliveryOkAt: ago(MIN), lastIngestedAt: ago(2 * MIN), lastEventAt: ago(2 * MIN), outboxDepth: 0, deadLetterCount: 1, outboxFullDrops: 0, lastErrorCategory: null } },
    { id: "w2", workerKey: "win-02", connectionId: C2, status: "active", lastSeenAt: null, sync: null },
  ];
  groupRows: GroupRow[] = [
    { id: G1, connectionId: C1, externalGroupId: "2547837462290891500", displayName: "Nhóm kho", mode: "monitor", consentStatus: "granted", consentRecordedAt: ago(MIN), consentNote: "đã hỏi", sendVerifiedAt: null, discoveredVia: "discovery_token", firstSeenAt: ago(9 * MIN), lastSeenAt: ago(MIN), modeChangedAt: ago(MIN), conversationId: CV_G1 },
    { id: G2, connectionId: C1, externalGroupId: "2547837462290891501", displayName: null, mode: "disabled", consentStatus: "none", consentRecordedAt: null, consentNote: null, sendVerifiedAt: null, discoveredVia: "event", firstSeenAt: ago(9 * MIN), lastSeenAt: ago(MIN), modeChangedAt: null, conversationId: null },
    { id: G3, connectionId: C2, externalGroupId: "2547837462290891502", displayName: "Nhóm khác", mode: "monitor", consentStatus: "granted", consentRecordedAt: ago(MIN), consentNote: "x", sendVerifiedAt: null, discoveredVia: "event", firstSeenAt: ago(9 * MIN), lastSeenAt: ago(MIN), modeChangedAt: null, conversationId: CV_G3 },
  ];
  conversationRows: ConversationRow[] = [
    { id: CV_G1, connectionId: C1, conversationType: "group", externalConversationId: "2547837462290891500", groupId: G1, groupName: "Nhóm kho", groupMode: "monitor", firstMessageAt: ago(30 * MIN), lastMessageAt: ago(2 * MIN) },
    { id: CV_DM, connectionId: C1, conversationType: "user", externalConversationId: "3000000000000000001", groupId: null, groupName: null, groupMode: null, firstMessageAt: ago(20 * MIN), lastMessageAt: ago(5 * MIN) },
    { id: CV_G3, connectionId: C2, conversationType: "group", externalConversationId: "2547837462290891502", groupId: G3, groupName: "Nhóm khác", groupMode: "monitor", firstMessageAt: ago(20 * MIN), lastMessageAt: ago(3 * MIN) },
  ];
  messageRows: (MessageRow & { conversationId: string })[] = [];
  grantRows: (GrantRow & { revoked: boolean })[] = [];
  auditRows: (AuditRow & { connectionId: string })[] = [];
  profiles: ProfileRow[] = [
    { id: U.owner, name: "Chủ 1", role: "staff", isActive: true },
    { id: U.staff, name: "Nhân viên", role: "staff", isActive: true },
    { id: U.admin, name: "Quản trị", role: "admin", isActive: true },
    { id: U.viewer, name: "Chỉ xem", role: "viewer", isActive: true },
    { id: U.owner2, name: "Chủ 2", role: "admin", isActive: true },
  ];
  calls: string[] = [];

  constructor() {
    for (let i = 0; i < 75; i++) {
      const conv = this.conversationRows[i % 3]!;
      this.messageRows.push({
        id: `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        externalMessageId: `m${i}`,
        senderExternalId: i % 2 ? "3000000000000000001" : "8000000000000008623",
        messageType: i === 0 ? "image" : i === 1 ? "other" : "text",
        textContent: conv.conversationType === "user" ? null : i === 6 ? XSS : `tin số ${i}${i === 9 ? " 100% hàng_về" : ""}`,
        contentStored: conv.conversationType !== "user",
        textLength: 10,
        mentions: i === 3 ? [{ uid: "8000000000000008623", pos: 0, len: 3, kind: "user" }, { uid: "-1", pos: 0, len: 3, kind: "all" }] : [],
        mentionsSelf: i === 3,
        isSelf: i % 2 === 0,
        sentAt: i === 5 ? null : ago(i * MIN),
        receivedAt: ago(i * MIN),
        messageAt: ago(i * MIN),
        conversationId: conv.id,
        connectionId: conv.connectionId,
        conversationType: conv.conversationType,
        externalConversationId: conv.externalConversationId,
        groupName: conv.groupName,
      });
    }
  }

  inScope(s: ConversationScope, c: ConversationRow) {
    return s.full.includes(c.connectionId) || (c.conversationType === "group" && s.group.includes(c.connectionId)) || s.ids.includes(c.id);
  }

  async loadAccess(userId: string) {
    this.calls.push("loadAccess");
    const grants = this.grantRows.filter((g) => g.granteeUserId === userId && !g.revoked);
    const ids = new Set([...this.connectionsRows.filter((c) => c.ownerUserId === userId).map((c) => c.id), ...grants.map((g) => g.connectionId)]);
    return {
      connections: this.connectionsRows.filter((c) => ids.has(c.id)).map((c): ConnectionRef => ({ id: c.id, ownerUserId: c.ownerUserId, status: c.status })),
      grants: grants.map((g): GrantRef => ({ id: g.id, connectionId: g.connectionId, scope: g.scope, conversationId: g.conversationId, level: g.level })),
    };
  }
  async connections(ids: string[]) {
    return this.connectionsRows.filter((c) => ids.includes(c.id));
  }
  async workers(ids: string[]) {
    return this.workerRows.filter((w) => ids.includes(w.connectionId));
  }
  async groupCounts(ids: string[]) {
    return ids.map((id) => ({ connectionId: id, total: this.groupRows.filter((g) => g.connectionId === id).length, monitored: this.groupRows.filter((g) => g.connectionId === id && g.mode !== "disabled").length }));
  }
  async groups(q: { connectionIds: string[]; mode?: GroupRow["mode"]; offset: number; limit: number }) {
    this.calls.push(`groups:${q.connectionIds.join(",")}`);
    const all = this.groupRows.filter((g) => q.connectionIds.includes(g.connectionId) && (!q.mode || g.mode === q.mode));
    return { rows: all.slice(q.offset, q.offset + q.limit), total: all.length };
  }
  async group(id: string) {
    return this.groupRows.find((g) => g.id === id) ?? null;
  }
  async updateGroup(actorId: string, connectionId: string, groupId: string, action: string, mode: string | null, note: string | null) {
    this.calls.push(`updateGroup:${action}`);
    const g = this.groupRows.find((x) => x.id === groupId && x.connectionId === connectionId);
    if (!g) return { ok: false as const, error: "not_found" };
    if (action === "set_mode") {
      if (mode === "interactive" && !g.sendVerifiedAt) return { ok: false as const, error: "interactive_not_available" };
      if (mode !== "disabled" && g.consentStatus !== "granted") return { ok: false as const, error: "consent_required" };
      if (g.mode === mode) return { ok: true as const, changed: false, group: { id: g.id, mode: g.mode, consentStatus: g.consentStatus } };
      this.auditRows.push({ id: this.auditRows.length + 1, connectionId, action: "group.mode_changed", targetType: "group", targetId: g.id, details: { from: g.mode, to: mode }, actorName: actorId, createdAt: NOW.toISOString() });
      g.mode = mode as GroupRow["mode"];
    } else if (action === "grant_consent") {
      if (!note || note.length < 3) return { ok: false as const, error: "note_required" };
      g.consentStatus = "granted";
      this.auditRows.push({ id: this.auditRows.length + 1, connectionId, action: "group.consent_granted", targetType: "group", targetId: g.id, details: {}, actorName: actorId, createdAt: NOW.toISOString() });
    } else if (action === "withdraw_consent") {
      g.consentStatus = "withdrawn";
      g.mode = "disabled";
      this.auditRows.push({ id: this.auditRows.length + 1, connectionId, action: "group.consent_withdrawn", targetType: "group", targetId: g.id, details: {}, actorName: actorId, createdAt: NOW.toISOString() });
    }
    return { ok: true as const, changed: true, group: { id: g.id, mode: g.mode, consentStatus: g.consentStatus } };
  }
  async conversations(s: ConversationScope, f: ConversationFilter, offset: number, limit: number) {
    this.calls.push(`conversations:${JSON.stringify(s)}`);
    const all = this.conversationRows.filter((c) => this.inScope(s, c) && (!f.connectionId || c.connectionId === f.connectionId) && (!f.type || c.conversationType === f.type) && (!f.groupId || c.groupId === f.groupId) && (!f.name || (c.groupName ?? "").includes(f.name)));
    return { rows: all.slice(offset, offset + limit), total: all.length };
  }
  async conversation(id: string) {
    return this.conversationRows.find((c) => c.id === id) ?? null;
  }
  async summaries(ids: string[]) {
    return ids.map((id) => {
      const ms = this.messageRows.filter((m) => m.conversationId === id);
      const last = ms[0];
      return { conversationId: id, messageCount: ms.length, lastMessageType: last?.messageType ?? null, lastText: last?.textContent ?? null, lastContentStored: last?.contentStored ?? null, lastIsSelf: last?.isSelf ?? null, lastSentAt: last?.sentAt ?? null, lastIngestedAt: last?.receivedAt ?? null };
    });
  }
  async messages(conversationId: string, before: { at: string; id: string } | null, limit: number) {
    const all = this.messageRows.filter((m) => m.conversationId === conversationId).sort((a, b) => (a.messageAt === b.messageAt ? b.id.localeCompare(a.id) : b.messageAt.localeCompare(a.messageAt)));
    const from = before ? all.findIndex((m) => m.messageAt < before.at || (m.messageAt === before.at && m.id < before.id)) : 0;
    return from < 0 ? [] : all.slice(from, from + limit);
  }
  lastSearch: SearchFilter | null = null;
  async search(s: ConversationScope, f: SearchFilter) {
    this.lastSearch = f;
    const convs = new Set(this.conversationRows.filter((c) => this.inScope(s, c)).map((c) => c.id));
    const unescape = (t: string) => t.replace(/\\([\\%_])/g, "$1");
    return this.messageRows.filter((m) => convs.has(m.conversationId) && (!f.text || (m.contentStored && (m.textContent ?? "").includes(unescape(f.text)))) && (!f.senderId || m.senderExternalId === f.senderId)).slice(0, f.limit);
  }
  async counts(s: ConversationScope) {
    const convs = this.conversationRows.filter((c) => this.inScope(s, c));
    return { conversations: convs.length, messagesSince: this.messageRows.filter((m) => convs.some((c) => c.id === m.conversationId)).length, lastMessageAt: convs.map((c) => c.lastMessageAt ?? "").sort().at(-1) ?? null };
  }
  async statusEvents() {
    return [];
  }
  async ingestionSummary() {
    return [{ outcome: "stored", reason: null, events: 3, redeliveredEvents: 1, extraDeliveries: 2, lastReceivedAt: ago(MIN) }];
  }
  async ingestionEvents() {
    return { rows: [], total: 0 };
  }
  async grants(connectionId: string) {
    return this.grantRows.filter((g) => g.connectionId === connectionId && !g.revoked);
  }
  async grant(actorId: string, connectionId: string, g: { granteeUserId: string; scope: GrantRow["scope"]; conversationId: string | null; level: GrantRow["level"]; note: string | null }) {
    const id = `50000000-0000-4000-8000-${String(this.grantRows.length + 1).padStart(12, "0")}`;
    this.grantRows.push({ id, connectionId, granteeUserId: g.granteeUserId, granteeName: null, granteeRole: null, scope: g.scope, conversationId: g.conversationId, level: g.level, note: g.note, grantedAt: NOW.toISOString(), grantedByName: actorId, revoked: false });
    this.auditRows.push({ id: this.auditRows.length + 1, connectionId, action: "access.granted", targetType: "grant", targetId: id, details: {}, actorName: actorId, createdAt: NOW.toISOString() });
    return { ok: true as const, changed: true, grantId: id };
  }
  async revoke(actorId: string, connectionId: string, grantId: string) {
    const g = this.grantRows.find((x) => x.id === grantId && x.connectionId === connectionId);
    if (!g) return { ok: false as const, error: "not_found" };
    g.revoked = true;
    this.auditRows.push({ id: this.auditRows.length + 1, connectionId, action: "access.revoked", targetType: "grant", targetId: grantId, details: {}, actorName: actorId, createdAt: NOW.toISOString() });
    return { ok: true as const, changed: true };
  }
  async audit(connectionId: string) {
    return this.auditRows.filter((a) => a.connectionId === connectionId);
  }
  async profile(id: string) {
    return this.profiles.find((p) => p.id === id) ?? null;
  }
  async activeProfiles() {
    return this.profiles.filter((p) => p.isActive);
  }
}

function setup() {
  const store = new MemoryStore();
  const deps: DashboardDeps = { store, now: () => NOW };
  return { store, deps };
}
const actor = (userId: string, role: "admin" | "staff" | "viewer" = "staff") => ({ userId, role });
const giveGrant = (store: MemoryStore, grantee: string, level: GrantRow["level"], connectionId = C1, conversationId: string | null = null) =>
  store.grantRows.push({ id: `g-${store.grantRows.length}`, connectionId, granteeUserId: grantee, granteeName: null, granteeRole: null, scope: conversationId ? "conversation" : "connection", conversationId, level, note: null, grantedAt: NOW.toISOString(), grantedByName: null, revoked: false });

// ------------------------------------------------------------ access (pure)

describe("access scope", () => {
  const conns: ConnectionRef[] = [
    { id: C1, ownerUserId: U.owner, status: "active" },
    { id: C2, ownerUserId: U.owner2, status: "disabled" },
  ];
  it("owner sees everything on their own connection, including 1-1 and grants", () => {
    const s = buildScope(actor(U.owner), conns, []);
    for (const cap of ["view_connection", "view_sync", "view_groups", "read_group_messages", "read_direct_messages", "manage_groups", "manage_access", "view_audit"] as const) assert.equal(can(s, C1, cap), true, cap);
    assert.equal(can(s, C2, "view_connection"), false, "not someone else's connection");
    assert.equal(canReadConversation(s, { id: CV_DM, connectionId: C1, conversationType: "user" }), true);
  });
  it("grant levels: sync < read < manage; 1-1 and access management never granted connection-wide", () => {
    const g = (level: GrantRef["level"]): GrantRef[] => [{ id: "x", connectionId: C1, scope: "connection", conversationId: null, level }];
    const sync = buildScope(actor(U.staff), conns, g("sync"));
    assert.deepEqual([can(sync, C1, "view_sync"), can(sync, C1, "view_groups"), can(sync, C1, "read_group_messages")], [true, false, false]);
    const read = buildScope(actor(U.staff), conns, g("read"));
    assert.deepEqual([can(read, C1, "view_groups"), can(read, C1, "read_group_messages"), can(read, C1, "manage_groups")], [true, true, false]);
    const manage = buildScope(actor(U.staff), conns, g("manage"));
    assert.deepEqual([can(manage, C1, "manage_groups"), can(manage, C1, "read_direct_messages"), can(manage, C1, "manage_access")], [true, false, false]);
    assert.equal(canReadConversation(manage, { id: CV_DM, connectionId: C1, conversationType: "user" }), false, "connection grant never covers 1-1");
    assert.equal(canReadConversation(read, { id: CV_G1, connectionId: C1, conversationType: "group" }), true);
  });
  it("conversation grant: only that conversation; no connection card", () => {
    const s = buildScope(actor(U.staff), conns, [{ id: "x", connectionId: C1, scope: "conversation", conversationId: CV_DM, level: "read" }]);
    assert.equal(canReadConversation(s, { id: CV_DM, connectionId: C1, conversationType: "user" }), true);
    assert.equal(canReadConversation(s, { id: CV_G1, connectionId: C1, conversationType: "group" }), false);
    assert.equal(can(s, C1, "view_connection"), false);
    assert.deepEqual(conversationScope(s), { full: [], group: [], ids: [CV_DM] });
  });
  it("viewer role or a disabled connection's grant gives nothing", () => {
    assert.equal(buildScope(actor(U.viewer, "viewer"), conns, [{ id: "x", connectionId: C1, scope: "connection", conversationId: null, level: "manage" }]).connections.size, 0);
    assert.equal(buildScope(actor(U.staff), conns, [{ id: "x", connectionId: C2, scope: "connection", conversationId: null, level: "read" }]).connections.size, 0);
  });
  it("highest connection grant wins", () => {
    const s = buildScope(actor(U.staff), conns, [
      { id: "a", connectionId: C1, scope: "connection", conversationId: null, level: "sync" },
      { id: "b", connectionId: C1, scope: "connection", conversationId: null, level: "manage" },
    ]);
    assert.equal(s.connections.get(C1)?.level, "manage");
  });
});

// ------------------------------------------------------------ worker health (pure)

describe("worker health", () => {
  const base: SyncSignals = { workerStatus: "active", lastHeartbeatAt: ago(MIN), sessionState: "authenticated", listenerState: "active", lastDeliveryOkAt: ago(MIN), outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastErrorCategory: null };
  const conn = { status: "active" as const, lastErrorCategory: null };
  const h = (over: Partial<SyncSignals>, c: { status: "active" | "disabled"; lastErrorCategory: string | null } = conn) => classifyWorker({ ...base, ...over }, c, NOW);
  it("connected only with every signal healthy", () => assert.deepEqual([h({}).health, h({}).situation], ["connected", "ok"]));
  it("no heartbeat ever → unknown / never_seen", () => assert.equal(h({ lastHeartbeatAt: null }).situation, "never_seen"));
  it("stale heartbeat (3–15 min) → unknown, not connected", () => assert.deepEqual([h({ lastHeartbeatAt: ago(5 * MIN) }).health, h({ lastHeartbeatAt: ago(5 * MIN) }).situation], ["unknown", "heartbeat_stale"]));
  it("worker offline (> 15 min) → disconnected even if the last report was healthy", () => assert.deepEqual([h({ lastHeartbeatAt: ago(16 * MIN) }).health, h({ lastHeartbeatAt: ago(16 * MIN) }).situation], ["disconnected", "worker_offline"]));
  it("clean stop (final heartbeat listener inactive) → disconnected / worker_stopped", () => assert.equal(h({ listenerState: "inactive" }).situation, "worker_stopped"));
  it("worker online but Zalo not logged in", () => {
    assert.deepEqual([h({ sessionState: "unauthenticated", listenerState: "error" }).health, h({ sessionState: "unauthenticated", listenerState: "error" }).situation], ["auth_required", "not_logged_in"]);
    assert.equal(h({ sessionState: "unknown", listenerState: "connecting" }).situation, "not_logged_in", "QR pending");
  });
  it("session expired / rejected", () => assert.deepEqual([h({ sessionState: "rejected", listenerState: "error" }).health, h({ sessionState: "rejected", listenerState: "error" }).situation], ["auth_required", "session_expired"]));
  it("logged in but listener not active", () => assert.deepEqual([h({ listenerState: "reconnecting" }).health, h({ listenerState: "reconnecting" }).situation], ["degraded", "listener_not_active"]));
  it("listener active but backend not receiving (error category / dead letters / stale backlog)", () => {
    assert.equal(h({ lastErrorCategory: "backend_unreachable" }).situation, "backend_not_receiving");
    assert.equal(h({ deadLetterCount: 2 }).situation, "backend_not_receiving");
    assert.equal(h({ outboxDepth: 5, lastDeliveryOkAt: ago(10 * MIN) }).situation, "backend_not_receiving");
    assert.equal(h({ outboxDepth: 5, lastDeliveryOkAt: ago(MIN) }).situation, "ok", "a small fresh backlog is normal");
  });
  it("server-side switches win: disabled connection, revoked worker, other account", () => {
    assert.equal(h({}, { status: "disabled", lastErrorCategory: null }).situation, "connection_disabled");
    assert.equal(h({ workerStatus: "revoked" }).situation, "worker_revoked");
    assert.equal(h({}, { status: "active", lastErrorCategory: "account_mismatch" }).situation, "account_mismatch");
  });
});

// ------------------------------------------------------------ input validation

describe("API input validation (zod)", () => {
  it("lists: bounded paging, uuid filters, no unknown keys", () => {
    assert.equal(listGroupsQuery.safeParse({ size: "500" }).success, false);
    assert.equal(listGroupsQuery.safeParse({ connectionId: "1 OR 1=1" }).success, false);
    assert.equal(listGroupsQuery.safeParse({ connectionId: "all" }).success, true, "'all' = no filter");
    assert.equal(listGroupsQuery.safeParse({ owner: U.owner }).success, false, "strict: no owner id from the client");
    assert.equal(listConversationsQuery.safeParse({ type: "oa" }).success, false);
    assert.equal(listConversationsQuery.safeParse({ name: "x".repeat(101) }).success, false);
    const d = listConversationsQuery.parse({});
    assert.deepEqual([d.page, d.size, d.connectionId, d.type], [1, 25, undefined, undefined]);
  });
  it("messages cursor: both parts or none; limit ≤ 100", () => {
    assert.equal(listMessagesQuery.safeParse({ beforeAt: NOW.toISOString() }).success, false);
    assert.equal(listMessagesQuery.safeParse({ limit: "101" }).success, false);
    assert.equal(listMessagesQuery.safeParse({ beforeAt: NOW.toISOString(), beforeId: CV_G1, limit: "30" }).success, true);
  });
  it("search: window ≤ 92 days, text 2–200, numeric sender, from ≤ to", () => {
    const ok = { from: "2026-11-01", to: "2026-11-24" };
    assert.equal(searchBody.safeParse(ok).success, true);
    assert.equal(searchBody.safeParse({ ...ok, from: "2026-01-01" }).success, false);
    assert.equal(searchBody.safeParse({ ...ok, from: "2026-11-25" }).success, false);
    assert.equal(searchBody.safeParse({ ...ok, text: "a" }).success, false);
    assert.equal(searchBody.safeParse({ ...ok, senderId: "abc" }).success, false);
    assert.equal(searchBody.safeParse({ ...ok, limit: 1000 }).success, false);
    assert.equal(searchBody.safeParse({ ...ok, connectionScope: "all" }).success, false);
  });
  it("group change: known actions only; consent needs a note AND an explicit confirm", () => {
    assert.equal(updateGroupBody.safeParse({ action: "set_mode", mode: "broadcast" }).success, false);
    assert.equal(updateGroupBody.safeParse({ action: "grant_consent", note: "ok ok" }).success, false);
    assert.equal(updateGroupBody.safeParse({ action: "grant_consent", note: "ok ok", confirm: true }).success, true);
    assert.equal(updateGroupBody.safeParse({ action: "delete" }).success, false);
  });
  it("grant: conversation id only with conversation scope, conversation grants read-only", () => {
    assert.equal(grantBody.safeParse({ granteeUserId: U.staff, scope: "connection", level: "read" }).success, true);
    assert.equal(grantBody.safeParse({ granteeUserId: U.staff, scope: "conversation", level: "read" }).success, false);
    assert.equal(grantBody.safeParse({ granteeUserId: U.staff, scope: "conversation", conversationId: CV_DM, level: "manage" }).success, false);
    assert.equal(grantBody.safeParse({ granteeUserId: "me", scope: "connection", level: "read" }).success, false);
  });
  it("Vietnam day boundaries and LIKE escaping", () => {
    assert.equal(vnStartOfDay(NOW).toISOString(), "2026-11-23T17:00:00.000Z");
    const r = vnDayRange("2026-11-24", "2026-11-24");
    assert.deepEqual([r.start.toISOString(), r.end.toISOString(), r.days], ["2026-11-23T17:00:00.000Z", "2026-11-24T17:00:00.000Z", 1]);
    assert.equal(escapeLike("100%_a\\b"), "100\\%\\_a\\\\b");
  });
});

// ------------------------------------------------------------ service

describe("module gate + overview", () => {
  it("no connection and no grant → module hidden, every call forbidden", async () => {
    const { deps } = setup();
    assert.deepEqual(await moduleAccess(deps, actor(U.staff)), { allowed: false, reason: "no_grant" });
    const o = await getOverview(deps, actor(U.staff));
    assert.equal(o.ok, false);
    assert.equal(!o.ok && o.error, "forbidden");
  });
  it("viewer role is refused before any database read", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.viewer, "read");
    assert.deepEqual(await moduleAccess(deps, actor(U.viewer, "viewer")), { allowed: false, reason: "role" });
    assert.equal(store.calls.length, 0);
  });
  it("owner overview: real counts, today's messages, dead letters as unresolved errors", async () => {
    const { deps } = setup();
    const o = await getOverview(deps, actor(U.owner));
    assert.ok(o.ok);
    assert.equal(o.data.connections, 1, "only the owner's own connection");
    assert.deepEqual([o.data.groupsTotal, o.data.groupsMonitored], [2, 1]);
    assert.equal(o.data.conversations, 2);
    assert.equal(o.data.messagesToday, 50);
    assert.equal(o.data.unresolvedErrors, 1);
    assert.equal(o.data.connectionStates[0]!.health.situation, "backend_not_receiving", "1 dead letter = degraded");
  });
  it("sync-only grant: groups unknown (null), messages 0, errors visible", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "sync");
    const o = await getOverview(deps, actor(U.staff));
    assert.ok(o.ok);
    assert.deepEqual([o.data.groupsTotal, o.data.conversations, o.data.messagesToday, o.data.unresolvedErrors], [null, 0, 0, 1]);
  });
});

describe("connections", () => {
  it("worker never seen → unknown; no secret / session / full account id in the view", async () => {
    const { deps } = setup();
    const r = await listConnections(deps, actor(U.owner2, "admin"));
    assert.ok(r.ok);
    assert.equal(r.data[0]!.health.situation, "never_seen");
    const json = JSON.stringify(r.data);
    assert.doesNotMatch(json, /secret|cookie|token|imei|session_encrypted|zps_/i);
    assert.doesNotMatch(json, /8000000000000009999/, "account id is masked");
    assert.match(json, /…9999/);
  });
  it("worker offline after 15 min without heartbeat", async () => {
    const { deps, store } = setup();
    store.workerRows[0]!.sync!.lastHeartbeatAt = ago(20 * MIN);
    const r = await listConnections(deps, actor(U.owner));
    assert.ok(r.ok);
    assert.deepEqual([r.data[0]!.health.health, r.data[0]!.health.situation], ["disconnected", "worker_offline"]);
  });
  it("direct-message policy only shown to the owner", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "manage");
    const r = await listConnections(deps, actor(U.staff));
    assert.ok(r.ok);
    assert.equal(r.data[0]!.directMessageMode, null);
    assert.equal(r.data[0]!.capabilities.manageAccess, false);
  });
});

describe("groups + mode changes", () => {
  it("read grant lists groups of that connection only (never another owner's)", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "read");
    const r = await listGroups(deps, actor(U.staff), { page: 1, size: 25 });
    assert.ok(r.ok);
    assert.deepEqual(r.data.rows.map((g) => g.id).sort(), [G1, G2].sort());
    assert.ok(r.data.rows.every((g) => !g.canManage && g.consentNote === null));
    const other = await listGroups(deps, actor(U.staff), { connectionId: C2, page: 1, size: 25 });
    assert.ok(other.ok && other.data.rows.length === 0, "filtering on a foreign connection returns nothing");
  });
  it("sync grant sees no groups", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "sync");
    const r = await listGroups(deps, actor(U.staff), { page: 1, size: 25 });
    assert.ok(r.ok && r.data.rows.length === 0 && r.data.total === 0);
  });
  it("owner switches modes; every change is audited; turning off is always allowed", async () => {
    const { deps, store } = setup();
    const off = await updateGroup(deps, actor(U.owner), G1, { action: "set_mode", mode: "disabled" });
    assert.ok(off.ok && off.data.changed && off.data.mode === "disabled");
    const on = await updateGroup(deps, actor(U.owner), G1, { action: "set_mode", mode: "mention_only" });
    assert.ok(on.ok && on.data.mode === "mention_only");
    assert.deepEqual(store.auditRows.map((a) => [a.action, a.details.from, a.details.to]), [["group.mode_changed", "monitor", "disabled"], ["group.mode_changed", "disabled", "mention_only"]]);
  });
  it("monitoring refused without recorded consent; allowed after consent", async () => {
    const { deps } = setup();
    const r = await updateGroup(deps, actor(U.owner), G2, { action: "set_mode", mode: "monitor" });
    assert.equal(!r.ok && r.code, "consent_required");
    const c = await updateGroup(deps, actor(U.owner), G2, { action: "grant_consent", note: "đã thông báo nhóm", confirm: true });
    assert.ok(c.ok);
    assert.ok((await updateGroup(deps, actor(U.owner), G2, { action: "set_mode", mode: "monitor" })).ok);
  });
  it("interactive cannot be turned on (no verified sending path) — not even by the owner", async () => {
    const { deps, store } = setup();
    const r = await updateGroup(deps, actor(U.owner), G1, { action: "set_mode", mode: "interactive" });
    assert.equal(!r.ok && r.code, "interactive_not_available");
    assert.equal(store.groupRows[0]!.mode, "monitor");
    assert.ok(!store.calls.includes("updateGroup:set_mode"), "refused before reaching the database");
  });
  it("withdrawing consent forces the group off", async () => {
    const { deps, store } = setup();
    const r = await updateGroup(deps, actor(U.owner), G1, { action: "withdraw_consent" });
    assert.ok(r.ok && r.data.mode === "disabled" && r.data.consentStatus === "withdrawn");
    assert.equal(store.auditRows.at(-1)!.action, "group.consent_withdrawn");
  });
  it("read grant may not change modes (403); manage grant may", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "read");
    const r = await updateGroup(deps, actor(U.staff), G1, { action: "set_mode", mode: "disabled" });
    assert.equal(!r.ok && r.error, "forbidden");
    const s2 = setup();
    giveGrant(s2.store, U.staff, "manage");
    assert.ok((await updateGroup(s2.deps, actor(U.staff), G1, { action: "set_mode", mode: "disabled" })).ok);
  });
  it("IDOR: a group of another connection answers not_found, nothing is changed", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "manage");
    const r = await updateGroup(deps, actor(U.staff), G3, { action: "set_mode", mode: "disabled" });
    assert.equal(!r.ok && r.error, "not_found");
    assert.equal(store.groupRows[2]!.mode, "monitor");
    const owner = await updateGroup(deps, actor(U.owner), G3, { action: "set_mode", mode: "disabled" });
    assert.equal(!owner.ok && owner.error, "not_found", "owner of C1 cannot touch C2");
  });
});

describe("conversations + messages", () => {
  it("owner lists own conversations (group + 1-1) only — never another connection's", async () => {
    const { deps } = setup();
    const r = await listConversations(deps, actor(U.owner), { page: 1, size: 25 });
    assert.ok(r.ok);
    assert.deepEqual(r.data.rows.map((c) => c.id).sort(), [CV_G1, CV_DM].sort());
  });
  it("staff with a read grant: group conversations only, 1-1 is not_found", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "read");
    const r = await listConversations(deps, actor(U.staff), { page: 1, size: 25 });
    assert.ok(r.ok);
    assert.deepEqual(r.data.rows.map((c) => c.id), [CV_G1]);
    const dm = await getConversation(deps, actor(U.staff), CV_DM);
    assert.equal(!dm.ok && dm.error, "not_found");
    const msgs = await listMessages(deps, actor(U.staff), CV_DM, { limit: 30 });
    assert.equal(!msgs.ok && msgs.error, "not_found");
  });
  it("staff outside its grant (another group / connection) → not_found", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "read", C1, CV_G1);
    assert.equal((await getConversation(deps, actor(U.staff), CV_G3)).ok, false);
    assert.equal((await listMessages(deps, actor(U.staff), CV_G3, { limit: 10 })).ok, false);
    assert.ok((await getConversation(deps, actor(U.staff), CV_G1)).ok);
  });
  it("admin WITHOUT a grant sees nothing of the owner's personal data", async () => {
    const { deps } = setup();
    const a = actor(U.admin, "admin");
    assert.equal((await moduleAccess(deps, a)).allowed, false);
    for (const r of [await listConversations(deps, a, { page: 1, size: 25 }), await getConversation(deps, a, CV_DM), await listMessages(deps, a, CV_G1, { limit: 5 }), await getSync(deps, a, C1, { page: 1, size: 25 })]) assert.equal(r.ok, false);
  });
  it("admin with only a sync grant: sync logs yes, messages no", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.admin, "sync");
    const a = actor(U.admin, "admin");
    assert.ok((await getSync(deps, a, C1, { page: 1, size: 25 })).ok);
    assert.equal((await listMessages(deps, a, CV_G1, { limit: 5 })).ok, false);
    assert.equal((await getSync(deps, a, C2, { page: 1, size: 25 })).ok, false, "other connection");
  });
  it("message history: bounded pages with a cursor until the end (never all at once)", async () => {
    const { deps } = setup();
    const seen = new Set<string>();
    let cursor: { beforeAt: string; beforeId: string } | undefined;
    let pages = 0;
    do {
      const r = await listMessages(deps, actor(U.owner), CV_G1, { limit: 10, ...cursor });
      assert.ok(r.ok);
      assert.ok(r.data.rows.length <= 10);
      for (const m of r.data.rows) {
        assert.ok(!seen.has(m.id), "no duplicates across pages");
        seen.add(m.id);
      }
      cursor = r.data.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(seen.size, 25);
    assert.equal(pages, 3);
  });
  it("untrusted HTML stays plain text; unsupported types and non-stored content are labelled", async () => {
    const { deps } = setup();
    const r = await listMessages(deps, actor(U.owner), CV_G1, { limit: 100 });
    assert.ok(r.ok);
    const xss = r.data.rows.find((m) => m.text?.includes("<script>"));
    assert.equal(xss?.text, XSS, "text is passed through unchanged (React escapes it at render)");
    assert.equal(r.data.rows.find((m) => m.type === "image")?.typeLabel, "Hình ảnh");
    const dm = await listMessages(deps, actor(U.owner), CV_DM, { limit: 5 });
    assert.ok(dm.ok && dm.data.rows.every((m) => m.text === null && m.contentState === "not_stored"));
    const mention = r.data.rows.find((m) => m.mentionsSelf);
    assert.deepEqual(mention?.mentions, [{ uidMasked: "…8623", kind: "user" }, { uidMasked: "…-1", kind: "all" }]);
  });
});

describe("search", () => {
  it("scope is applied before the query; staff cannot search another group", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "read", C1, CV_G1);
    const r = await searchMessages(deps, actor(U.staff), { text: "tin", from: "2026-11-20", to: "2026-11-24", limit: 100 });
    assert.ok(r.ok);
    assert.ok(r.data.rows.length > 0 && r.data.rows.every((m) => m.conversation?.id === CV_G1));
    const out = await searchMessages(deps, actor(U.staff), { conversationId: CV_G3, from: "2026-11-20", to: "2026-11-24", limit: 10 });
    assert.equal(!out.ok && out.error, "not_found");
  });
  it("LIKE wildcards are escaped; result size capped with a truncated flag", async () => {
    const { deps, store } = setup();
    const r = await searchMessages(deps, actor(U.owner), { text: "100% hàng_về", from: "2026-11-20", to: "2026-11-24", limit: 5 });
    assert.ok(r.ok);
    assert.equal(store.lastSearch?.text, "100\\% hàng\\_về");
    assert.equal(r.data.rows.length, 1);
    const many = await searchMessages(deps, actor(U.owner), { from: "2026-11-20", to: "2026-11-24", limit: 5 });
    assert.ok(many.ok && many.data.rows.length === 5 && many.data.truncated);
    assert.equal(store.lastSearch?.limit, 6, "asks for one extra row only");
  });
  it("no scope → empty result without querying messages", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "sync");
    const r = await searchMessages(deps, actor(U.staff), { from: "2026-11-20", to: "2026-11-24", limit: 5 });
    assert.ok(r.ok && r.data.rows.length === 0);
    assert.equal(store.lastSearch, null);
  });
});

describe("access management", () => {
  it("only the owner manages grants; the grantee's role comes from the database", async () => {
    const { deps, store } = setup();
    giveGrant(store, U.staff, "manage");
    assert.equal((await listGrants(deps, actor(U.staff), C1)).ok, false, "manage grant ≠ access management");
    const viewer = await grantAccess(deps, actor(U.owner), C1, { granteeUserId: U.viewer, scope: "connection", level: "read" });
    assert.equal(!viewer.ok && viewer.code, "grantee_role_not_allowed");
    const ok = await grantAccess(deps, actor(U.owner), C1, { granteeUserId: U.admin, scope: "connection", level: "sync" });
    assert.ok(ok.ok);
    assert.equal((await moduleAccess(deps, actor(U.admin, "admin"))).allowed, true);
    const grants = await listGrants(deps, actor(U.owner), C1);
    assert.ok(grants.ok && grants.data.candidates.every((c) => c.role !== "viewer" && c.id !== U.owner));
  });
  it("conversation grant must point at the owner's own connection (IDOR)", async () => {
    const { deps } = setup();
    const r = await grantAccess(deps, actor(U.owner), C1, { granteeUserId: U.staff, scope: "conversation", conversationId: CV_G3, level: "read" });
    assert.equal(!r.ok && r.error, "not_found");
    const foreign = await grantAccess(deps, actor(U.owner), C2, { granteeUserId: U.staff, scope: "connection", level: "read" });
    assert.equal(!foreign.ok && foreign.error, "not_found", "foreign connection: not even its existence is revealed");
  });
  it("revoke takes effect on the next call and is audited", async () => {
    const { deps, store } = setup();
    const g = await grantAccess(deps, actor(U.owner), C1, { granteeUserId: U.staff, scope: "connection", level: "read" });
    assert.ok(g.ok);
    assert.ok((await getConversation(deps, actor(U.staff), CV_G1)).ok);
    assert.ok((await revokeAccess(deps, actor(U.owner), C1, g.data.grantId)).ok);
    assert.equal((await getConversation(deps, actor(U.staff), CV_G1)).ok, false);
    assert.deepEqual(store.auditRows.map((a) => a.action), ["access.granted", "access.revoked"]);
  });
});

// ------------------------------------------------------------ static guards

const ROOT = path.resolve(import.meta.dirname, "../../../..");
function filesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|sql)$/.test(p)) out.push(p);
    }
  };
  walk(path.join(ROOT, rel));
  return out;
}
const UI = [...filesUnder("src/components/zalo-personal"), ...filesUnder("src/app/(authenticated)/(zalo)"), ...filesUnder("src/app/api/zalo-personal")];

describe("static guards", () => {
  it("found the dashboard files", () => assert.ok(UI.length >= 20, String(UI.length)));
  it("no HTML injection, no auto-loading of message URLs / attachments", () => {
    for (const f of UI) {
      const src = readFileSync(f, "utf8");
      assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML|<iframe|new Function|eval\(/, f);
      assert.doesNotMatch(src, /<img[^>]*src=\{[^}]*(text|content|url)/i, f);
    }
  });
  it("service role never reaches the browser; no secret column is ever selected", () => {
    for (const f of filesUnder("src/components/zalo-personal")) assert.doesNotMatch(readFileSync(f, "utf8"), /supabase\/admin|SERVICE_ROLE|dashboard\/server|supabase-store/, f);
    const store = readFileSync(path.join(ROOT, "src/lib/zalo-personal/dashboard/supabase-store.ts"), "utf8");
    assert.doesNotMatch(store, /secret_encrypted|request_nonces|select\("\*"\)/);
  });
  it("every API route authenticates + authorizes through authorizeZaloApi and validates path ids", () => {
    const routes = filesUnder("src/app/api/zalo-personal").filter((f) => f.endsWith("route.ts"));
    assert.equal(routes.length, 11);
    for (const f of routes) {
      const src = readFileSync(f, "utf8");
      assert.match(src, /authorizeZaloApi\(\)/, f);
      if (f.includes("[")) assert.match(src, /parseInput\(idParam/, f);
      assert.doesNotMatch(src, /Access-Control-Allow-Origin/i, f);
    }
  });
  it("every page gates through requireZaloPersonal", () => {
    for (const f of filesUnder("src/app/(authenticated)/(zalo)").filter((x) => x.endsWith("page.tsx"))) assert.match(readFileSync(f, "utf8"), /requireZaloPersonal\(\)/, f);
  });
  it("no sending / AI / Zalo OA code is reachable from the dashboard", () => {
    for (const f of UI) assert.doesNotMatch(readFileSync(f, "utf8"), /lib\/zalo\/|zca-js|sendMessage|anthropic|gemini|product-analyst/i, f);
  });
});
