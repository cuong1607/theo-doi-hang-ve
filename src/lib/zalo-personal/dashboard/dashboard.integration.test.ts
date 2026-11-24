// ============================================================
// ZALO PERSONAL Phase 03 — dashboard integration tests against the LOCAL
// Supabase (migrations 00073 + 00074). Data is produced by the real Phase 02
// RPCs (heartbeat + ingest), read through the real SupabaseDashboardStore and
// the service. Covers: scope / IDOR / admin-without-grant on real rows, group
// mode governance in the database (consent, interactive, audit in the same
// transaction, append-only audit), status history trigger, keyset paging,
// search scope + LIKE escaping, grants, RLS for anon / authenticated.
// No real Zalo account involved.
// Run: node --env-file=<local env> --test src/lib/zalo-personal/dashboard/dashboard.integration.test.ts
// ============================================================
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { encryptSecret, parseEncryptionKey } from "../../security/secrets.ts";
import { workerSecretContext } from "../config.ts";
import { generateWorkerSecret } from "../signing.ts";
import { vnDate } from "./contracts.ts";
import { getConversation, getOverview, getSync, grantAccess, listConnections, listConversations, listGroups, listMessages, moduleAccess, revokeAccess, searchMessages, updateGroup, type DashboardDeps } from "./service.ts";
import { SupabaseDashboardStore } from "./supabase-store.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (never production)");
const db: SupabaseClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const encKey = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);
const deps: DashboardDeps = { store: new SupabaseDashboardStore(db) };

const RUN = randomBytes(3).toString("hex");
const PASSWORD = `Pw-${randomBytes(8).toString("hex")}`;
const ACCOUNT_1 = `81${Date.now()}`.slice(0, 18);
const ACCOUNT_2 = `82${Date.now()}`.slice(0, 18);
const GROUP_A = `25${Date.now()}1`.slice(0, 19);
const GROUP_B = `25${Date.now()}2`.slice(0, 19);
const GROUP_C = `25${Date.now()}3`.slice(0, 19);
const FRIEND = "3000000000000000001";
const XSS = `<script>alert("zp")</script><img src=x onerror=alert(1)>`;

const users: Record<"owner" | "staff" | "admin" | "viewer" | "owner2", { id: string; email: string; role: "admin" | "staff" | "viewer" }> = {} as never;
const conn = { c1: "", c2: "", w1: "", w2: "" };
const created = { users: [] as string[], connections: [] as string[] };
const actor = (k: keyof typeof users) => ({ userId: users[k].id, role: users[k].role });

async function createUser(key: keyof typeof users, role: "admin" | "staff" | "viewer") {
  const email = `zp3-${key}-${RUN}@example.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${error?.message}`);
  created.users.push(data.user.id);
  await db.from("profiles").update({ is_active: true, role, full_name: `ZP3 ${key}` }).eq("id", data.user.id);
  users[key] = { id: data.user.id, email, role };
}

async function createConnection(key: string, owner: string, account: string): Promise<{ id: string; workerId: string }> {
  const { data: c, error } = await db.from("zalo_personal_connections").insert({ connection_key: `d3-${key}-${RUN}`, owner_user_id: owner, direct_message_mode: "metadata" }).select("id").single();
  if (error) throw new Error(`connection ${error.message}`);
  created.connections.push(c.id);
  const workerId = randomUUID();
  const { error: we } = await db.from("zalo_personal_workers").insert({ id: workerId, worker_key: `d3w-${key}-${RUN}`, connection_id: c.id, secret_encrypted: encryptSecret(generateWorkerSecret(), encKey, workerSecretContext(workerId)) });
  if (we) throw new Error(`worker ${we.message}`);
  await heartbeat(workerId, account, { sessionState: "authenticated", listenerState: "active" });
  return { id: c.id, workerId };
}

async function heartbeat(workerId: string, account: string, s: Record<string, unknown>) {
  const { data, error } = await db.rpc("zp_record_heartbeat", {
    p_worker_id: workerId,
    p_account_id: account,
    p_state: { workerVersion: "0.2.0-test", workerStartedAt: new Date().toISOString(), lastMessageReceivedAt: null, lastDeliveryOkAt: new Date().toISOString(), outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastErrorCategory: null, ...s },
  });
  if (error || data?.ok !== true) throw new Error(`heartbeat ${error?.message ?? JSON.stringify(data)}`);
}

let seq = 0;
function event(type: "group" | "user", conversationId: string, text: string | null, at: Date, extra: Record<string, unknown> = {}) {
  seq++;
  return {
    eventKey: createHash("sha256").update(`d3|${RUN}|${seq}`).digest("hex"),
    kind: "message",
    conversationType: type,
    conversationId,
    externalMessageId: `d3${RUN}${seq}`,
    senderId: seq % 2 ? FRIEND : "3000000000000000002",
    messageType: "text",
    text,
    textLength: text?.length ?? 5,
    mentions: [],
    mentionsSelf: false,
    isSelf: false,
    subtype: null,
    sentAt: at.toISOString(),
    receivedAt: at.toISOString(),
    ...extra,
  };
}

async function ingest(workerId: string, account: string, events: unknown[]) {
  const { data, error } = await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: account, p_events: events });
  if (error || data?.ok !== true) throw new Error(`ingest ${error?.message ?? JSON.stringify(data)}`);
  return data.results as { status: string; reason: string | null }[];
}

const groupId = async (connectionId: string, external: string) => (await db.from("zalo_personal_groups").select("id").eq("connection_id", connectionId).eq("external_group_id", external).single()).data!.id as string;
const conversationId = async (connectionId: string, external: string) => (await db.from("zalo_personal_conversations").select("id").eq("connection_id", connectionId).eq("external_conversation_id", external).single()).data!.id as string;

before(async () => {
  await createUser("owner", "staff");
  await createUser("staff", "staff");
  await createUser("admin", "admin");
  await createUser("viewer", "viewer");
  await createUser("owner2", "admin");
  const c1 = await createConnection("one", users.owner.id, ACCOUNT_1);
  const c2 = await createConnection("two", users.owner2.id, ACCOUNT_2);
  Object.assign(conn, { c1: c1.id, w1: c1.workerId, c2: c2.id, w2: c2.workerId });

  // groups appear (disabled) on their first event; then the owner records consent and turns monitoring on
  const now = Date.now();
  await ingest(conn.w1, ACCOUNT_1, [event("group", GROUP_A, "trước khi bật", new Date(now - 3600_000)), event("group", GROUP_B, "nhóm B", new Date(now - 3600_000))]);
  await ingest(conn.w2, ACCOUNT_2, [event("group", GROUP_C, "nhóm C", new Date(now - 3600_000))]);
  for (const [actorId, c, ext] of [[users.owner.id, conn.c1, GROUP_A], [users.owner2.id, conn.c2, GROUP_C]] as const) {
    const g = await groupId(c, ext);
    assert.equal((await db.rpc("zp_update_group", { p_actor: actorId, p_connection_id: c, p_group_id: g, p_action: "grant_consent", p_mode: null, p_note: "nhóm đã đồng ý (test)" })).data.ok, true);
    assert.equal((await db.rpc("zp_update_group", { p_actor: actorId, p_connection_id: c, p_group_id: g, p_action: "set_mode", p_mode: "monitor", p_note: null })).data.ok, true);
  }
  const groupEvents = Array.from({ length: 35 }, (_, i) => event("group", GROUP_A, i === 7 ? XSS : i === 9 ? "giảm 100% phí_ship" : `tin nhóm A số ${i}`, new Date(now - (40 - i) * 60_000)));
  const results = await ingest(conn.w1, ACCOUNT_1, groupEvents.slice(0, 25));
  assert.ok(results.every((r) => r.status === "stored"), JSON.stringify(results));
  await ingest(conn.w1, ACCOUNT_1, groupEvents.slice(25));
  await ingest(conn.w1, ACCOUNT_1, [event("user", FRIEND, "bí mật 1-1", new Date(now - 120_000)), event("user", FRIEND, "bí mật 2", new Date(now - 60_000))]);
  await ingest(conn.w2, ACCOUNT_2, [event("group", GROUP_C, "tin của chủ 2", new Date(now - 60_000))]);
});

after(async () => {
  for (const id of created.connections) {
    await db.from("zalo_personal_audit_log").delete().eq("connection_id", id);
    await db.from("zalo_personal_access_grants").delete().eq("connection_id", id);
    await db.from("zalo_personal_messages").delete().eq("connection_id", id);
    await db.from("zalo_personal_ingestion_events").delete().eq("connection_id", id);
    await db.from("zalo_personal_conversations").delete().eq("connection_id", id);
    await db.from("zalo_personal_groups").delete().eq("connection_id", id);
    await db.from("zalo_personal_sync_state").delete().eq("connection_id", id);
    await db.from("zalo_personal_workers").delete().eq("connection_id", id);
    await db.from("zalo_personal_connections").delete().eq("id", id);
  }
  for (const id of created.users) await db.auth.admin.deleteUser(id);
});

describe("scope on real rows", () => {
  it("owner: own connection only; group A content, group B disabled; 1-1 metadata only", async () => {
    const o = await getOverview(deps, actor("owner"));
    assert.ok(o.ok, JSON.stringify(o));
    assert.equal(o.data.connections, 1);
    assert.deepEqual([o.data.groupsTotal, o.data.groupsMonitored], [2, 1]);
    assert.equal(o.data.conversations, 2, "group A + the 1-1 (group B never stored a message)");
    assert.equal(o.data.connectionStates[0]!.health.situation, "ok");
    const list = await listConversations(deps, actor("owner"), { page: 1, size: 25 });
    assert.ok(list.ok);
    assert.deepEqual(list.data.rows.map((c) => c.type).sort(), ["group", "user"]);
    const dm = list.data.rows.find((c) => c.type === "user")!;
    assert.equal(dm.last?.preview, null, "1-1 text not stored (metadata mode)");
    assert.equal(dm.messageCount, 2);
  });
  it("staff / admin without grant, viewer → module hidden and forbidden", async () => {
    for (const k of ["staff", "admin", "viewer"] as const) {
      assert.equal((await moduleAccess(deps, actor(k))).allowed, false, k);
      assert.equal((await getOverview(deps, actor(k))).ok, false, k);
    }
  });
  it("IDOR: owner of connection 1 cannot open connection 2's conversation, group or sync", async () => {
    const foreignConv = await conversationId(conn.c2, GROUP_C);
    const foreignGroup = await groupId(conn.c2, GROUP_C);
    assert.equal((await getConversation(deps, actor("owner"), foreignConv)).ok, false);
    assert.equal((await listMessages(deps, actor("owner"), foreignConv, { limit: 5 })).ok, false);
    const r = await updateGroup(deps, actor("owner"), foreignGroup, { action: "set_mode", mode: "disabled" });
    assert.equal(!r.ok && r.error, "not_found");
    assert.equal((await db.from("zalo_personal_groups").select("mode").eq("id", foreignGroup).single()).data?.mode, "monitor", "unchanged");
    assert.equal((await getSync(deps, actor("owner"), conn.c2, { page: 1, size: 5 })).ok, false);
  });
});

describe("grants", () => {
  it("read grant → group conversations only; the owner's 1-1 stays private; revoke is immediate", async () => {
    const g = await grantAccess(deps, actor("owner"), conn.c1, { granteeUserId: users.staff.id, scope: "connection", level: "read" });
    assert.ok(g.ok, JSON.stringify(g));
    const list = await listConversations(deps, actor("staff"), { page: 1, size: 25 });
    assert.ok(list.ok);
    assert.deepEqual(list.data.rows.map((c) => c.type), ["group"]);
    const dmId = await conversationId(conn.c1, FRIEND);
    assert.equal((await getConversation(deps, actor("staff"), dmId)).ok, false);
    const s = await searchMessages(deps, actor("staff"), { text: "bí mật", from: vnDate(new Date(Date.now() - 86_400_000)), to: vnDate(), limit: 50 });
    assert.ok(s.ok && s.data.rows.length === 0, "1-1 content not searchable through a connection grant");
    const groups = await listGroups(deps, actor("staff"), { page: 1, size: 25 });
    assert.ok(groups.ok && groups.data.rows.length === 2 && groups.data.rows.every((x) => !x.canManage));
    const ga = await groupId(conn.c1, GROUP_A);
    const denied = await updateGroup(deps, actor("staff"), ga, { action: "set_mode", mode: "disabled" });
    assert.equal(!denied.ok && denied.error, "forbidden");
    assert.ok((await revokeAccess(deps, actor("owner"), conn.c1, g.data.grantId)).ok);
    assert.equal((await moduleAccess(deps, actor("staff"))).allowed, false);
  });
  it("admin with a sync grant: health + logs, no groups, no messages", async () => {
    const g = await grantAccess(deps, actor("owner"), conn.c1, { granteeUserId: users.admin.id, scope: "connection", level: "sync" });
    assert.ok(g.ok);
    const sync = await getSync(deps, actor("admin"), conn.c1, { page: 1, size: 10 });
    assert.ok(sync.ok);
    assert.ok(sync.data.summary24h.some((r) => r.outcome === "stored"));
    const convs = await listConversations(deps, actor("admin"), { page: 1, size: 25 });
    assert.ok(convs.ok && convs.data.rows.length === 0);
    const ga = await conversationId(conn.c1, GROUP_A);
    assert.equal((await listMessages(deps, actor("admin"), ga, { limit: 5 })).ok, false);
    assert.ok((await revokeAccess(deps, actor("owner"), conn.c1, g.data.grantId)).ok);
  });
  it("database refuses a grant to the owner or to a conversation of another connection; viewer refused by the service", async () => {
    const foreignConv = await conversationId(conn.c2, GROUP_C);
    const r1 = await db.rpc("zp_grant_access", { p_actor: users.owner.id, p_connection_id: conn.c1, p_grantee: users.owner.id, p_scope: "connection", p_conversation_id: null, p_level: "read", p_note: null });
    assert.equal(r1.data.error, "grantee_is_owner");
    const r2 = await db.rpc("zp_grant_access", { p_actor: users.owner.id, p_connection_id: conn.c1, p_grantee: users.staff.id, p_scope: "conversation", p_conversation_id: foreignConv, p_level: "read", p_note: null });
    assert.equal(r2.data.error, "not_found");
    const v = await grantAccess(deps, actor("owner"), conn.c1, { granteeUserId: users.viewer.id, scope: "connection", level: "read" });
    assert.equal(!v.ok && v.code, "grantee_role_not_allowed");
  });
  it("a single 1-1 conversation can be shared explicitly", async () => {
    const dmId = await conversationId(conn.c1, FRIEND);
    const g = await grantAccess(deps, actor("owner"), conn.c1, { granteeUserId: users.staff.id, scope: "conversation", conversationId: dmId, level: "read" });
    assert.ok(g.ok);
    assert.ok((await getConversation(deps, actor("staff"), dmId)).ok);
    const list = await listConversations(deps, actor("staff"), { page: 1, size: 25 });
    assert.ok(list.ok && list.data.rows.length === 1 && list.data.rows[0]!.id === dmId);
    const conns = await listConnections(deps, actor("staff"));
    assert.ok(conns.ok && conns.data.length === 0, "a conversation grant does not reveal the connection card");
    assert.ok((await revokeAccess(deps, actor("owner"), conn.c1, g.data.grantId)).ok);
  });
});

describe("group mode governance (database)", () => {
  it("monitor without consent is refused by the database itself", async () => {
    const gb = await groupId(conn.c1, GROUP_B);
    const r = await db.rpc("zp_update_group", { p_actor: users.owner.id, p_connection_id: conn.c1, p_group_id: gb, p_action: "set_mode", p_mode: "monitor", p_note: null });
    assert.equal(r.data.error, "consent_required");
    const direct = await db.from("zalo_personal_groups").update({ mode: "monitor" }).eq("id", gb);
    assert.ok(direct.error, "CHECK constraint holds even for a raw update");
  });
  it("interactive is refused (no verified sending path), even with consent", async () => {
    const ga = await groupId(conn.c1, GROUP_A);
    const r = await db.rpc("zp_update_group", { p_actor: users.owner.id, p_connection_id: conn.c1, p_group_id: ga, p_action: "set_mode", p_mode: "interactive", p_note: null });
    assert.equal(r.data.error, "interactive_not_available");
    const s = await updateGroup(deps, actor("owner"), ga, { action: "set_mode", mode: "interactive" });
    assert.equal(!s.ok && s.code, "interactive_not_available");
  });
  it("mode change + audit row in the same transaction; audit is append-only", async () => {
    const ga = await groupId(conn.c1, GROUP_A);
    const r = await updateGroup(deps, actor("owner"), ga, { action: "set_mode", mode: "mention_only" });
    assert.ok(r.ok && r.data.changed);
    const back = await updateGroup(deps, actor("owner"), ga, { action: "set_mode", mode: "monitor" });
    assert.ok(back.ok);
    const { data: audit } = await db.from("zalo_personal_audit_log").select("id, action, actor_user_id, details").eq("connection_id", conn.c1).eq("target_id", ga).order("id");
    assert.deepEqual(audit?.map((a) => [a.action, a.details.from, a.details.to]).slice(-2), [["group.mode_changed", "monitor", "mention_only"], ["group.mode_changed", "mention_only", "monitor"]]);
    assert.ok(audit?.every((a) => a.actor_user_id === users.owner.id));
    const tamper = await db.from("zalo_personal_audit_log").update({ details: { from: "x" } }).eq("id", audit![0]!.id);
    assert.ok(tamper.error, "audit rows cannot be edited");
  });
  it("withdrawing consent forces disabled; new messages are then rejected by ingestion", async () => {
    const ga = await groupId(conn.c1, GROUP_A);
    const r = await updateGroup(deps, actor("owner"), ga, { action: "withdraw_consent" });
    assert.ok(r.ok && r.data.mode === "disabled");
    const res = await ingest(conn.w1, ACCOUNT_1, [event("group", GROUP_A, "sau khi rút", new Date())]);
    assert.equal(res[0]!.reason, "group_disabled");
    // restore for the next tests
    await updateGroup(deps, actor("owner"), ga, { action: "grant_consent", note: "đồng ý lại (test)", confirm: true });
    assert.ok((await updateGroup(deps, actor("owner"), ga, { action: "set_mode", mode: "monitor" })).ok);
  });
});

describe("messages, search, sync", () => {
  it("history: keyset pages of 10, newest first, no duplicates; HTML kept as plain text", async () => {
    const ga = await conversationId(conn.c1, GROUP_A);
    const ids: string[] = [];
    let cursor: { beforeAt: string; beforeId: string } | undefined;
    let last = Infinity;
    for (let i = 0; i < 10; i++) {
      const r = await listMessages(deps, actor("owner"), ga, { limit: 10, ...cursor });
      assert.ok(r.ok);
      for (const m of r.data.rows) {
        const t = Date.parse(m.at);
        assert.ok(t <= last, "ordered newest first");
        last = t;
        ids.push(m.id);
      }
      if (!r.data.nextCursor) break;
      cursor = r.data.nextCursor;
    }
    assert.equal(ids.length, new Set(ids).size);
    assert.equal(ids.length, 35, "every stored message of group A (the pre-consent one was never stored)");
    const all = await listMessages(deps, actor("owner"), ga, { limit: 100 });
    assert.ok(all.ok);
    assert.equal(all.data.rows.find((m) => m.text?.includes("<script>"))?.text, XSS);
  });
  it("search: scope + escaped LIKE (a literal % does not match everything) + sender filter", async () => {
    const range = { from: vnDate(new Date(Date.now() - 86_400_000)), to: vnDate(), limit: 50 };
    const pct = await searchMessages(deps, actor("owner"), { ...range, text: "100%" });
    assert.ok(pct.ok);
    assert.equal(pct.data.rows.length, 1);
    const under = await searchMessages(deps, actor("owner"), { ...range, text: "phí_ship" });
    assert.ok(under.ok && under.data.rows.length === 1);
    const wildcard = await searchMessages(deps, actor("owner"), { ...range, text: "%%" });
    assert.ok(wildcard.ok && wildcard.data.rows.length === 0);
    const sender = await searchMessages(deps, actor("owner"), { ...range, senderId: FRIEND });
    assert.ok(sender.ok && sender.data.rows.length > 0 && sender.data.rows.every((m) => m.senderId === FRIEND));
    const other = await searchMessages(deps, actor("owner"), { ...range, text: "chủ 2" });
    assert.ok(other.ok && other.data.rows.length === 0, "never another owner's messages");
  });
  it("status history records state changes only (trigger on sync_state)", async () => {
    const before = (await db.from("zalo_personal_status_events").select("id", { count: "exact", head: true }).eq("worker_id", conn.w1)).count ?? 0;
    await heartbeat(conn.w1, ACCOUNT_1, { sessionState: "authenticated", listenerState: "active" });
    const same = (await db.from("zalo_personal_status_events").select("id", { count: "exact", head: true }).eq("worker_id", conn.w1)).count ?? 0;
    assert.equal(same, before, "an identical heartbeat adds nothing");
    await heartbeat(conn.w1, ACCOUNT_1, { sessionState: "authenticated", listenerState: "reconnecting" });
    await heartbeat(conn.w1, ACCOUNT_1, { sessionState: "authenticated", listenerState: "active" });
    const sync = await getSync(deps, actor("owner"), conn.c1, { page: 1, size: 5 });
    assert.ok(sync.ok);
    assert.equal(sync.data.statusEvents.length, before + 2);
    assert.deepEqual(sync.data.statusEvents.slice(0, 2).map((e) => e.listenerState), ["active", "reconnecting"]);
    assert.equal(sync.data.statusEvents.at(-1)!.kind, "first_seen");
    assert.equal(sync.data.connection.health.situation, "ok");
    assert.ok(sync.data.events.total >= 40 && sync.data.events.rows.length === 5);
  });
  it("worker reporting not logged in → auth_required on the connection", async () => {
    await heartbeat(conn.w1, ACCOUNT_1, { sessionState: "unauthenticated", listenerState: "error", lastErrorCategory: "no_session" });
    const r = await listConnections(deps, actor("owner"));
    assert.ok(r.ok);
    assert.deepEqual([r.data[0]!.health.health, r.data[0]!.health.situation], ["auth_required", "not_logged_in"]);
    await heartbeat(conn.w1, ACCOUNT_1, { sessionState: "authenticated", listenerState: "active" });
  });
  it("view models never carry the worker secret, a session or the full account id", async () => {
    const all = JSON.stringify([await listConnections(deps, actor("owner")), await getSync(deps, actor("owner"), conn.c1, { page: 1, size: 25 }), await getOverview(deps, actor("owner"))]);
    const { data: w } = await db.from("zalo_personal_workers").select("secret_encrypted").eq("id", conn.w1).single();
    assert.ok(!all.includes(w!.secret_encrypted as string));
    assert.doesNotMatch(all, /secret|cookie|session_encrypted|imei/i);
    assert.ok(!all.includes(ACCOUNT_1), "account id masked");
  });
});

describe("RLS: browser roles get nothing", () => {
  it("anon and a signed-in user cannot read the new tables or call the functions", async () => {
    const anon = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const authed = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error: se } = await authed.auth.signInWithPassword({ email: users.owner.email, password: PASSWORD });
    assert.equal(se, null);
    for (const client of [anon, authed]) {
      for (const t of ["zalo_personal_access_grants", "zalo_personal_audit_log", "zalo_personal_status_events", "zalo_personal_messages", "zalo_personal_conversations"]) {
        const { data, error } = await client.from(t).select("*").limit(1);
        assert.ok(error || (data ?? []).length === 0, `${t} must not be readable`);
      }
      const scope = { p_full: [conn.c1], p_group: [], p_ids: [] };
      const rpc = await client.rpc("zp_dashboard_search", { ...scope, p_text: null, p_conversation_id: null, p_sender: null, p_type: null, p_from: "2020-01-01T00:00:00Z", p_to: "2100-01-01T00:00:00Z", p_limit: 5 });
      assert.ok(rpc.error, "zp_dashboard_search not executable");
      const upd = await client.rpc("zp_update_group", { p_actor: users.owner.id, p_connection_id: conn.c1, p_group_id: randomUUID(), p_action: "set_mode", p_mode: "disabled", p_note: null });
      assert.ok(upd.error, "zp_update_group not executable");
    }
  });
});
