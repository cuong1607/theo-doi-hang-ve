// ============================================================
// ZALO PERSONAL Phase 03 — DashboardStore over the service-role client.
// Called ONLY by service.ts after the reader's scope was computed; scoped
// reads go through the 00074 SQL functions (scope passed as arrays, never
// built into a URL). Column lists are explicit: the worker secret column and the
// nonce table are never selected.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ConnectionRef, ConversationScope, GrantRef } from "./access.ts";
import type {
  AuditRow,
  ConnectionRow,
  ConversationFilter,
  ConversationRow,
  DashboardStore,
  GrantRow,
  GroupRow,
  IngestionEventRow,
  IngestionSummaryRow,
  MessageRow,
  ProfileRow,
  SearchFilter,
  StatusEventRow,
  SummaryRow,
  SyncRow,
  WorkerRow,
} from "./service.ts";
import type { SelfServiceFailure, SelfServiceStore } from "./self-service.ts";

type Raw = Record<string, unknown>;

class StoreError extends Error {
  constructor(op: string, code: string | undefined) {
    super(`zalo-personal dashboard store: ${op} failed (${code ?? "unknown"})`);
    this.name = "StoreError";
  }
}

function check<T>(op: string, res: { data: T | null; error: { code?: string } | null }): T {
  if (res.error) throw new StoreError(op, res.error.code);
  return res.data as T;
}

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const GROUP_COLS = "id, connection_id, external_group_id, display_name, mode, consent_status, consent_recorded_at, consent_note, send_verified_at, discovered_via, first_seen_at, last_seen_at, mode_changed_at";

function groupRow(r: Raw, conversationId: string | null): GroupRow {
  return {
    id: r.id as string,
    connectionId: r.connection_id as string,
    externalGroupId: r.external_group_id as string,
    displayName: s(r.display_name),
    mode: r.mode as GroupRow["mode"],
    consentStatus: r.consent_status as GroupRow["consentStatus"],
    consentRecordedAt: s(r.consent_recorded_at),
    consentNote: s(r.consent_note),
    sendVerifiedAt: s(r.send_verified_at),
    discoveredVia: r.discovered_via as GroupRow["discoveredVia"],
    firstSeenAt: r.first_seen_at as string,
    lastSeenAt: r.last_seen_at as string,
    modeChangedAt: s(r.mode_changed_at),
    conversationId,
  };
}

function conversationRow(r: Raw): ConversationRow {
  return {
    id: r.id as string,
    connectionId: r.connection_id as string,
    conversationType: r.conversation_type as "user" | "group",
    externalConversationId: r.external_conversation_id as string,
    groupId: s(r.group_id),
    groupName: s(r.group_name),
    groupMode: (s(r.group_mode) as ConversationRow["groupMode"]) ?? null,
    firstMessageAt: s(r.first_message_at),
    lastMessageAt: s(r.last_message_at),
  };
}

function messageRow(r: Raw): MessageRow {
  return {
    id: r.id as string,
    externalMessageId: r.external_message_id as string,
    senderExternalId: r.sender_external_id as string,
    messageType: r.message_type as string,
    textContent: s(r.text_content),
    contentStored: r.content_stored === true,
    textLength: Number(r.text_length ?? 0),
    mentions: r.mentions,
    mentionsSelf: r.mentions_self === true,
    isSelf: r.is_self === true,
    sentAt: s(r.sent_at),
    receivedAt: r.received_at as string,
    messageAt: r.message_at as string,
    processingState: s(r.processing_state) ?? undefined,
    connectionId: s(r.connection_id) ?? undefined,
    conversationId: s(r.conversation_id) ?? undefined,
    conversationType: (s(r.conversation_type) as "user" | "group" | null) ?? undefined,
    externalConversationId: s(r.external_conversation_id) ?? undefined,
    groupName: s(r.group_name),
  };
}

const scopeArgs = (sc: ConversationScope) => ({ p_full: sc.full, p_group: sc.group, p_ids: sc.ids });

export class SupabaseDashboardStore implements DashboardStore, SelfServiceStore {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async loadAccess(userId: string): Promise<{ connections: ConnectionRef[]; grants: GrantRef[] }> {
    const grants = check<Raw[]>(
      "grants(self)",
      await this.db.from("zalo_personal_access_grants").select("id, connection_id, scope, conversation_id, level").eq("grantee_user_id", userId).is("revoked_at", null).limit(500),
    );
    const grantConnIds = [...new Set(grants.map((g) => g.connection_id as string))];
    const owned = check<Raw[]>("connections(owned)", await this.db.from("zalo_personal_connections").select("id, owner_user_id, status").eq("owner_user_id", userId).limit(100));
    const granted = grantConnIds.length ? check<Raw[]>("connections(granted)", await this.db.from("zalo_personal_connections").select("id, owner_user_id, status").in("id", grantConnIds)) : [];
    const connections = [...owned, ...granted.filter((g) => !owned.some((o) => o.id === g.id))].map((c) => ({ id: c.id as string, ownerUserId: c.owner_user_id as string, status: c.status as "active" | "disabled" }));
    return {
      connections,
      grants: grants.map((g) => ({ id: g.id as string, connectionId: g.connection_id as string, scope: g.scope as GrantRef["scope"], conversationId: s(g.conversation_id), level: g.level as GrantRef["level"] })),
    };
  }

  async connections(ids: string[]): Promise<ConnectionRow[]> {
    if (!ids.length) return [];
    const rows = check<Raw[]>(
      "connections",
      await this.db
        .from("zalo_personal_connections")
        .select("id, connection_key, owner_user_id, zalo_account_id, status, direct_message_mode, last_heartbeat_at, last_connected_at, last_error_category, owner:profiles!zalo_personal_connections_owner_user_id_fkey(full_name)")
        .in("id", ids)
        .order("connection_key"),
    );
    return rows.map((r) => ({
      id: r.id as string,
      connectionKey: r.connection_key as string,
      ownerUserId: r.owner_user_id as string,
      ownerName: s((r.owner as Raw | null)?.full_name),
      zaloAccountId: s(r.zalo_account_id),
      status: r.status as "active" | "disabled",
      directMessageMode: r.direct_message_mode as ConnectionRow["directMessageMode"],
      lastHeartbeatAt: s(r.last_heartbeat_at),
      lastConnectedAt: s(r.last_connected_at),
      lastErrorCategory: s(r.last_error_category),
    }));
  }

  async workers(connectionIds: string[]): Promise<WorkerRow[]> {
    if (!connectionIds.length) return [];
    const [workers, sync] = await Promise.all([
      this.db.from("zalo_personal_workers").select("id, worker_key, connection_id, status, last_seen_at").in("connection_id", connectionIds).order("worker_key"),
      this.db
        .from("zalo_personal_sync_state")
        .select("worker_id, worker_version, worker_started_at, last_heartbeat_at, session_state, listener_state, last_message_received_at, last_delivery_ok_at, last_ingested_at, last_event_at, outbox_depth, dead_letter_count, outbox_full_drops, last_error_category")
        .in("connection_id", connectionIds),
    ]);
    const ws = check<Raw[]>("workers", workers);
    const ss = check<Raw[]>("sync_state", sync);
    return ws.map((w) => {
      const x = ss.find((r) => r.worker_id === w.id);
      return {
        id: w.id as string,
        workerKey: w.worker_key as string,
        connectionId: w.connection_id as string,
        status: w.status as "active" | "revoked",
        lastSeenAt: s(w.last_seen_at),
        sync: x
          ? {
              workerVersion: s(x.worker_version),
              workerStartedAt: s(x.worker_started_at),
              lastHeartbeatAt: s(x.last_heartbeat_at),
              sessionState: x.session_state as SyncRow["sessionState"],
              listenerState: x.listener_state as SyncRow["listenerState"],
              lastMessageReceivedAt: s(x.last_message_received_at),
              lastDeliveryOkAt: s(x.last_delivery_ok_at),
              lastIngestedAt: s(x.last_ingested_at),
              lastEventAt: s(x.last_event_at),
              outboxDepth: n(x.outbox_depth),
              deadLetterCount: n(x.dead_letter_count),
              outboxFullDrops: n(x.outbox_full_drops),
              lastErrorCategory: s(x.last_error_category),
            }
          : null,
      };
    });
  }

  async groupCounts(connectionIds: string[]): Promise<{ connectionId: string; total: number; monitored: number }[]> {
    if (!connectionIds.length) return [];
    const rows = check<Raw[]>("groupCounts", await this.db.from("zalo_personal_groups").select("connection_id, mode").in("connection_id", connectionIds).limit(10_000));
    return connectionIds.map((id) => {
      const mine = rows.filter((r) => r.connection_id === id);
      return { connectionId: id, total: mine.length, monitored: mine.filter((r) => r.mode !== "disabled").length };
    });
  }

  private async groupConversationIds(groupIds: string[]): Promise<Map<string, string>> {
    if (!groupIds.length) return new Map();
    const rows = check<Raw[]>("group conversations", await this.db.from("zalo_personal_conversations").select("id, group_id").in("group_id", groupIds));
    return new Map(rows.map((r) => [r.group_id as string, r.id as string]));
  }

  async groups(q: { connectionIds: string[]; mode?: GroupRow["mode"]; offset: number; limit: number }): Promise<{ rows: GroupRow[]; total: number }> {
    let query = this.db.from("zalo_personal_groups").select(GROUP_COLS, { count: "exact" }).in("connection_id", q.connectionIds);
    if (q.mode) query = query.eq("mode", q.mode);
    const res = await query.order("last_seen_at", { ascending: false }).order("id").range(q.offset, q.offset + q.limit - 1);
    const rows = check<Raw[]>("groups", res);
    const conv = await this.groupConversationIds(rows.map((r) => r.id as string));
    return { rows: rows.map((r) => groupRow(r, conv.get(r.id as string) ?? null)), total: res.count ?? rows.length };
  }

  async group(id: string): Promise<GroupRow | null> {
    const r = check<Raw | null>("group", await this.db.from("zalo_personal_groups").select(GROUP_COLS).eq("id", id).maybeSingle());
    if (!r) return null;
    const conv = await this.groupConversationIds([id]);
    return groupRow(r, conv.get(id) ?? null);
  }

  async updateGroup(actorId: string, connectionId: string, groupId: string, action: string, mode: string | null, note: string | null) {
    const res = check<Raw>("zp_update_group", await this.db.rpc("zp_update_group", { p_actor: actorId, p_connection_id: connectionId, p_group_id: groupId, p_action: action, p_mode: mode, p_note: note }));
    if (res.ok !== true) return { ok: false as const, error: String(res.error ?? "unknown") };
    const g = res.group as Raw;
    return { ok: true as const, changed: res.changed === true, group: { id: g.id as string, mode: g.mode as string, consentStatus: g.consentStatus as string } };
  }

  async conversations(scope: ConversationScope, f: ConversationFilter, offset: number, limit: number): Promise<{ rows: ConversationRow[]; total: number }> {
    const rows = check<Raw[]>(
      "zp_dashboard_conversations",
      await this.db.rpc("zp_dashboard_conversations", { ...scopeArgs(scope), p_connection_id: f.connectionId ?? null, p_type: f.type ?? null, p_group_id: f.groupId ?? null, p_name: f.name ?? null, p_offset: offset, p_limit: limit }),
    );
    return { rows: rows.map(conversationRow), total: rows.length ? Number(rows[0]!.total_count) : 0 };
  }

  async conversation(id: string): Promise<ConversationRow | null> {
    const r = check<Raw | null>(
      "conversation",
      await this.db.from("zalo_personal_conversations").select("id, connection_id, conversation_type, external_conversation_id, group_id, first_message_at, last_message_at, grp:zalo_personal_groups(display_name, mode)").eq("id", id).maybeSingle(),
    );
    if (!r) return null;
    const g = r.grp as Raw | null;
    return conversationRow({ ...r, group_name: g?.display_name ?? null, group_mode: g?.mode ?? null });
  }

  async summaries(conversationIds: string[]): Promise<SummaryRow[]> {
    if (!conversationIds.length) return [];
    const rows = check<Raw[]>("zp_conversation_summaries", await this.db.rpc("zp_conversation_summaries", { p_conversation_ids: conversationIds.slice(0, 200) }));
    return rows.map((r) => ({
      conversationId: r.conversation_id as string,
      messageCount: Number(r.message_count ?? 0),
      lastMessageType: s(r.last_message_type),
      lastText: s(r.last_text),
      lastContentStored: r.last_content_stored === null || r.last_content_stored === undefined ? null : r.last_content_stored === true,
      lastIsSelf: r.last_is_self === null || r.last_is_self === undefined ? null : r.last_is_self === true,
      lastSentAt: s(r.last_sent_at),
      lastIngestedAt: s(r.last_ingested_at),
    }));
  }

  async messages(conversationId: string, before: { at: string; id: string } | null, limit: number): Promise<MessageRow[]> {
    const rows = check<Raw[]>("zp_dashboard_messages", await this.db.rpc("zp_dashboard_messages", { p_conversation_id: conversationId, p_before_at: before?.at ?? null, p_before_id: before?.id ?? null, p_limit: limit }));
    return rows.map(messageRow);
  }

  async search(scope: ConversationScope, f: SearchFilter): Promise<MessageRow[]> {
    const rows = check<Raw[]>(
      "zp_dashboard_search",
      await this.db.rpc("zp_dashboard_search", {
        ...scopeArgs(scope),
        p_text: f.text ?? null,
        p_conversation_id: f.conversationId ?? null,
        p_sender: f.senderId ?? null,
        p_type: f.messageType ?? null,
        p_from: f.from.toISOString(),
        p_to: f.to.toISOString(),
        p_limit: f.limit,
      }),
    );
    return rows.map(messageRow);
  }

  async counts(scope: ConversationScope, since: Date) {
    const rows = check<Raw[]>("zp_dashboard_counts", await this.db.rpc("zp_dashboard_counts", { ...scopeArgs(scope), p_since: since.toISOString() }));
    const r = rows[0] ?? {};
    return { conversations: Number(r.conversations ?? 0), messagesSince: Number(r.messages_since ?? 0), lastMessageAt: s(r.last_message_at) };
  }

  async statusEvents(connectionId: string, limit: number): Promise<StatusEventRow[]> {
    const rows = check<Raw[]>(
      "status_events",
      await this.db
        .from("zalo_personal_status_events")
        .select("id, worker_id, kind, observed_at, session_state, listener_state, last_error_category, outbox_depth, dead_letter_count, previous_heartbeat_at")
        .eq("connection_id", connectionId)
        .order("observed_at", { ascending: false })
        .limit(limit),
    );
    return rows.map((r) => ({
      id: Number(r.id),
      workerId: r.worker_id as string,
      kind: r.kind as StatusEventRow["kind"],
      observedAt: r.observed_at as string,
      sessionState: r.session_state as string,
      listenerState: r.listener_state as string,
      lastErrorCategory: s(r.last_error_category),
      outboxDepth: n(r.outbox_depth),
      deadLetterCount: n(r.dead_letter_count),
      previousHeartbeatAt: s(r.previous_heartbeat_at),
    }));
  }

  async ingestionSummary(connectionId: string, since: Date): Promise<IngestionSummaryRow[]> {
    const rows = check<Raw[]>("zp_ingestion_summary", await this.db.rpc("zp_ingestion_summary", { p_connection_id: connectionId, p_since: since.toISOString() }));
    return rows.map((r) => ({ outcome: r.outcome as string, reason: s(r.reason), events: Number(r.events), redeliveredEvents: Number(r.redelivered_events), extraDeliveries: Number(r.extra_deliveries), lastReceivedAt: s(r.last_received_at) }));
  }

  async ingestionEvents(connectionId: string, offset: number, limit: number): Promise<{ rows: IngestionEventRow[]; total: number }> {
    const res = await this.db
      .from("zalo_personal_ingestion_events")
      .select("id, kind, conversation_type, outcome, reason, delivery_count, occurred_at, first_received_at, last_received_at", { count: "exact" })
      .eq("connection_id", connectionId)
      .order("first_received_at", { ascending: false })
      .order("id")
      .range(offset, offset + limit - 1);
    const rows = check<Raw[]>("ingestion_events", res);
    return {
      rows: rows.map((r) => ({ id: r.id as string, kind: r.kind as string, conversationType: s(r.conversation_type), outcome: r.outcome as string, reason: s(r.reason), deliveryCount: Number(r.delivery_count), occurredAt: s(r.occurred_at), firstReceivedAt: r.first_received_at as string, lastReceivedAt: r.last_received_at as string })),
      total: res.count ?? rows.length,
    };
  }

  async grants(connectionId: string): Promise<GrantRow[]> {
    const rows = check<Raw[]>(
      "grants",
      await this.db
        .from("zalo_personal_access_grants")
        .select("id, connection_id, grantee_user_id, scope, conversation_id, level, note, granted_at, grantee:profiles!zalo_personal_access_grants_grantee_user_id_fkey(full_name, role), granter:profiles!zalo_personal_access_grants_granted_by_fkey(full_name)")
        .eq("connection_id", connectionId)
        .is("revoked_at", null)
        .order("granted_at", { ascending: false }),
    );
    return rows.map((r) => ({
      id: r.id as string,
      connectionId: r.connection_id as string,
      granteeUserId: r.grantee_user_id as string,
      granteeName: s((r.grantee as Raw | null)?.full_name),
      granteeRole: s((r.grantee as Raw | null)?.role),
      scope: r.scope as GrantRow["scope"],
      conversationId: s(r.conversation_id),
      level: r.level as GrantRow["level"],
      note: s(r.note),
      grantedAt: r.granted_at as string,
      grantedByName: s((r.granter as Raw | null)?.full_name),
    }));
  }

  async grant(actorId: string, connectionId: string, g: { granteeUserId: string; scope: GrantRow["scope"]; conversationId: string | null; level: GrantRow["level"]; note: string | null }) {
    const res = check<Raw>("zp_grant_access", await this.db.rpc("zp_grant_access", { p_actor: actorId, p_connection_id: connectionId, p_grantee: g.granteeUserId, p_scope: g.scope, p_conversation_id: g.conversationId, p_level: g.level, p_note: g.note }));
    if (res.ok !== true) return { ok: false as const, error: String(res.error ?? "unknown") };
    return { ok: true as const, changed: res.changed === true, grantId: res.grantId as string };
  }

  async revoke(actorId: string, connectionId: string, grantId: string) {
    const res = check<Raw>("zp_revoke_access", await this.db.rpc("zp_revoke_access", { p_actor: actorId, p_connection_id: connectionId, p_grant_id: grantId }));
    if (res.ok !== true) return { ok: false as const, error: String(res.error ?? "unknown") };
    return { ok: true as const, changed: res.changed === true };
  }

  async audit(connectionId: string, limit: number): Promise<AuditRow[]> {
    const rows = check<Raw[]>(
      "audit",
      await this.db.from("zalo_personal_audit_log").select("id, action, target_type, target_id, details, created_at, actor:profiles(full_name)").eq("connection_id", connectionId).order("created_at", { ascending: false }).limit(limit),
    );
    return rows.map((r) => ({ id: Number(r.id), action: r.action as string, targetType: r.target_type as string, targetId: r.target_id as string, details: (r.details ?? {}) as Record<string, unknown>, actorName: s((r.actor as Raw | null)?.full_name), createdAt: r.created_at as string }));
  }

  async profile(id: string): Promise<ProfileRow | null> {
    const r = check<Raw | null>("profile", await this.db.from("profiles").select("id, full_name, role, is_active").eq("id", id).maybeSingle());
    return r ? { id: r.id as string, name: s(r.full_name), role: r.role as string, isActive: r.is_active === true } : null;
  }

  async activeProfiles(): Promise<ProfileRow[]> {
    const rows = check<Raw[]>("profiles", await this.db.from("profiles").select("id, full_name, role, is_active").eq("is_active", true).in("role", ["admin", "staff"]).order("full_name").limit(500));
    return rows.map((r) => ({ id: r.id as string, name: s(r.full_name), role: r.role as string, isActive: r.is_active === true }));
  }

  // ------------------------------------------------------------ self-service (00076; ownership re-checked in SQL)
  private async selfService<T>(op: string, fn: string, args: Record<string, unknown>): Promise<T | SelfServiceFailure> {
    const r = check<{ ok: boolean; error?: string } & Record<string, unknown>>(op, await this.db.rpc(fn, args));
    return (r.ok ? r : { ok: false, error: r.error ?? "server_error" }) as T | SelfServiceFailure;
  }

  createConnection(actorId: string, key: string, directMode: "off" | "metadata") {
    return this.selfService<{ ok: true; id: string; key: string }>("createConnection", "zp_create_connection", { p_actor: actorId, p_key: key, p_direct_mode: directMode });
  }

  issueWorker(actorId: string, connectionId: string, workerId: string, workerKey: string, secretEncrypted: string) {
    return this.selfService<{ ok: true; id: string; workerKey: string }>("issueWorker", "zp_issue_worker", { p_actor: actorId, p_connection_id: connectionId, p_worker_id: workerId, p_worker_key: workerKey, p_secret_ciphertext: secretEncrypted });
  }

  revokeWorker(actorId: string, connectionId: string, workerId: string) {
    return this.selfService<{ ok: true; changed: boolean }>("revokeWorker", "zp_revoke_worker", { p_actor: actorId, p_connection_id: connectionId, p_worker_id: workerId });
  }

  setConnectionStatus(actorId: string, connectionId: string, status: "active" | "disabled") {
    return this.selfService<{ ok: true; changed: boolean }>("setConnectionStatus", "zp_set_connection_status", { p_actor: actorId, p_connection_id: connectionId, p_status: status });
  }
}
