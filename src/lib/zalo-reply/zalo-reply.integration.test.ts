// ============================================================
// PHASE 04.5 — integration tests against the LOCAL Supabase (00001 → 00079).
// Real Phase 02 ingestion, real 00079 functions, the real reply tick (Phase 05
// assistant with the real tool registry + Phase 04 memory, AI OFF → no model
// call), the real dashboard service and the real HMAC outbound endpoint.
// No Zalo message is ever sent: the "worker" here is the test calling claim /
// report directly.
// Run: node --env-file=.env.local --test src/lib/zalo-reply/zalo-reply.integration.test.ts
// ============================================================
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getAiConfig } from "../ai-assistant/config.ts";
import { FakeAiProvider } from "../ai-assistant/fake-provider.ts";
import { getSystemAssistantConfig } from "../ai-system/config.ts";
import { systemDemoScript } from "../ai-system/fake-script.ts";
import { SupabaseSystemStore } from "../ai-system/supabase-store.ts";
import { createDefaultRegistry } from "../ai-system/tools/index.ts";
import { encryptSecret, parseEncryptionKey } from "../security/secrets.ts";
import { SupabaseAiStore } from "../zalo-personal/ai/supabase-store.ts";
import { getZaloPersonalIngestConfig, workerSecretContext } from "../zalo-personal/config.ts";
import { SupabaseDashboardStore } from "../zalo-personal/dashboard/supabase-store.ts";
import type { IngestDeps } from "../zalo-personal/ingest.ts";
import { generateWorkerSecret, HEADER, newNonce, secretKeyBytes, sign } from "../zalo-personal/signing.ts";
import { SupabaseZaloPersonalStore } from "../zalo-personal/supabase-store.ts";
import { getReplyConfig, type ReplyConfig } from "./config.ts";
import { runReplyTick, type EngineDeps } from "./engine.ts";
import { handleOutbound } from "./outbound.ts";
import { actOnDraft, control, createLinkCode, getDraft, getSettings, listDrafts, saveSettings, type ReviewDeps } from "./service.ts";
import { SupabaseReplyStore } from "./supabase-store.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (never production)");
const db: SupabaseClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const anon: SupabaseClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
const encKey = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);
const store = new SupabaseReplyStore(db);

const RUN = randomBytes(3).toString("hex");
const T0 = Date.now();
const ACC1 = `91${T0}`.slice(0, 17);
const ACC2 = `92${T0}`.slice(0, 17);
const G1 = `63${T0}1`.slice(0, 18);
const U_STAFF = `71${T0}1`.slice(0, 18); // linked → staff
const U_ADMIN = `71${T0}2`.slice(0, 18); // linked → owner (admin)
const U_STRANGER = `71${T0}3`.slice(0, 18); // never linked
const U_LOCK = `71${T0}4`.slice(0, 18); // linked → locked later

type U = "owner" | "staff" | "manager" | "reader" | "owner2" | "locked";
const users: Record<U, string> = { owner: "", staff: "", manager: "", reader: "", owner2: "", locked: "" };
const created = { users: [] as string[], connections: [] as string[] };
const ids = { c1: "", c2: "", w1: "", w2: "", g1: "", conv: "", dmStaff: "", dmAdmin: "" };
const secrets = { w1: "" };

const cfg = (env: Record<string, string> = {}): ReplyConfig => ({ ...getReplyConfig({ PERSONAL_REPLY_ENABLED: "true", PERSONAL_SEND_ENABLED: "true", ...env }), scanLagMs: 0 });

function engine(env: Record<string, string> = {}): EngineDeps {
  const systemStore = new SupabaseSystemStore(db);
  const aiOff = getAiConfig({ AI_ENABLED: "false", NODE_ENV: "test" });
  return {
    store,
    config: cfg(env),
    identity: systemStore,
    system: { db, store: systemStore, identityStore: systemStore, registry: createDefaultRegistry(), aiConfig: aiOff, config: getSystemAssistantConfig({ AI_SYSTEM_PERSONAL_DRAFTS_ENABLED: "true" }), flags: { adsRealData: false }, provider: () => new FakeAiProvider(systemDemoScript, "fake") },
    memory: { dashboard: new SupabaseDashboardStore(db), store: new SupabaseAiStore(db), config: aiOff, provider: () => new FakeAiProvider(systemDemoScript, "fake") },
    workerId: `it-reply-${RUN}`,
  };
}
const review = (env: Record<string, string> = {}): ReviewDeps => ({ store, dashboard: new SupabaseDashboardStore(db), identity: new SupabaseSystemStore(db), config: cfg(env) });
const actorOf = (k: U, role: "admin" | "staff" = k === "owner" ? "admin" : "staff") => ({ userId: users[k], role });

async function createUser(key: U, role: "admin" | "staff") {
  const { data, error } = await db.auth.admin.createUser({ email: `t45-${key}-${RUN}@example.test`, password: `Pw-${randomBytes(8).toString("hex")}`, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${error?.message}`);
  created.users.push(data.user.id);
  await db.from("profiles").update({ is_active: true, role, full_name: `T45 ${key}` }).eq("id", data.user.id);
  users[key] = data.user.id;
}

async function connection(key: string, owner: string, account: string) {
  const { data: c, error } = await db.from("zalo_personal_connections").insert({ connection_key: `t45-${key}-${RUN}`, owner_user_id: owner, direct_message_mode: "content" }).select("id").single();
  if (error) throw new Error(error.message);
  created.connections.push(c.id);
  const workerId = randomUUID();
  const secret = generateWorkerSecret();
  await db.from("zalo_personal_workers").insert({ id: workerId, worker_key: `t45w-${key}-${RUN}`, connection_id: c.id, secret_encrypted: encryptSecret(secret, encKey, workerSecretContext(workerId)) });
  const hb = await db.rpc("zp_record_heartbeat", { p_worker_id: workerId, p_account_id: account, p_state: { workerVersion: "t", workerStartedAt: new Date().toISOString(), sessionState: "authenticated", listenerState: "active", lastMessageReceivedAt: null, lastDeliveryOkAt: null, outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastErrorCategory: null } });
  if (hb.error || hb.data?.ok !== true) throw new Error("heartbeat");
  return { id: c.id as string, workerId, secret };
}

let seq = 0;
const ext: Record<string, string> = {};
function ev(key: string, type: "group" | "user", conv: string, sender: string, text: string, o: { mentionBot?: boolean; self?: boolean } = {}) {
  seq++;
  ext[key] = `t45${RUN}${seq}`;
  const mentions = o.mentionBot ? [{ uid: ACC1, pos: 0, len: 4, kind: "user" }] : [];
  const at = new Date().toISOString();
  return { eventKey: createHash("sha256").update(`t45|${RUN}|${seq}`).digest("hex"), kind: "message", conversationType: type, conversationId: conv, externalMessageId: ext[key], senderId: sender, messageType: "text", text, textLength: text.length, mentions, mentionsSelf: !!o.mentionBot, isSelf: !!o.self, subtype: null, sentAt: at, receivedAt: at };
}
async function ingest(workerId: string, account: string, evs: unknown[]) {
  const { data, error } = await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: account, p_events: evs });
  if (error || data?.ok !== true) throw new Error(`ingest ${error?.message ?? JSON.stringify(data)}`);
}
const messageId = async (k: string) => (await db.from("zalo_personal_messages").select("id").eq("external_message_id", ext[k]).single()).data!.id as string;
const draftFor = async (k: string) => (await db.from("zalo_personal_reply_drafts").select("*").eq("source_message_id", await messageId(k)).maybeSingle()).data as Record<string, unknown> | null;
const inboundFor = async (k: string) => (await db.from("zalo_personal_reply_inbound").select("*").eq("message_id", await messageId(k)).maybeSingle()).data as Record<string, unknown> | null;
const claim = (workerId = ids.w1, account = ACC1, autoEnabled = false, cap = 100) => store.claim(workerId, account, 60, cap, autoEnabled);
/** a fresh, already approved group draft (bypasses the pipeline: inbound + draft rows directly) */
async function seedQueued(key: string, sender = U_STAFF, conv = ids.conv): Promise<string> {
  await ingest(ids.w1, ACC1, [ev(key, "group", G1, sender, `@Bot câu hỏi ${key}`, { mentionBot: true })]);
  const mid = await messageId(key);
  const inb = (await db.from("zalo_personal_reply_inbound").insert({ connection_id: ids.c1, conversation_id: conv, message_id: mid, sender_external_id: sender, trigger: "mention", status: "done" }).select("id").single()).data!.id as string;
  const d = (await db.from("zalo_personal_reply_drafts").insert({ connection_id: ids.c1, conversation_id: conv, conversation_type: "group", inbound_id: inb, source_message_id: mid, asker_external_id: sender, asker_user_id: sender === U_STAFF ? users.staff : null, audience: "group", kind: "ai_answer", pipeline: "system", status: "queued", approval: "manual", approved_by: users.owner, approved_at: new Date().toISOString(), original_text: `Trả lời ${key}`, text: `Trả lời ${key}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }).select("id").single()).data!.id as string;
  return d;
}
/** settles every queued / sending draft of c1 so the next test starts clean */
async function settleQueue() {
  await db.from("zalo_personal_reply_drafts").update({ status: "cancelled" }).eq("connection_id", ids.c1).in("status", ["queued", "pending_approval"]);
  await db.from("zalo_personal_reply_drafts").update({ status: "failed", lease_until: null }).eq("connection_id", ids.c1).eq("status", "sending");
}

before(async () => {
  await createUser("owner", "admin");
  for (const k of ["staff", "manager", "reader", "owner2", "locked"] as const) await createUser(k, "staff");
  const c1 = await connection("c1", users.owner, ACC1);
  const c2 = await connection("c2", users.owner2, ACC2);
  Object.assign(ids, { c1: c1.id, w1: c1.workerId, c2: c2.id, w2: c2.workerId });
  secrets.w1 = c1.secret;
  // identities (Phase 05 mapping, as created by LINK <mã>)
  for (const [uid, user] of [[U_STAFF, users.staff], [U_ADMIN, users.owner], [U_LOCK, users.locked]] as const) {
    await db.from("ai_channel_identities").insert({ channel: "zalo_personal", connection_id: ids.c1, external_user_id: uid, internal_user_id: user, verified_via: "link_code" });
  }
  // grants: manager = manage, reader = read
  for (const [k, level] of [["manager", "manage"], ["reader", "read"]] as const) {
    const g = await db.rpc("zp_grant_access", { p_actor: users.owner, p_connection_id: ids.c1, p_grantee: users[k], p_scope: "connection", p_conversation_id: null, p_level: level, p_note: "test 04.5" });
    if (g.error || g.data?.ok !== true) throw new Error(`grant ${JSON.stringify(g.data ?? g.error)}`);
  }
  // group: register by a first event, then consent + mention_only
  await ingest(ids.w1, ACC1, [ev("hello", "group", G1, U_STAFF, "xin chào")]);
  ids.g1 = (await db.from("zalo_personal_groups").select("id").eq("connection_id", ids.c1).eq("external_group_id", G1).single()).data!.id;
  await db.rpc("zp_update_group", { p_actor: users.owner, p_connection_id: ids.c1, p_group_id: ids.g1, p_action: "grant_consent", p_mode: null, p_note: "nhóm đồng ý thử bot (test)" });
  await db.rpc("zp_update_group", { p_actor: users.owner, p_connection_id: ids.c1, p_group_id: ids.g1, p_action: "set_mode", p_mode: "mention_only", p_note: null });
  // first tick initializes the scan cursors at now(): older messages are NEVER answered
  await runReplyTick(engine());
});

after(async () => {
  for (const id of created.connections) {
    for (const t of ["zalo_personal_reply_audit", "zalo_personal_reply_drafts", "zalo_personal_reply_inbound", "zalo_personal_reply_allowlist", "zalo_personal_reply_blocks", "zalo_personal_reply_scan_state", "zalo_personal_reply_settings", "ai_channel_identities"]) await db.from(t).delete().eq("connection_id", id);
    for (const t of ["zalo_personal_audit_log", "zalo_personal_access_grants", "zalo_personal_status_events", "zalo_personal_messages", "zalo_personal_ingestion_events", "zalo_personal_conversations", "zalo_personal_groups", "zalo_personal_sync_state", "zalo_personal_workers"]) await db.from(t).delete().eq("connection_id", id);
    await db.from("zalo_personal_connections").delete().eq("id", id);
  }
  await db.from("zalo_personal_reply_audit").delete().is("connection_id", null).in("actor_user_id", created.users);
  await db.from("zalo_personal_reply_control").update({ emergency_stop: false, changed_by: null, changed_at: null, reason: null }).eq("id", 1);
  for (const u of created.users) {
    await db.from("ai_system_requests").delete().eq("user_id", u);
    await db.from("ai_request_usage").delete().eq("user_id", u);
    await db.from("ai_identity_link_codes").delete().eq("internal_user_id", u);
    await db.auth.admin.deleteUser(u);
  }
});

// ------------------------------------------------------------------ router + pipeline
describe("inbound router → drafts (real tick, AI off)", () => {
  before(async () => {
    await ingest(ids.w1, ACC1, [
      ev("q_mention", "group", G1, U_STAFF, "@Bot công nợ là gì?", { mentionBot: true }),
      ev("chatter", "group", G1, U_STAFF, "mai giao hàng nhé"),
      ev("fake_at", "group", G1, U_STAFF, "@Bot ơi công nợ là gì"), // text only, no metadata (not stored in mention_only)
      ev("self", "group", G1, ACC1, "@Bot tự hỏi", { mentionBot: true, self: true }),
      ev("q_dm_staff", "user", U_STAFF, U_STAFF, "công nợ là gì?"),
      ev("q_dm_admin", "user", U_ADMIN, U_ADMIN, "công nợ nhà cung cấp hôm nay"),
      ev("q_dm_stranger", "user", U_STRANGER, U_STRANGER, "cho hỏi công nợ"),
    ]);
    ids.conv = (await db.from("zalo_personal_conversations").select("id").eq("connection_id", ids.c1).eq("external_conversation_id", G1).single()).data!.id;
    const r = await runReplyTick(engine());
    assert.notEqual(r.status, "error", JSON.stringify(r.stats));
  });

  it("only messages that CALL the bot are recorded; chatter, text '@Bot' and own messages are not", async () => {
    assert.equal((await inboundFor("q_mention"))?.trigger, "mention");
    const chatter = await db.from("zalo_personal_messages").select("id").eq("external_message_id", ext.chatter!);
    assert.equal(chatter.data?.length ?? 0, 0, "mention_only: chatter is not even stored");
    assert.equal(await inboundFor("self"), null);
    const fake = await db.from("zalo_personal_messages").select("id").eq("external_message_id", ext.fake_at!);
    assert.equal(fake.data?.length ?? 0, 0, "mention_only ingestion never stored the text-only '@Bot'");
    assert.equal((await inboundFor("q_dm_staff"))?.trigger, "direct");
  });

  it("drafts: linked askers get pending_approval drafts computed AS THEM; unlinked 1-1 → skipped (help off)", async () => {
    const g = await draftFor("q_mention");
    assert.equal(g?.status, "pending_approval");
    assert.equal(g?.asker_user_id, users.staff);
    assert.equal(g?.audience, "group");
    const dmAdmin = await draftFor("q_dm_admin");
    assert.equal(dmAdmin?.asker_user_id, users.owner);
    assert.equal(dmAdmin?.audience, "private");
    assert.equal(await draftFor("q_dm_stranger"), null);
    assert.equal((await inboundFor("q_dm_stranger"))?.reason, "unlinked");
  });

  it("group draft never contains business figures (audience group → knowledge only)", async () => {
    const g = await draftFor("q_mention");
    assert.ok(!(g!.required_permissions as string[]).some((p) => p !== "ai_system:use"), JSON.stringify(g!.required_permissions));
  });

  it("re-running the tick creates nothing new (inbound UNIQUE message_id, draft UNIQUE inbound_id)", async () => {
    const before = (await db.from("zalo_personal_reply_drafts").select("id", { count: "exact", head: true }).eq("connection_id", ids.c1)).count;
    await db.from("zalo_personal_reply_scan_state").update({ cursor_at: new Date(T0 - 60_000).toISOString() }).eq("connection_id", ids.c1); // replay the scan
    await runReplyTick(engine());
    const afterCount = (await db.from("zalo_personal_reply_drafts").select("id", { count: "exact", head: true }).eq("connection_id", ids.c1)).count;
    assert.equal(afterCount, before);
  });
});

// ------------------------------------------------------------------ review
describe("review (service + Phase 03 scope)", () => {
  it("owner sees group + 1-1 drafts; manage grant sees group only; read grant sees nothing", async () => {
    const owner = await listDrafts(review(), actorOf("owner"), { status: "review" });
    const manager = await listDrafts(review(), actorOf("manager"), { status: "review" });
    const reader = await listDrafts(review(), actorOf("reader"), { status: "review" });
    assert.ok(owner.ok && manager.ok && reader.ok);
    const mine = (rows: Array<{ conversation: { type: string } }>) => rows.map((r) => r.conversation.type);
    assert.ok(mine(owner.data.rows).includes("user") && mine(owner.data.rows).includes("group"));
    assert.ok(manager.data.rows.length > 0 && mine(manager.data.rows).every((t) => t === "group"));
    assert.equal(reader.data.rows.length, 0);
  });

  it("an out-of-scope draft is not_found (no existence leak); owner2 cannot act on c1", async () => {
    const d = await draftFor("q_dm_admin");
    const r = await getDraft(review(), actorOf("manager"), String(d!.id));
    assert.equal(r.ok, false);
    const x = await actOnDraft(review(), actorOf("owner2"), String(d!.id), { action: "approve", version: 1 });
    assert.ok(!x.ok && x.error === "not_found");
  });

  it("edit keeps the original; stale version → conflict; approve → queued + audit trail", async () => {
    const d = await draftFor("q_mention");
    const id = String(d!.id);
    const e = await actOnDraft(review(), actorOf("owner"), id, { action: "edit", version: Number(d!.version), text: "Công nợ: số tiền còn phải trả nhà cung cấp." });
    assert.ok(e.ok);
    const stale = await actOnDraft(review(), actorOf("owner"), id, { action: "approve", version: Number(d!.version) });
    assert.ok(!stale.ok && stale.code === "version_conflict");
    const ok = await actOnDraft(review(), actorOf("owner"), id, { action: "approve", version: e.data.version });
    assert.ok(ok.ok && ok.data.status === "queued");
    const row = (await db.from("zalo_personal_reply_drafts").select("status, approval, approved_by, edited, original_text, text").eq("id", id).single()).data!;
    assert.deepEqual([row.status, row.approval, row.approved_by, row.edited], ["queued", "manual", users.owner, true]);
    assert.notEqual(row.original_text, row.text);
    const audit = (await db.from("zalo_personal_reply_audit").select("action").eq("draft_id", id).order("id")).data!.map((a) => a.action);
    assert.deepEqual(audit, ["draft.created", "draft.edit", "draft.approve"]);
    const again = await actOnDraft(review(), actorOf("owner"), id, { action: "edit", version: ok.data.version, text: "x" });
    assert.ok(!again.ok && again.code === "invalid_transition");
  });

  it("reject / cancel / expired drafts cannot be approved", async () => {
    const d = await draftFor("q_dm_staff");
    const id = String(d!.id);
    await db.from("zalo_personal_reply_drafts").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", id);
    const r = await actOnDraft(review(), actorOf("owner"), id, { action: "approve", version: Number(d!.version) });
    assert.ok(!r.ok && r.code === "expired");
    assert.equal((await db.from("zalo_personal_reply_drafts").select("status").eq("id", id).single()).data!.status, "expired");
  });
});

// ------------------------------------------------------------------ outbound
describe("outbound queue: claim / report (00079 gates)", () => {
  it("HMAC endpoint end-to-end: the worker of c1 claims the approved group reply; destination = stored group id", async () => {
    const ingestDeps: IngestDeps = { store: new SupabaseZaloPersonalStore(db), config: { ...getZaloPersonalIngestConfig({ ZALO_PERSONAL_INGEST_ENABLED: "true" }) }, secretKey: () => secretKeyBytes(secrets.w1), log: () => {} };
    const body = JSON.stringify({ v: 1, connectionKey: `t45-c1-${RUN}`, accountId: ACC1, listenerState: "active" });
    const path = "/api/internal/zalo-personal/outbound/claim";
    const ts = String(Date.now());
    const nonce = newNonce();
    const workerKey = `t45w-c1-${RUN}`;
    const h: Record<string, string> = { [HEADER.worker]: workerKey, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sign(secretKeyBytes(secrets.w1), { method: "POST", path, workerKey, timestamp: ts, nonce, rawBody: body }) };
    const r = await handleOutbound("claim", { method: "POST", path, header: (n) => h[n] ?? null, rawBody: body }, { ingest: ingestDeps, config: cfg(), store, log: () => {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const job = r.body.job as Record<string, string>;
    assert.equal(job.threadId, G1);
    assert.equal(job.threadType, "group");
    assert.equal(job.text, "Công nợ: số tiền còn phải trả nhà cung cấp.");
    const d = await draftFor("q_mention");
    assert.equal(d?.status, "sending");
    // report sent → sent; group sending path verified by this MANUAL reply
    const rep = await store.report(ids.w1, job.draftId!, job.claimToken!, "sent", "8100000000001", null);
    assert.deepEqual(rep, { ok: true, status: "sent", changed: true });
    assert.ok((await db.from("zalo_personal_groups").select("send_verified_at").eq("id", ids.g1).single()).data!.send_verified_at);
    assert.deepEqual(await store.report(ids.w1, job.draftId!, job.claimToken!, "sent", "8100000000001", null), { ok: true, status: "sent", changed: false }, "repeated report changes nothing");
    assert.equal((await store.report(ids.w1, job.draftId!, randomUUID(), "sent", null, null)).ok, false, "wrong claim token");
  });

  it("a worker can never claim another connection's reply; a wrong account is refused", async () => {
    await settleQueue();
    await seedQueued("iso");
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("connection_id", ids.c1).eq("status", "sent"); // past cooldown
    const other = await claim(ids.w2, ACC2);
    assert.ok(other.ok && other.job === null);
    assert.deepEqual(await claim(ids.w1, ACC2), { ok: false, error: "account_mismatch" });
    const mine = await claim();
    assert.ok(mine.ok && mine.job);
    await store.report(ids.w1, mine.job.draftId, mine.job.claimToken, "sent", "8100000000002", null);
  });

  it("cooldown: a second reply to the same conversation waits (hold), it is not dropped", async () => {
    await settleQueue();
    const id = await seedQueued("cool");
    const r = await claim();
    assert.ok(r.ok && r.job === null && r.reason === "cooldown");
    assert.equal((await db.from("zalo_personal_reply_drafts").select("status, hold_reason").eq("id", id).single()).data!.hold_reason, "cooldown");
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 3_600_000).toISOString(), sending_started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("connection_id", ids.c1).eq("status", "sent");
    const r2 = await claim();
    assert.ok(r2.ok && r2.job?.draftId === id);
    await store.report(ids.w1, r2.job.draftId, r2.job.claimToken, "sent", "8100000000003", null);
  });

  it("emergency stop (global) → nothing is claimed; only an admin can resume", async () => {
    await settleQueue();
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("connection_id", ids.c1).eq("status", "sent");
    await seedQueued("stop");
    assert.ok((await control(review(), actorOf("manager"), { action: "emergency_stop", note: "test" })).ok);
    const r = await claim();
    assert.ok(r.ok && r.job === null && r.reason === "emergency_stop");
    const no = await control(review(), actorOf("manager"), { action: "emergency_resume" });
    assert.ok(!no.ok && no.error === "forbidden");
    assert.ok((await control(review(), actorOf("owner"), { action: "emergency_resume" })).ok);
    const r2 = await claim();
    assert.ok(r2.ok && r2.job);
    // Zalo refuses → failed + the connection is PAUSED until the owner resumes
    await store.report(ids.w1, r2.job.draftId, r2.job.claimToken, "failed", null, "zalo_rejected");
    const st = (await db.from("zalo_personal_reply_settings").select("send_paused, paused_reason").eq("connection_id", ids.c1).single()).data!;
    assert.deepEqual([st.send_paused, st.paused_reason], [true, "zalo_rejected"]);
    await seedQueued("paused");
    const r3 = await claim();
    assert.ok(r3.ok && r3.job === null && r3.reason === "send_paused");
    assert.ok((await control(review(), actorOf("owner"), { action: "resume_sending", connectionId: ids.c1 })).ok);
  });

  it("delivery unknown is never re-queued; an operator confirms it; a lost lease → delivery_unknown", async () => {
    await settleQueue();
    const a = await seedQueued("unk");
    const r = await claim();
    assert.ok(r.ok && r.job?.draftId === a);
    await store.report(ids.w1, a, r.job.claimToken, "unknown", null, "timeout");
    assert.equal((await db.from("zalo_personal_reply_drafts").select("status").eq("id", a).single()).data!.status, "delivery_unknown");
    await db.from("zalo_personal_reply_drafts").update({ sending_started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", a);
    const again = await claim();
    assert.ok(again.ok && again.job?.draftId !== a);
    if (again.ok && again.job) await store.report(ids.w1, again.job.draftId, again.job.claimToken, "sent", null, null);
    const v = (await db.from("zalo_personal_reply_drafts").select("version").eq("id", a).single()).data!.version as number;
    const c = await actOnDraft(review(), actorOf("owner"), a, { action: "confirm_sent", version: v });
    assert.ok(c.ok && c.data.status === "sent");

    // worker restart mid-send: lease runs out, recover() → delivery_unknown
    await settleQueue();
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 3_600_000).toISOString(), sending_started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("connection_id", ids.c1).in("status", ["sent", "delivery_unknown"]);
    const b = await seedQueued("lease");
    const rb = await claim();
    assert.ok(rb.ok && rb.job?.draftId === b);
    await db.from("zalo_personal_reply_drafts").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq("id", b);
    const rec = await store.recover();
    assert.ok(rec.unknown >= 1);
    const row = (await db.from("zalo_personal_reply_drafts").select("status, error_category").eq("id", b).single()).data!;
    assert.deepEqual([row.status, row.error_category], ["delivery_unknown", "lease_expired"]);
    // the late report of the restarted worker is still accepted (unknown → sent)
    assert.equal((await store.report(ids.w1, b, rb.job.claimToken, "sent", "8100000000009", null)).ok, true);
    assert.equal((await db.from("zalo_personal_reply_drafts").select("status").eq("id", b).single()).data!.status, "sent");
  });

  it("not_sent (nothing left the machine) is re-queued up to 3 attempts, then failed", async () => {
    await settleQueue();
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 3_600_000).toISOString(), sending_started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("connection_id", ids.c1).in("status", ["sent", "delivery_unknown"]);
    const id = await seedQueued("retry");
    for (let i = 1; i <= 3; i++) {
      const r = await claim();
      assert.ok(r.ok && r.job?.draftId === id, `attempt ${i}: ${JSON.stringify(r)}`);
      await store.report(ids.w1, id, r.job.claimToken, "not_sent", null, "network");
    }
    assert.equal((await db.from("zalo_personal_reply_drafts").select("status").eq("id", id).single()).data!.status, "failed");
  });

  it("gates re-checked at the last moment: unlinked asker / blocked sender / group disabled → cancelled, never sent", async () => {
    await settleQueue();
    const a = await seedQueued("unlinked");
    await db.from("ai_channel_identities").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("connection_id", ids.c1).eq("external_user_id", U_STAFF);
    const r = await claim();
    assert.ok(r.ok && r.job === null);
    const row = (await db.from("zalo_personal_reply_drafts").select("status, error_category").eq("id", a).single()).data!;
    assert.deepEqual([row.status, row.error_category], ["cancelled", "asker_not_authorized"]);
    await db.from("ai_channel_identities").insert({ channel: "zalo_personal", connection_id: ids.c1, external_user_id: U_STAFF, internal_user_id: users.staff, verified_via: "link_code" });

    const b = await seedQueued("blocked");
    assert.ok((await control(review(), actorOf("owner"), { action: "block_user", connectionId: ids.c1, externalUserId: U_STAFF })).ok);
    assert.equal((await db.from("zalo_personal_reply_drafts").select("status").eq("id", b).single()).data!.status, "cancelled");
    assert.ok((await control(review(), actorOf("owner"), { action: "unblock_user", connectionId: ids.c1, externalUserId: U_STAFF })).ok);

    const c = await seedQueued("disabled");
    await db.rpc("zp_update_group", { p_actor: users.owner, p_connection_id: ids.c1, p_group_id: ids.g1, p_action: "set_mode", p_mode: "monitor", p_note: null });
    await claim();
    assert.equal((await db.from("zalo_personal_reply_drafts").select("error_category").eq("id", c).single()).data!.error_category, "group_not_allowed");
    await db.rpc("zp_update_group", { p_actor: users.owner, p_connection_id: ids.c1, p_group_id: ids.g1, p_action: "set_mode", p_mode: "mention_only", p_note: null });
  });

  it("rate limits: per user per hour, daily per connection, global cap → hold / no job", async () => {
    await settleQueue();
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), sending_started_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }).eq("connection_id", ids.c1).in("status", ["sent", "delivery_unknown"]);
    assert.ok((await saveSettings(review(), actorOf("owner"), { connectionId: ids.c1, perUserPerHour: 1, cooldownSeconds: 10 })).ok);
    const a = await seedQueued("rl1");
    const r1 = await claim();
    assert.ok(r1.ok && r1.job?.draftId === a);
    await store.report(ids.w1, a, r1.job.claimToken, "sent", null, null);
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", a); // past cooldown, within the hour
    await seedQueued("rl2");
    const r2 = await claim();
    assert.ok(r2.ok && r2.job === null && r2.reason === "user_rate_limited", JSON.stringify(r2));
    const g = await claim(ids.w1, ACC1, false, 1);
    assert.ok(g.ok && g.job === null && g.reason === "global_daily_limit");
    assert.ok((await saveSettings(review(), actorOf("owner"), { connectionId: ids.c1, perUserPerHour: 10, dailySendLimit: 1 })).ok);
    const d = await claim();
    assert.ok(d.ok && d.job === null && d.reason === "daily_limit");
    assert.ok((await saveSettings(review(), actorOf("owner"), { connectionId: ids.c1, dailySendLimit: 50, cooldownSeconds: 60 })).ok);
  });

  it("auto-reply only for an allowlisted, interactive, verified group of an 'auto' connection with the flag on", async () => {
    await settleQueue();
    const auto = { PERSONAL_AUTO_REPLY_ENABLED: "true" };
    const refused = await saveSettings(review(), actorOf("owner"), { connectionId: ids.c1, replyMode: "auto" });
    assert.ok(!refused.ok && refused.code === "auto_disabled", "auto refused while the system flag is off");
    assert.ok((await saveSettings(review(auto), actorOf("owner"), { connectionId: ids.c1, replyMode: "auto" })).ok);
    const noNote = await control(review(auto), actorOf("owner"), { action: "allow_conversation", connectionId: ids.c1, conversationId: ids.conv, note: "ok" });
    assert.ok(!noNote.ok && noNote.code === "note_required", "the DB requires a consent note too");
    assert.ok((await control(review(auto), actorOf("owner"), { action: "allow_conversation", connectionId: ids.c1, conversationId: ids.conv, note: "Nhóm thử nghiệm đã đồng ý bot tự trả lời" })).ok);
    // group is still mention_only → auto must not apply
    await ingest(ids.w1, ACC1, [ev("auto1", "group", G1, U_ADMIN, "@Bot công nợ là gì?", { mentionBot: true })]);
    await runReplyTick(engine(auto));
    assert.equal((await draftFor("auto1"))?.status, "pending_approval");
    // interactive (available: send verified by the manual reply above)
    const m = await db.rpc("zp_update_group", { p_actor: users.owner, p_connection_id: ids.c1, p_group_id: ids.g1, p_action: "set_mode", p_mode: "interactive", p_note: null });
    assert.equal(m.data?.ok, true, JSON.stringify(m.data));
    await ingest(ids.w1, ACC1, [ev("auto2", "group", G1, U_ADMIN, "@Bot công nợ là gì?", { mentionBot: true })]);
    await runReplyTick(engine(auto));
    const d = await draftFor("auto2");
    // the definition tool (knowledge, allowed in a group) answers → auto-approved
    assert.equal(d?.response_status, "answered", JSON.stringify(d));
    assert.deepEqual([d!.status, d!.approval], ["queued", "auto"]);
    // the auto flag switched off at send time → cancelled, never sent
    const r = await claim(ids.w1, ACC1, false);
    assert.ok(r.ok && r.job === null);
    assert.equal((await db.from("zalo_personal_reply_drafts").select("status, error_category").eq("id", String(d!.id)).single()).data!.error_category, "auto_not_allowed");
    await control(review(auto), actorOf("owner"), { action: "disallow_conversation", connectionId: ids.c1, conversationId: ids.conv });
    await saveSettings(review(auto), actorOf("owner"), { connectionId: ids.c1, replyMode: "draft_only" });
  });

  it("00080 — 1-1 auto without allowlist: linked asker answered + LINK confirmation queued as 'auto'; stranger gets nothing; claim re-checks", async () => {
    await settleQueue();
    const auto = { PERSONAL_AUTO_REPLY_ENABLED: "true" };
    // cooldown floor is now 5 s (DB CHECK + contract)
    assert.ok((await saveSettings(review(auto), actorOf("owner"), { connectionId: ids.c1, replyMode: "auto", cooldownSeconds: 5, unlinkedHelp: true })).ok);
    const tooLow = await db.from("zalo_personal_reply_settings").update({ cooldown_seconds: 4 }).eq("connection_id", ids.c1);
    assert.ok(tooLow.error, "the DB refuses a cooldown under 5 s");
    const code = await createLinkCode(review(auto), actorOf("manager"));
    assert.ok(code.ok, JSON.stringify(code));
    await ingest(ids.w1, ACC1, [ev("auto_dm", "user", U_ADMIN, U_ADMIN, "công nợ là gì?"), ev("auto_stranger", "user", U_STRANGER, U_STRANGER, "chào shop")]);
    await runReplyTick(engine(auto));
    // the LINK in a later tick (same sender: the order inside one tick is not defined)
    await ingest(ids.w1, ACC1, [ev("auto_link", "user", U_STRANGER, U_STRANGER, `LINK ${code.data.code}`)]);
    await runReplyTick(engine(auto));
    const answer = await draftFor("auto_dm");
    assert.deepEqual([answer?.kind, answer?.status, answer?.approval], ["ai_answer", "queued", "auto"], "the DM is NOT allowlisted and is still automatic");
    assert.equal(await draftFor("auto_stranger"), null, "no guidance draft for a stranger in auto mode");
    assert.equal((await inboundFor("auto_stranger"))?.reason, "unlinked");
    const link = await draftFor("auto_link");
    assert.deepEqual([link?.kind, link?.status, link?.approval], ["link_result", "queued", "auto"]);

    // the claim re-checks (rate windows moved out of the way: earlier tests sent to these chats)
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await db.from("zalo_personal_reply_drafts").update({ sent_at: old, sending_started_at: old }).eq("connection_id", ids.c1).in("status", ["sent", "delivery_unknown"]);
    const first = await claim(ids.w1, ACC1, true);
    assert.ok(first.ok && first.job, JSON.stringify(first));
    assert.equal(first.job.threadType, "user");
    assert.ok([answer!.id, link!.id].includes(first.job.draftId));
    // flag off at send time → the remaining auto draft is cancelled, never sent
    const second = await claim(ids.w1, ACC1, false);
    assert.ok(second.ok && second.job === null);
    const remaining = [answer!.id, link!.id].find((x) => x !== first.job!.draftId)!;
    const r = (await db.from("zalo_personal_reply_drafts").select("status, error_category").eq("id", String(remaining)).single()).data!;
    assert.deepEqual([r.status, r.error_category], ["cancelled", "auto_not_allowed"]);
    await settleQueue();
    await saveSettings(review(auto), actorOf("owner"), { connectionId: ids.c1, replyMode: "draft_only", cooldownSeconds: 60 });
  });

  it("settings page: owner only sees own connections; sent count today; flags reported", async () => {
    const s = await getSettings(review(), actorOf("owner"));
    assert.ok(s.ok);
    assert.ok(s.data.connections.some((c) => c.connectionId === ids.c1));
    assert.ok(!s.data.connections.some((c) => c.connectionId === ids.c2));
    const m = await getSettings(review(), actorOf("manager"));
    assert.ok(m.ok && m.data.connections.length === 0, "a manage grant cannot configure");
    const x = await saveSettings(review(), actorOf("manager"), { connectionId: ids.c1, replyMode: "off" });
    assert.ok(!x.ok && x.error === "not_found");
    // owner2 is STAFF and owns c2: reply settings are admin-only
    const o2 = await getSettings(review(), actorOf("owner2"));
    assert.ok(o2.ok && o2.data.connections.length === 0, "a staff owner sees no settings section");
    const s2 = await saveSettings(review({ PERSONAL_AUTO_REPLY_ENABLED: "true" }), actorOf("owner2"), { connectionId: ids.c2, replyMode: "auto" });
    assert.ok(!s2.ok && s2.error === "not_found", "a staff owner cannot switch their connection to auto");
    const b2 = await control(review(), actorOf("owner2"), { action: "pause_sending", connectionId: ids.c2 });
    assert.ok(!b2.ok && b2.error === "not_found");
  });
});

// ------------------------------------------------------------------ security
describe("security", () => {
  it("anon cannot read reply tables or call reply RPCs", async () => {
    for (const t of ["zalo_personal_reply_drafts", "zalo_personal_reply_inbound", "zalo_personal_reply_settings", "zalo_personal_reply_audit", "zalo_personal_reply_control"]) {
      const r = await anon.from(t).select("*").limit(1);
      assert.ok(r.error || (r.data ?? []).length === 0, t);
    }
    const rpc = await anon.rpc("zp_reply_claim_outbound", { p_worker_id: ids.w1, p_account_id: ACC1, p_lease_seconds: 60, p_global_daily_cap: 100, p_auto_enabled: true });
    assert.ok(rpc.error, "anon RPC must fail");
  });
  it("the reply audit log is append-only", async () => {
    const row = (await db.from("zalo_personal_reply_audit").select("id").eq("connection_id", ids.c1).limit(1).single()).data!;
    const u = await db.from("zalo_personal_reply_audit").update({ action: "tampered" }).eq("id", row.id);
    assert.ok(u.error);
  });
});
