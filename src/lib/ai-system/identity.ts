// ============================================================
// PHASE 05 — UserIdentityResolver + identity linking (SYS-06). Pure + injected.
//
// Each channel identity is mapped to an internal user ONLY through a verified
// link; external ids of different channels are never assumed to be the same
// person, and nothing a message SAYS ("tôi là chủ") is evidence.
//
//   web            the Supabase session (auth.getUser) → profiles
//   zalo_oa        zalo_user_links (00069, made by the existing "LINK <mã>"
//                  flow of the OA webhook) → profiles — reused, not rebuilt
//   zalo_personal  ai_channel_identities (00077): (connection, Zalo sender id)
//                  → profiles, created only by consuming a one-time code the
//                  user generated while logged in (same code format / TTL as OA)
//
// Every resolution re-reads the profile: a disabled user or a removed role
// stops working on the next message, links included. Revoking a link (or
// the user) is immediate.
// ============================================================
import { isRole } from "../auth/permissions.ts";
import { generateLinkCode, hashLinkCode, LINK_CODE_TTL_MINUTES } from "../conversation/service.ts";
import { canUseAssistant } from "./policy.ts";
import type { IdentityResolution, InternalActor } from "./types.ts";

export interface IdentityStore {
  profile(userId: string): Promise<{ role: string | null; active: boolean } | null>;
  /** active OA link of a Zalo OA follower (zalo_user_links) */
  oaLink(zaloUserId: string): Promise<{ internalUserId: string } | null>;
  /** active Zalo Personal identity of a sender in a connection */
  personalIdentity(connectionId: string, externalUserId: string): Promise<{ internalUserId: string } | null>;
  createPersonalLinkCode(userId: string, codeHash: string, expiresAt: Date): Promise<void>;
  consumePersonalLinkCode(codeHash: string, connectionId: string, externalUserId: string): Promise<{ ok: true; internalUserId: string } | { ok: false; error: string }>;
  listPersonalIdentities(userId: string): Promise<Array<{ id: string; connectionId: string; externalUserId: string; linkedAt: string }>>;
  revokePersonalIdentity(id: string, userId: string, by: string): Promise<boolean>;
}

const ZALO_ID = /^[0-9]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Profile → actor (role validated; anything unknown is inactive). */
export async function loadActor(store: Pick<IdentityStore, "profile">, userId: string): Promise<IdentityResolution> {
  if (!UUID.test(userId)) return { status: "unlinked" };
  const p = await store.profile(userId);
  if (!p || !p.active || !isRole(p.role)) return { status: "inactive", userId };
  const actor: InternalActor = { userId, role: p.role, active: true };
  return { status: "resolved", actor };
}

export const resolveWebIdentity = (store: Pick<IdentityStore, "profile">, sessionUserId: string) => loadActor(store, sessionUserId);

export async function resolveOaIdentity(store: Pick<IdentityStore, "profile" | "oaLink">, zaloUserId: string): Promise<IdentityResolution> {
  if (!ZALO_ID.test(zaloUserId)) return { status: "unlinked" };
  const link = await store.oaLink(zaloUserId);
  return link ? loadActor(store, link.internalUserId) : { status: "unlinked" };
}

export async function resolvePersonalIdentity(store: Pick<IdentityStore, "profile" | "personalIdentity">, connectionId: string, senderId: string): Promise<IdentityResolution> {
  if (!UUID.test(connectionId) || !ZALO_ID.test(senderId)) return { status: "unlinked" };
  const link = await store.personalIdentity(connectionId, senderId);
  return link ? loadActor(store, link.internalUserId) : { status: "unlinked" };
}

// ------------------------------------------------------------------ linking (Zalo Personal)

/** "LINK ABCD2345" exactly (the whole message), case-insensitive. */
export function detectLinkCommand(text: string): string | null {
  const m = text.trim().match(/^link\s+([a-z2-9]{8})$/i);
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Step 1 (web, logged in): a one-time code for linking a Zalo Personal sender.
 * Only users who may use the assistant can create one; the plaintext is
 * returned ONCE, only its SHA-256 is stored.
 */
export async function issuePersonalLinkCode(store: IdentityStore, actor: InternalActor, now: Date): Promise<{ ok: true; code: string; expiresAt: Date } | { ok: false; reason: "not_allowed" }> {
  const fresh = await loadActor(store, actor.userId);
  if (fresh.status !== "resolved" || !canUseAssistant(fresh.actor).allowed) return { ok: false, reason: "not_allowed" };
  const { code, codeHash, expiresAt } = generateLinkCode(now);
  await store.createPersonalLinkCode(actor.userId, codeHash, expiresAt);
  return { ok: true, code, expiresAt };
}

/**
 * Step 2 (Zalo Personal message "LINK <mã>" received by a worker of the
 * connection, in a 1-1 chat): binds that sender to the code's owner. The DB
 * function checks unused + unexpired + active profile atomically.
 */
export async function linkPersonalIdentity(store: IdentityStore, input: { connectionId: string; senderId: string; code: string }): Promise<{ ok: true; internalUserId: string } | { ok: false; reason: "invalid_request" | "invalid_code" | "user_inactive" }> {
  if (!UUID.test(input.connectionId) || !ZALO_ID.test(input.senderId) || !/^[A-Z2-9]{8}$/i.test(input.code)) return { ok: false, reason: "invalid_request" };
  const r = await store.consumePersonalLinkCode(hashLinkCode(input.code), input.connectionId, input.senderId);
  if (r.ok) return r;
  return { ok: false, reason: r.error === "user_inactive" ? "user_inactive" : r.error === "invalid_request" ? "invalid_request" : "invalid_code" };
}

export { LINK_CODE_TTL_MINUTES };

export const IDENTITY_TEXT = {
  unlinked: "Tài khoản Zalo này chưa được liên kết với tài khoản CONGTRANGBEDDING nên trợ lý không thể truy cập dữ liệu. Hãy đăng nhập hệ thống để tạo mã liên kết.",
  inactive: "Tài khoản CONGTRANGBEDDING được liên kết đã bị khóa hoặc không còn quyền, nên trợ lý không thể truy cập dữ liệu.",
} as const;
