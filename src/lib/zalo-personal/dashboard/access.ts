// ============================================================
// ZALO PERSONAL Phase 03 — who may see / change what (pure, unit tested).
//
// Two conditions, both checked on the server for every page and API call:
//   1. role: "zalo_personal:use" (admin + staff; viewer never) — necessary only;
//   2. data: the reader OWNS the connection (zalo_personal_connections.owner_user_id)
//      or holds an active grant from the owner (zalo_personal_access_grants).
// An admin without a grant sees nothing of somebody else's Zalo account.
//
//   owner                         everything on their own connection (incl. 1-1 chats, grants)
//   grant connection / sync       connection health + sync logs (no groups, no messages)
//   grant connection / read       + groups and GROUP conversations / messages
//   grant connection / manage     + change group mode, record / withdraw consent
//   grant conversation / read     that single conversation only (group or 1-1)
// A connection-wide grant never covers 1-1 conversations. Disabled
// connections stay visible to the owner only.
// ============================================================
import { hasPermission, type Role } from "../../auth/permissions.ts";

export type GrantLevel = "sync" | "read" | "manage";
export type GrantScope = "connection" | "conversation";

export interface Actor {
  userId: string;
  role: Role;
}

export interface ConnectionRef {
  id: string;
  ownerUserId: string;
  status: "active" | "disabled";
}

export interface GrantRef {
  id: string;
  connectionId: string;
  scope: GrantScope;
  conversationId: string | null;
  level: GrantLevel;
}

export interface ConnectionAccess {
  connectionId: string;
  owner: boolean;
  /** connection-wide grant level (null for the owner, or without such a grant) */
  level: GrantLevel | null;
  /** single conversations granted (read) */
  conversationIds: string[];
}

export interface AccessScope {
  actor: Actor;
  connections: ReadonlyMap<string, ConnectionAccess>;
}

/** The arrays the scoped SQL functions take (see 00074). */
export interface ConversationScope {
  full: string[];
  group: string[];
  ids: string[];
}

export type Capability =
  | "view_connection" // connection card, worker / heartbeat state
  | "view_sync" // sync logs, ingestion outcomes, status history
  | "view_groups" // group list + modes
  | "read_group_messages"
  | "read_direct_messages"
  | "manage_groups" // mode, consent
  | "manage_access" // grants
  | "view_audit";

const RANK: Record<GrantLevel, number> = { sync: 1, read: 2, manage: 3 };
const NEEDS: Record<Exclude<Capability, "read_direct_messages" | "manage_access">, number> = {
  view_connection: RANK.sync,
  view_sync: RANK.sync,
  view_groups: RANK.read,
  read_group_messages: RANK.read,
  manage_groups: RANK.manage,
  view_audit: RANK.manage,
};

export function canUseModule(role: Role | null | undefined): boolean {
  return hasPermission(role, "zalo_personal:use");
}

/**
 * Builds the reader's scope from the connections they own and the active
 * grants they hold (both loaded on the server, by user id — never from input).
 * Grants on a disabled connection, and anything for a role without the module
 * permission, are dropped.
 */
export function buildScope(actor: Actor, connections: readonly ConnectionRef[], grants: readonly GrantRef[]): AccessScope {
  const map = new Map<string, ConnectionAccess>();
  if (!canUseModule(actor.role)) return { actor, connections: map };
  const byId = new Map(connections.map((c) => [c.id, c]));
  for (const c of connections) {
    if (c.ownerUserId === actor.userId) map.set(c.id, { connectionId: c.id, owner: true, level: null, conversationIds: [] });
  }
  for (const g of grants) {
    const c = byId.get(g.connectionId);
    if (!c || c.status !== "active" || c.ownerUserId === actor.userId) continue;
    const entry = map.get(g.connectionId) ?? { connectionId: g.connectionId, owner: false, level: null, conversationIds: [] };
    if (g.scope === "connection") {
      if (!entry.level || RANK[g.level] > RANK[entry.level]) entry.level = g.level;
    } else if (g.conversationId && !entry.conversationIds.includes(g.conversationId)) {
      entry.conversationIds.push(g.conversationId);
    }
    map.set(g.connectionId, entry);
  }
  return { actor, connections: map };
}

export function hasAnyAccess(scope: AccessScope): boolean {
  return scope.connections.size > 0;
}

export function can(scope: AccessScope, connectionId: string, capability: Capability): boolean {
  const a = scope.connections.get(connectionId);
  if (!a) return false;
  if (a.owner) return true;
  if (capability === "read_direct_messages" || capability === "manage_access") return false;
  return a.level !== null && RANK[a.level] >= NEEDS[capability];
}

/** Connections whose card / health the reader may see. */
export function visibleConnectionIds(scope: AccessScope, capability: Capability = "view_connection"): string[] {
  return [...scope.connections.keys()].filter((id) => can(scope, id, capability));
}

/**
 * Whether the reader may open this conversation (and read its messages).
 * Always decided against the conversation row loaded from the database.
 */
export function canReadConversation(scope: AccessScope, conversation: { id: string; connectionId: string; conversationType: "user" | "group" }): boolean {
  const a = scope.connections.get(conversation.connectionId);
  if (!a) return false;
  if (a.owner) return true;
  if (a.conversationIds.includes(conversation.id)) return true;
  return conversation.conversationType === "group" && a.level !== null && RANK[a.level] >= RANK.read;
}

/** Scope arguments for the SQL functions; optionally narrowed to one connection. */
export function conversationScope(scope: AccessScope, onlyConnectionId?: string | null): ConversationScope {
  const out: ConversationScope = { full: [], group: [], ids: [] };
  for (const a of scope.connections.values()) {
    if (onlyConnectionId && a.connectionId !== onlyConnectionId) continue;
    if (a.owner) out.full.push(a.connectionId);
    else {
      if (a.level !== null && RANK[a.level] >= RANK.read) out.group.push(a.connectionId);
      out.ids.push(...a.conversationIds);
    }
  }
  return out;
}

export function isEmptyConversationScope(s: ConversationScope): boolean {
  return s.full.length === 0 && s.group.length === 0 && s.ids.length === 0;
}

/** What the reader is, per connection — for labels ("Chủ sở hữu", "Được cấp: xem"). */
export function accessLabel(a: ConnectionAccess | undefined): string {
  if (!a) return "Không có quyền";
  if (a.owner) return "Chủ sở hữu";
  if (a.level === "manage") return "Được cấp: quản lý nhóm";
  if (a.level === "read") return "Được cấp: xem nhóm";
  if (a.level === "sync") return "Được cấp: xem đồng bộ";
  return `Được cấp: ${a.conversationIds.length} hội thoại`;
}
