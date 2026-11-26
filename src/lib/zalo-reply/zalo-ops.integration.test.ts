// ============================================================
// PHASE 07 — integration tests against the LOCAL Supabase (… → 00081).
// 1-1 content allowlist, reply modes, per-connection send switch, task
// reminders through the outbound queue, operations snapshot + alerts, and the
// OPS-12 security cases that need the database. The "worker" is the test
// calling claim / report: no Zalo message is ever sent.
// Run: node --env-file=.env.local --test src/lib/zalo-reply/zalo-ops.integration.test.ts
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
import { SupabaseTaskStore } from "../ai-tasks/supabase-store.ts";
import { encryptSecret, parseEncryptionKey } from "../security/secrets.ts";
import { SupabaseAiStore } from "../zalo-personal/ai/supabase-store.ts";
import { workerSecretContext } from "../zalo-personal/config.ts";
import { SupabaseDashboardStore } from "../zalo-personal/dashboard/supabase-store.ts";
import { generateWorkerSecret } from "../zalo-personal/signing.ts";
import { getReplyConfig } from "./config.ts";
import { claimBody } from "./contracts.ts";
import { runReplyTick, type EngineDeps } from "./engine.ts";
import { runOpsCheck } from "./ops.ts";
import { actOnDraft, control, getOperations, getSettings, saveSettings, type OpsDeps, type ReviewDeps } from "./service.ts";
import { SupabaseReplyStore } from "./supabase-store.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (never production)");
const db: SupabaseClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const encKey = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);
const store = new SupabaseReplyStore(db);

const RUN = randomBytes(3).toString("hex");
const T0 = Date.now();
const ACC = `93${T0}`.slice(0, 17);
const U_LINKED = `76${T0}1`.slice(0, 18);
const U_STRANGER = `76${T0}2`.slice(0, 18);
const users = { owner: "", staff: "" };
const ids = { conn: "", worker: "", fresh: "", freshWorker: "", convLinked: "" };

const cfg = (env: Record<string, string> = {}) => ({ ...getReplyConfig({ PERSONAL_REPLY_ENABLED: "true", PERSONAL_SEND_ENABLED: "true", ...env }), scanLagMs: 0 });
function engine(env: Record<string, string> = {}): EngineDeps {
  const sys = new SupabaseSystemStore(db);
  const aiOff = getAiConfig({ AI_ENABLED: "false", NODE_ENV: "test" });
  return {
    store,
    config: cfg(env),
    identity: sys,
    system: { db, store: sys, identityStore: sys, registry: createDefaultRegistry(), aiConfig: aiOff, config: getSystemAssistantConfig({ AI_SYSTEM_PERSONAL_DRAFTS_ENABLED: "true" }), flags: { adsRealData: false }, provider: () => new FakeAiProvider(systemDemoScript, "fake") },
    memory: { dashboard: new SupabaseDashboardStore(db), store: new SupabaseAiStore(db), config: aiOff, provider: () => new FakeAiProvider(systemDemoScript, "fake") },
    workerId: `it-ops-${RUN}`,
  };
}
const review = (env: Record<string, string> = {}): ReviewDeps => ({ store, dashboard: new SupabaseDashboardStore(db), identity: new SupabaseSystemStore(db), config: cfg(env) });
const owner = () => ({ userId: users.owner, role: "admin" as const });

async function createUser(role: "admin" | "staff") {
  const { data, error } = await db.auth.admin.createUser({ email: `t07-${role}-${RUN}@example.test`, password: `Pw-${randomBytes(8).toString("hex")}`, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${error?.message}`);
  await db.from("profiles").update({ is_active: true, role, full_name: `T07 ${role}` }).eq("id", data.user.id);
  return data.user.id;
}
async function connection(key: string, account: string, mode: string) {
  const { data: c, error } = await db.from("zalo_personal_connections").insert({ connection_key: `t07-${key}-${RUN}`, owner_user_id: users.owner, direct_message_mode: mode }).select("id").single();
  if (error) throw new Error(error.message);
  const workerId = randomUUID();
  await db.from("zalo_personal_workers").insert({ id: workerId, worker_key: `t07w-${key}-${RUN}`, connection_id: c.id, secret_encrypted: encryptSecret(generateWorkerSecret(), encKey, workerSecretContext(workerId)) });
  const hb = await db.rpc("zp_record_heartbeat", { p_worker_id: workerId, p_account_id: account, p_state: { workerVersion: "t", workerStartedAt: new Date().toISOString(), sessionState: "authenticated", listenerState: "active", lastMessageReceivedAt: null, lastDeliveryOkAt: null, outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastErrorCategory: null } });
  if (hb.error || hb.data?.ok !== true) throw new Error("heartbeat");
  return { id: c.id as string, workerId };
}
let seq = 0;
const ext: Record<string, string> = {};
function ev(key: string, sender: string, text: string | null, o: { self?: boolean; conv?: string } = {}) {
  seq++;
  ext[key] = `t07${RUN}${seq}`;
  const at = new Date().toISOString();
  const t = text ?? "";
  return { eventKey: createHash("sha256").update(`t07|${RUN}|${seq}`).digest("hex"), kind: "message", conversationType: "user", conversationId: o.conv ?? sender, externalMessageId: ext[key], senderId: o.self ? ACC : sender, messageType: "text", text, textLength: t.length || 13, mentions: [], mentionsSelf: false, isSelf: !!o.self, subtype: null, sentAt: at, receivedAt: at };
}
async function ingest(workerId: string, evs: unknown[]) {
  const { data, error } = await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: ACC, p_events: evs });
  if (error || data?.ok !== true) throw new Error(`ingest ${error?.message ?? JSON.stringify(data)}`);
  return data.results as Array<{ status: string; reason: string | null }>;
}
const message = async (k: string) => (await db.from("zalo_personal_messages").select("id, text_content, content_stored").eq("external_message_id", ext[k]).single()).data!;
const claim = (remindersEnabled: boolean, autoEnabled = false) => store.claim(ids.worker, ACC, 60, 100, autoEnabled, remindersEnabled);

before(async () => {
  users.owner = await createUser("admin");
  users.staff = await createUser("staff");
  const c = await connection("main", ACC, "linked");
  Object.assign(ids, { conn: c.id, worker: c.workerId });
  await db.from("ai_channel_identities").insert({ channel: "zalo_personal", connection_id: ids.conn, external_user_id: U_LINKED, internal_user_id: users.owner, verified_via: "link_code" });
  await runReplyTick(engine()); // creates settings (defaults) + scan cursor
});

after(async () => {
  for (const id of [ids.conn, ids.fresh].filter(Boolean)) {
    for (const t of ["zalo_personal_reply_audit", "zalo_personal_reply_drafts", "zalo_personal_reply_inbound", "zalo_personal_reply_allowlist", "zalo_personal_reply_blocks", "zalo_personal_reply_scan_state", "zalo_personal_reply_settings", "zalo_personal_ops_state", "ai_channel_identities", "ai_tasks"]) await db.from(t).delete().eq("connection_id", id);
    await db.from("user_notifications").delete().eq("connection_id", id);
    for (const t of ["zalo_personal_audit_log", "zalo_personal_status_events", "zalo_personal_messages", "zalo_personal_ingestion_events", "zalo_personal_conversations", "zalo_personal_groups", "zalo_personal_sync_state", "zalo_personal_workers"]) await db.from(t).delete().eq("connection_id", id);
    await db.from("zalo_personal_connections").delete().eq("id", id);
  }
  for (const u of Object.values(users).filter(Boolean)) {
    await db.from("user_notifications").delete().eq("user_id", u);
    await db.from("zalo_personal_reply_audit").delete().is("connection_id", null).eq("actor_user_id", u);
    for (const t of ["ai_system_requests", "ai_request_usage"]) await db.from(t).delete().eq("user_id", u);
    await db.auth.admin.deleteUser(u);
  }
  await db.from("zalo_personal_reply_control").update({ emergency_stop: false, changed_by: null, changed_at: null, reason: null }).eq("id", 1);
});

// ------------------------------------------------------------------ OPS-03: 1-1 content allowlist
describe("1-1 content allowlist (direct_message_mode = linked)", () => {
  it("keeps text ONLY for a linked person, a LINK command and the bot's own reply in a linked chat", async () => {
    await ingest(ids.worker, [
      ev("dm_linked", U_LINKED, "công nợ là gì?"),
      ev("dm_stranger", U_STRANGER, "số tài khoản của shop?"),
      ev("dm_link", U_STRANGER, "LINK ABCD2345"),
      ev("dm_self", U_LINKED, "Trả lời của bot", { self: true, conv: U_LINKED }),
    ]);
    const linked = await message("dm_linked");
    assert.deepEqual([linked.content_stored, linked.text_content], [true, "công nợ là gì?"]);
    const stranger = await message("dm_stranger");
    assert.deepEqual([stranger.content_stored, stranger.text_content], [false, null], "a stranger's private text never reaches the database");
    assert.equal((await message("dm_link")).text_content, "LINK ABCD2345", "the LINK command is kept so the person can link");
    assert.equal((await message("dm_self")).text_content, "Trả lời của bot");
    ids.convLinked = (await db.from("zalo_personal_conversations").select("id").eq("connection_id", ids.conn).eq("external_conversation_id", U_LINKED).single()).data!.id;
  });
  it("content_stored = the text really is stored; a worker that strips text is reported (text_not_sent)", async () => {
    const r = await ingest(ids.worker, [ev("dm_stripped", U_LINKED, null)]);
    assert.equal(r[0]!.reason, "text_not_sent");
    const m = await message("dm_stripped");
    assert.deepEqual([m.content_stored, m.text_content], [false, null], "no more 'stored' without text (the 2026-11-26 incident)");
  });
  it("only an admin owner switches the mode; the value is validated", async () => {
    const bad = await control(review(), owner(), { action: "set_direct_mode", connectionId: ids.conn, directMessageMode: "everything" as never });
    assert.ok(!bad.ok);
    const staff = await control(review(), { userId: users.staff, role: "staff" }, { action: "set_direct_mode", connectionId: ids.conn, directMessageMode: "content" });
    assert.ok(!staff.ok && staff.error === "not_found");
    const s = await getSettings(review(), owner());
    assert.ok(s.ok && s.data.connections.find((c) => c.connectionId === ids.conn)?.directMessageMode === "linked");
  });
});

// ------------------------------------------------------------------ OPS-02: modes + send switch
describe("reply modes and the per-connection send switch", () => {
  it("a new connection: draft_only, sending OFF, auto scopes OFF", async () => {
    const f = await connection("fresh", `94${T0}`.slice(0, 17), "metadata");
    Object.assign(ids, { fresh: f.id, freshWorker: f.workerId });
    await runReplyTick(engine());
    const st = (await db.from("zalo_personal_reply_settings").select("reply_mode, send_enabled, auto_direct, auto_groups").eq("connection_id", ids.fresh).single()).data!;
    assert.deepEqual(st, { reply_mode: "draft_only", send_enabled: false, auto_direct: "off", auto_groups: false });
  });
  it("draft_only: a draft is created but can never be approved for sending", async () => {
    await ingest(ids.worker, [ev("q_draft_only", U_LINKED, "công nợ là gì?")]);
    await runReplyTick(engine());
    const d = (await db.from("zalo_personal_reply_drafts").select("id, status, version").eq("source_message_id", (await message("q_draft_only")).id).single()).data!;
    assert.equal(d.status, "pending_approval");
    const a = await actOnDraft(review(), owner(), d.id, { action: "approve", version: d.version });
    assert.ok(!a.ok, "approve refused in draft_only");
    assert.equal((await db.from("zalo_personal_reply_drafts").select("status").eq("id", d.id).single()).data!.status, "pending_approval");
  });
  it("manual_approval + sending OFF → approved reply stays queued, the worker gets 'connection_send_off'", async () => {
    assert.ok((await saveSettings(review(), owner(), { connectionId: ids.conn, replyMode: "manual_approval" })).ok);
    const d = (await db.from("zalo_personal_reply_drafts").select("id, version").eq("source_message_id", (await message("q_draft_only")).id).single()).data!;
    assert.ok((await actOnDraft(review(), owner(), d.id, { action: "approve", version: d.version })).ok);
    const c = await claim(false);
    assert.ok(c.ok && c.job === null && c.reason === "connection_send_off", JSON.stringify(c));
  });
  it("feature-flag bypass: sendEnabled cannot be switched on while PERSONAL_SEND_ENABLED is off", async () => {
    const noSend: ReviewDeps = { ...review(), config: { ...getReplyConfig({ PERSONAL_REPLY_ENABLED: "true" }), scanLagMs: 0 } };
    const r = await saveSettings(noSend, owner(), { connectionId: ids.conn, sendEnabled: true });
    assert.ok(!r.ok && r.code === "send_disabled");
    assert.ok((await saveSettings(review(), owner(), { connectionId: ids.conn, sendEnabled: true })).ok);
    const c = await claim(false);
    assert.ok(c.ok && c.job?.threadId === U_LINKED, JSON.stringify(c));
    await store.report(ids.worker, c.job!.draftId, c.job!.claimToken, "sent", "8100000000001", null);
  });
  it("mode switched to disabled after approval → queued reply is held, not sent", async () => {
    await ingest(ids.worker, [ev("q_hold", U_LINKED, "hạn mức là gì?")]);
    await runReplyTick(engine());
    const d = (await db.from("zalo_personal_reply_drafts").select("id, version").eq("source_message_id", (await message("q_hold")).id).single()).data!;
    assert.ok((await actOnDraft(review(), owner(), d.id, { action: "approve", version: d.version })).ok);
    assert.ok((await saveSettings(review(), owner(), { connectionId: ids.conn, replyMode: "disabled" })).ok);
    const c = await claim(false);
    assert.ok(c.ok && c.job === null);
    assert.equal((await db.from("zalo_personal_reply_drafts").select("hold_reason").eq("id", d.id).single()).data!.hold_reason, "mode_no_send");
    await db.from("zalo_personal_reply_drafts").update({ status: "cancelled" }).eq("id", d.id);
    assert.ok((await saveSettings(review(), owner(), { connectionId: ids.conn, replyMode: "manual_approval" })).ok);
  });
  it("auto scope 'allowlist': only the allowlisted 1-1 chat is automatic", async () => {
    const auto = { PERSONAL_AUTO_REPLY_ENABLED: "true" };
    assert.ok((await saveSettings(review(auto), owner(), { connectionId: ids.conn, replyMode: "auto_reply_allowlist", autoDirect: "allowlist", cooldownSeconds: 5 })).ok);
    await ingest(ids.worker, [ev("q_not_listed", U_LINKED, "công nợ là gì?")]);
    await runReplyTick(engine(auto));
    assert.equal((await db.from("zalo_personal_reply_drafts").select("status").eq("source_message_id", (await message("q_not_listed")).id).single()).data!.status, "pending_approval");
    assert.ok((await control(review(auto), owner(), { action: "allow_conversation", connectionId: ids.conn, conversationId: ids.convLinked, note: "Chat thử nghiệm của chủ tài khoản" })).ok);
    await ingest(ids.worker, [ev("q_listed", U_LINKED, "công nợ là gì?")]);
    await runReplyTick(engine(auto));
    const d = (await db.from("zalo_personal_reply_drafts").select("status, approval").eq("source_message_id", (await message("q_listed")).id).single()).data!;
    assert.deepEqual([d.status, d.approval], ["queued", "auto"]);
    // narrowing the scope cancels what did not leave yet
    assert.ok((await saveSettings(review(auto), owner(), { connectionId: ids.conn, autoDirect: "off" })).ok);
    const after = (await db.from("zalo_personal_reply_drafts").select("status, error_category").eq("source_message_id", (await message("q_listed")).id).single()).data!;
    assert.deepEqual([after.status, after.error_category], ["cancelled", "auto_not_allowed"]);
    await db.from("zalo_personal_reply_drafts").update({ status: "cancelled" }).eq("connection_id", ids.conn).in("status", ["pending_approval", "queued"]);
    assert.ok((await saveSettings(review(auto), owner(), { connectionId: ids.conn, replyMode: "manual_approval" })).ok);
  });
});

// ------------------------------------------------------------------ OPS-06: reminders through the queue
describe("task reminders → Zalo (outbound queue)", () => {
  const enqueue = (key: string, notificationId: string | null, o: { user?: string; ext?: string; expires?: Date } = {}) =>
    store.enqueueReminder({ connectionId: ids.conn, userId: o.user ?? users.owner, externalUserId: o.ext ?? U_LINKED, text: "[Nhắc việc] Sắp đến hạn: Gửi báo giá", sourceKey: `rem-${RUN}-${key}`, notificationId, expiresAt: o.expires ?? new Date(Date.now() + 15 * 60_000) });
  async function notification(kind: string, taskId: string | null = null) {
    const { data, error } = await db.from("user_notifications").insert({ user_id: users.owner, kind, title: "Sắp đến hạn: Gửi báo giá", task_id: taskId, connection_id: ids.conn, dedupe_key: `t07-${RUN}-${randomUUID()}` }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }
  const delivery = async (n: string) => (await db.from("notification_deliveries").select("status, reason, provider_message_id").eq("notification_id", n).eq("channel", "zalo_personal").maybeSingle()).data;

  it("only to a VERIFIED recipient: unlinked id / wrong user → refused, nothing queued", async () => {
    assert.deepEqual(await enqueue("x1", null, { ext: U_STRANGER }), { ok: false, error: "not_verified" });
    assert.deepEqual(await enqueue("x2", null, { user: users.staff }), { ok: false, error: "not_verified" });
  });
  it("queued once per notification (idempotent); delivery 'pending' until the worker reports; sent → 'sent' + msg id", async () => {
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("connection_id", ids.conn).eq("status", "sent");
    const n = await notification("deadline_hour");
    const a = await enqueue("r1", n);
    const b = await enqueue("r1", n);
    assert.ok(a.ok && a.draftId && !a.duplicate);
    assert.ok(b.ok && b.duplicate && b.draftId === null, "a second enqueue of the same reminder is a no-op");
    assert.equal((await delivery(n))?.status, "pending");
    const c = await claim(true);
    assert.ok(c.ok && c.job?.draftId === a.draftId && c.job.threadType === "user" && c.job.threadId === U_LINKED, JSON.stringify(c));
    assert.equal((await delivery(n))?.status, "sending");
    await store.report(ids.worker, c.job!.draftId, c.job!.claimToken, "sent", "8100000000002", null);
    assert.deepEqual(await delivery(n), { status: "sent", reason: null, provider_message_id: "8100000000002" });
  });
  it("channel switched off before the send → cancelled (channel_disabled), delivery 'skipped'", async () => {
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("connection_id", ids.conn).eq("status", "sent");
    const n = await notification("deadline_day");
    const a = await enqueue("r2", n);
    const c = await claim(false);
    assert.ok(c.ok && c.job === null);
    assert.equal((await db.from("zalo_personal_reply_drafts").select("error_category").eq("id", a.ok ? a.draftId! : "").single()).data!.error_category, "channel_disabled");
    assert.deepEqual(await delivery(n), { status: "skipped", reason: "channel_disabled", provider_message_id: null });
  });
  it("task completed after queueing → never sent (task_closed)", async () => {
    const { data: task, error } = await db.from("ai_tasks").insert({ connection_id: ids.conn, conversation_id: ids.convLinked, dedupe_key: createHash("sha256").update(`t07-task-${RUN}`).digest("hex"), title: "Gửi báo giá", extractor: "manual", status: "accepted", source_message_at: new Date().toISOString(), confirmed_by: users.owner, confirmed_at: new Date().toISOString() }).select("id").single();
    assert.ifError(error);
    const n = await notification("deadline_hour", task!.id);
    const a = await enqueue("r3", n);
    await db.from("ai_tasks").update({ status: "cancelled" }).eq("id", task!.id);
    const c = await claim(true);
    assert.ok(c.ok && c.job === null);
    assert.equal((await db.from("zalo_personal_reply_drafts").select("error_category").eq("id", a.ok ? a.draftId! : "").single()).data!.error_category, "task_closed");
  });
  it("worker offline past the window → expired, delivery 'skipped expired' (no stale burst on recovery)", async () => {
    const n = await notification("deadline_hour");
    const a = await enqueue("r4", n, { expires: new Date(Date.now() + 1_000) });
    await db.from("zalo_personal_reply_drafts").update({ expires_at: new Date(Date.now() - 1_000).toISOString() }).eq("id", a.ok ? a.draftId! : "");
    const c = await claim(true);
    assert.ok(c.ok && c.job === null);
    assert.deepEqual(await delivery(n), { status: "skipped", reason: "expired", provider_message_id: null });
  });
  it("emergency stop and the send switch apply to reminders too", async () => {
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("connection_id", ids.conn).eq("status", "sent");
    const n = await notification("deadline_hour");
    await enqueue("r5", n);
    await db.from("zalo_personal_reply_control").update({ emergency_stop: true }).eq("id", 1);
    const s = await claim(true);
    assert.ok(s.ok && s.job === null && s.reason === "emergency_stop");
    await db.from("zalo_personal_reply_control").update({ emergency_stop: false }).eq("id", 1);
    await saveSettings(review(), owner(), { connectionId: ids.conn, sendEnabled: false });
    const off = await claim(true);
    assert.ok(off.ok && off.job === null && off.reason === "connection_send_off");
    await saveSettings(review(), owner(), { connectionId: ids.conn, sendEnabled: true });
    await db.from("zalo_personal_reply_drafts").update({ status: "cancelled" }).eq("connection_id", ids.conn).eq("status", "queued");
  });
  it("Phase 06 recipient lookup returns '<connection>:<zalo id>' from the verified identity (digest without task too)", async () => {
    const tasks = new SupabaseTaskStore(db);
    assert.equal(await tasks.externalRecipient(users.owner, "zalo_personal", null), `${ids.conn}:${U_LINKED}`);
    assert.equal(await tasks.externalRecipient(users.owner, "zalo_personal", ids.conn), `${ids.conn}:${U_LINKED}`);
    assert.equal(await tasks.externalRecipient(users.staff, "zalo_personal", null), null, "no link → no Zalo reminder");
  });
});

// ------------------------------------------------------------------ OPS-07 / OPS-11
describe("operations: snapshot, health, alerts", () => {
  const opsDeps = (): OpsDeps => ({
    review: review(),
    ops: store,
    ai: { enabled: false, provider: "gemini", apiKeyConfigured: false, modelValid: false, model: null, tier: "free", dataSharing: "none" },
    tasks: { enabled: true, zaloChannelEnabled: false, killSwitch: true },
  });
  it("no reply tick for 5 minutes → degraded (the backend scheduler is not running)", async () => {
    await db.from("zalo_personal_reply_control").update({ last_tick_at: new Date(Date.now() - 10 * 60_000).toISOString(), last_tick_status: "ok" }).eq("id", 1);
    const v = await getOperations(opsDeps(), owner());
    assert.ok(v.ok);
    assert.deepEqual(v.data.connections.find((x) => x.id === ids.conn)?.health, { state: "degraded", reasons: ["reply_tick_stale"] });
  });
  it("the operations view is admin-only and shows only owned connections", async () => {
    await store.recordTick("ok");
    const v = await getOperations(opsDeps(), owner());
    assert.ok(v.ok);
    const c = v.data.connections.find((x) => x.id === ids.conn);
    assert.ok(c, "own connection listed");
    assert.equal(c.health.state, "healthy", JSON.stringify(c.health));
    assert.equal(c.linkedUsers, 1);
    const staff = await getOperations(opsDeps(), { userId: users.staff, role: "staff" });
    assert.ok(!staff.ok && staff.error === "not_found");
  });
  it("one alert per state change (no alert loop); recovery is announced once", async () => {
    // the worker goes silent: heartbeat 10 minutes old
    await db.from("zalo_personal_sync_state").update({ last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("worker_id", ids.worker);
    const only = { allConnectionIds: async () => [ids.conn], opsSnapshot: (x: string[]) => store.opsSnapshot(x), opsObserve: (a: string, b: string, c: string[]) => store.opsObserve(a, b, c) };
    const first = await runOpsCheck(only, { now: new Date(), replyEnabled: false });
    assert.deepEqual([first.states.disconnected, first.notified], [1, 1]);
    const again = await runOpsCheck(only, { now: new Date(), replyEnabled: false });
    assert.equal(again.notified, 0, "same state → no second alert");
    await db.from("zalo_personal_sync_state").update({ last_heartbeat_at: new Date().toISOString() }).eq("worker_id", ids.worker);
    const back = await runOpsCheck(only, { now: new Date(), replyEnabled: false });
    assert.deepEqual([back.states.healthy, back.notified], [1, 1]);
    const alerts = (await db.from("user_notifications").select("kind, title, link").eq("user_id", users.owner).eq("kind", "ops_alert")).data!;
    assert.equal(alerts.length, 2);
    assert.ok(alerts.every((a) => a.link === "/apps/zalo/personal/operations"));
  });
  it("Zalo kicked the session → authentication_required (never 'healthy' just because a process runs)", async () => {
    await db.from("zalo_personal_sync_state").update({ listener_state: "error", last_error_category: "kicked_by_server" }).eq("worker_id", ids.worker);
    const v = await getOperations(opsDeps(), owner());
    assert.ok(v.ok);
    assert.equal(v.data.connections.find((x) => x.id === ids.conn)?.health.state, "authentication_required");
    await db.from("zalo_personal_sync_state").update({ listener_state: "active", last_error_category: null }).eq("worker_id", ids.worker);
  });
});

// ------------------------------------------------------------------ OPS-12 (database part)
describe("security", () => {
  it("recipient spoofing: the worker's claim body cannot name a thread / recipient", () => {
    const p = claimBody.safeParse({ v: 1, connectionKey: "abc", accountId: ACC, listenerState: "active", threadId: U_STRANGER });
    assert.equal(p.success, false, "strict schema: unknown keys refused");
  });
  it("a reminder row can never point at a group or skip its idempotency key (DB check)", async () => {
    const bad = await db.from("zalo_personal_reply_drafts").insert({ connection_id: ids.conn, conversation_id: ids.convLinked, conversation_type: "user", asker_external_id: U_LINKED, audience: "private", kind: "reminder", pipeline: "none", status: "queued", approval: "auto", approved_at: new Date().toISOString(), original_text: "x", text: "x", expires_at: new Date(Date.now() + 60_000).toISOString() });
    assert.ok(bad.error, "no source_key → refused");
  });
  it("revoked identity: queued reply to that person is cancelled at the last moment", async () => {
    await db.from("zalo_personal_reply_drafts").update({ sent_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("connection_id", ids.conn).eq("status", "sent");
    await ingest(ids.worker, [ev("q_revoke", U_LINKED, "công nợ là gì?")]);
    await runReplyTick(engine());
    const d = (await db.from("zalo_personal_reply_drafts").select("id, version").eq("source_message_id", (await message("q_revoke")).id).single()).data!;
    assert.ok((await actOnDraft(review(), owner(), d.id, { action: "approve", version: d.version })).ok);
    await db.from("ai_channel_identities").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("connection_id", ids.conn).eq("external_user_id", U_LINKED);
    const c = await claim(false);
    assert.ok(c.ok && c.job === null);
    assert.equal((await db.from("zalo_personal_reply_drafts").select("error_category").eq("id", d.id).single()).data!.error_category, "asker_not_authorized");
    // and the content allowlist follows the link: the next text of that person is no longer stored
    await ingest(ids.worker, [ev("after_revoke", U_LINKED, "còn lưu không?")]);
    assert.equal((await message("after_revoke")).text_content, null);
  });
});
