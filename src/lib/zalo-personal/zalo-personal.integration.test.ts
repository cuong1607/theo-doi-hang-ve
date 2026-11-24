// ZALO PERSONAL Phase 02 — integration tests against the LOCAL Supabase
// (migration 00073): the real request path (signature → nonce/rate limit RPC
// → ingest RPC), database policy (group consent, direct mode, mention_only),
// idempotency, two-account isolation, channel separation from Zalo OA / Web,
// and RLS for anon / authenticated users. No real Zalo account involved.
// Run: node --env-file=<local env> --test src/lib/zalo-personal/zalo-personal.integration.test.ts
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret, encryptSecret, parseEncryptionKey } from "../security/secrets.ts";
import { getZaloPersonalIngestConfig, workerSecretContext } from "./config.ts";
import { handleWorkerRequest, type Endpoint, type IngestDeps } from "./ingest.ts";
import { generateWorkerSecret, HEADER, newNonce, secretKeyBytes, sign } from "./signing.ts";
import { SupabaseZaloPersonalStore } from "./supabase-store.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (never production)");
const db: SupabaseClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const encKey = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);

const RUN = randomBytes(3).toString("hex");
const PASSWORD = `Pw-${randomBytes(8).toString("hex")}`;
const ACCOUNT_A = `91${Date.now()}`.slice(0, 18);
const ACCOUNT_B = `92${Date.now()}`.slice(0, 18);
const GROUP = "2547837462290891500";
const FRIEND = "3000000000000000001";

interface Actor {
  userId: string;
  email: string;
  connectionId: string;
  connectionKey: string;
  workerId: string;
  workerKey: string;
  secret: string;
  account: string;
}

const created = { users: [] as string[], connections: [] as string[] };

async function createActor(tag: string, account: string): Promise<Actor> {
  const email = `zp-${tag}-${RUN}@example.test`;
  const { data: u, error: ue } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (ue || !u.user) throw new Error(`createUser ${ue?.message}`);
  created.users.push(u.user.id);
  await db.from("profiles").update({ is_active: true, role: "staff" }).eq("id", u.user.id);
  const connectionKey = `t-${tag}-${RUN}`;
  const { data: c, error: ce } = await db.from("zalo_personal_connections").insert({ connection_key: connectionKey, owner_user_id: u.user.id }).select("id").single();
  if (ce) throw new Error(`connection ${ce.message}`);
  created.connections.push(c.id);
  const workerId = randomUUID();
  const workerKey = `w-${tag}-${RUN}`;
  const secret = generateWorkerSecret();
  const { error: we } = await db.from("zalo_personal_workers").insert({ id: workerId, worker_key: workerKey, connection_id: c.id, secret_encrypted: encryptSecret(secret, encKey, workerSecretContext(workerId)) });
  if (we) throw new Error(`worker ${we.message}`);
  return { userId: u.user.id, email, connectionId: c.id, connectionKey, workerId, workerKey, secret, account };
}

function deps(env: Record<string, string> = {}): IngestDeps {
  return {
    store: new SupabaseZaloPersonalStore(db),
    config: getZaloPersonalIngestConfig({ ZALO_PERSONAL_INGEST_ENABLED: "true", ...env }),
    secretKey: (w) => secretKeyBytes(decryptSecret(w.secretEncrypted, encKey, workerSecretContext(w.id))),
    log: () => {},
  };
}

async function call(endpoint: Endpoint, actor: Actor, body: unknown, opts: { nonce?: string; env?: Record<string, string> } = {}) {
  const path = `/api/internal/zalo-personal/${endpoint}`;
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = opts.nonce ?? newNonce();
  const headers: Record<string, string> = { [HEADER.worker]: actor.workerKey, [HEADER.timestamp]: timestamp, [HEADER.nonce]: nonce, [HEADER.signature]: sign(secretKeyBytes(actor.secret), { method: "POST", path, workerKey: actor.workerKey, timestamp, nonce, rawBody }) };
  return handleWorkerRequest(endpoint, { method: "POST", path, rawBody, header: (n) => headers[n] ?? null }, deps(opts.env));
}

const heartbeat = (a: Actor, accountId: string | null = a.account, listenerState = "active") => ({
  v: 1,
  connectionKey: a.connectionKey,
  accountId,
  workerVersion: "0.2.0",
  workerStartedAt: new Date().toISOString(),
  sessionState: "authenticated",
  listenerState,
  lastMessageReceivedAt: null,
  lastDeliveryOkAt: null,
  outboxDepth: 3,
  deadLetterCount: 0,
  outboxFullDrops: 0,
  lastErrorCategory: null,
});

let seq = 0;
function msg(over: Partial<Record<string, unknown>> = {}) {
  seq++;
  return {
    eventKey: randomBytes(32).toString("hex"),
    kind: "message",
    conversationType: "group",
    conversationId: GROUP,
    externalMessageId: `${RUN}${seq}`.replace(/[^0-9a-z]/g, "") || String(seq),
    senderId: FRIEND,
    messageType: "text",
    text: "nội dung thử",
    textLength: "nội dung thử".length,
    mentions: [],
    mentionsSelf: false,
    isSelf: false,
    subtype: null,
    sentAt: new Date(Date.now() - 2000).toISOString(),
    receivedAt: new Date().toISOString(),
    ...over,
  };
}

const batch = (a: Actor, events: unknown[]) => ({ v: 1, connectionKey: a.connectionKey, accountId: a.account, events });

async function setGroup(a: Actor, patch: Record<string, unknown>) {
  return db.from("zalo_personal_groups").update(patch).eq("connection_id", a.connectionId).eq("external_group_id", GROUP);
}

const consent = (a: Actor) => ({ consent_status: "granted", consent_recorded_by: a.userId, consent_recorded_at: new Date().toISOString() });

let A: Actor;
let B: Actor;
let baseline: { aiConversations: number; aiMessages: number; zaloUserLinks: number; notificationLogs: number };

async function count(table: string, filter?: (q: ReturnType<ReturnType<SupabaseClient["from"]>["select"]>) => unknown): Promise<number> {
  let q = db.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q) as typeof q;
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

before(async () => {
  baseline = { aiConversations: await count("ai_conversations"), aiMessages: await count("ai_messages"), zaloUserLinks: await count("zalo_user_links"), notificationLogs: await count("notification_logs") };
  A = await createActor("a", ACCOUNT_A);
  B = await createActor("b", ACCOUNT_B);
});

after(async () => {
  for (const id of created.connections) {
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

describe("connections + heartbeat", () => {
  it("events before the account is bound → 409 account_not_bound (retryable)", async () => {
    const out = await call("events", A, batch(A, [msg()]));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "account_not_bound");
  });

  it("first heartbeat binds the Zalo account and records separate sync signals", async () => {
    const out = await call("heartbeat", A, heartbeat(A));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const { data: c } = await db.from("zalo_personal_connections").select("zalo_account_id, last_heartbeat_at, last_connected_at").eq("id", A.connectionId).single();
    assert.equal(c?.zalo_account_id, ACCOUNT_A);
    assert.ok(c?.last_heartbeat_at && c.last_connected_at);
    const { data: s } = await db.from("zalo_personal_sync_state").select("session_state, listener_state, outbox_depth, last_ingested_at").eq("worker_id", A.workerId).single();
    assert.deepEqual(s, { session_state: "authenticated", listener_state: "active", outbox_depth: 3, last_ingested_at: null });
    assert.equal((await call("heartbeat", B, heartbeat(B))).status, 200);
  });

  it("a different Zalo account on a bound connection → 409 account_mismatch (no silent re-binding)", async () => {
    const out = await call("heartbeat", A, heartbeat(A, "99999999999"));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "account_mismatch");
    const { data: c } = await db.from("zalo_personal_connections").select("zalo_account_id").eq("id", A.connectionId).single();
    assert.equal(c?.zalo_account_id, ACCOUNT_A);
  });

  it("one Zalo account cannot be bound to two connections", async () => {
    const C = await createActor("c", ACCOUNT_A);
    const out = await call("heartbeat", C, heartbeat(C));
    assert.equal(out.body.error, "account_in_use");
  });

  it("listener reconnecting is reported without touching last_connected_at", async () => {
    const before = (await db.from("zalo_personal_connections").select("last_connected_at").eq("id", A.connectionId).single()).data?.last_connected_at;
    await call("heartbeat", A, heartbeat(A, ACCOUNT_A, "reconnecting"));
    const { data } = await db.from("zalo_personal_connections").select("last_connected_at").eq("id", A.connectionId).single();
    assert.equal(data?.last_connected_at, before);
    await call("heartbeat", A, heartbeat(A));
  });
});

describe("groups: disabled by default, consent required", () => {
  it("an unknown group's message is rejected and the group is registered as disabled (no content)", async () => {
    const out = await call("events", A, batch(A, [msg()]));
    assert.equal(out.status, 200);
    assert.deepEqual((out.body.results as unknown[])[0], { eventKey: (out.body.results as Array<{ eventKey: string }>)[0]!.eventKey, status: "rejected", reason: "group_disabled" });
    const { data: g } = await db.from("zalo_personal_groups").select("mode, consent_status, discovered_via").eq("connection_id", A.connectionId).eq("external_group_id", GROUP).single();
    assert.deepEqual(g, { mode: "disabled", consent_status: "none", discovered_via: "event" });
    assert.equal(await count("zalo_personal_messages", (q) => q.eq("connection_id", A.connectionId)), 0);
  });

  it("the database refuses monitor without consent, and interactive without a verified sending path", async () => {
    const r1 = await setGroup(A, { mode: "monitor" });
    assert.equal(r1.error?.code, "23514");
    const r2 = await setGroup(A, { mode: "interactive", ...consent(A) });
    assert.equal(r2.error?.code, "23514");
    const r3 = await setGroup(A, { mode: "monitor", ...consent(A) });
    assert.equal(r3.error, null);
  });

  it("group_discovery registers a group as disabled and stores nothing", async () => {
    const out = await call("events", A, batch(A, [{ ...msg({ kind: "group_discovery", conversationId: "2547837462290891501", externalMessageId: null, senderId: null, messageType: null, text: null, textLength: 0, sentAt: null, isSelf: true }) }]));
    assert.equal((out.body.results as Array<{ status: string }>)[0]!.status, "recorded");
    const { data } = await db.from("zalo_personal_groups").select("mode, discovered_via").eq("connection_id", A.connectionId).eq("external_group_id", "2547837462290891501").single();
    assert.deepEqual(data, { mode: "disabled", discovered_via: "discovery_token" });
  });
});

describe("messages", () => {
  it("stores a valid message of an authorized group with its content", async () => {
    const e = msg({ mentions: [{ uid: ACCOUNT_A, pos: 0, len: 3, kind: "user" }], mentionsSelf: true });
    const out = await call("events", A, batch(A, [e]));
    assert.equal((out.body.results as Array<{ status: string }>)[0]!.status, "stored");
    const { data } = await db.from("zalo_personal_messages").select("text_content, content_stored, text_length, mentions_self, is_self, processing_state, zalo_personal_conversations!inner(channel, conversation_type, external_conversation_id)").eq("connection_id", A.connectionId).eq("external_message_id", e.externalMessageId as string).single();
    assert.equal(data?.text_content, "nội dung thử");
    assert.equal(data?.content_stored, true);
    assert.equal(data?.mentions_self, true);
    assert.equal(data?.processing_state, "stored");
    assert.deepEqual(data?.zalo_personal_conversations, { channel: "zalo_personal", conversation_type: "group", external_conversation_id: GROUP });
    const { data: s } = await db.from("zalo_personal_sync_state").select("last_ingested_at, last_event_at").eq("worker_id", A.workerId).single();
    assert.ok(s?.last_ingested_at && s.last_event_at);
  });

  it("the same event delivered again (new nonce, same eventKey) is stored once", async () => {
    const e = msg();
    const first = await call("events", A, batch(A, [e]));
    const second = await call("events", A, batch(A, [e]));
    assert.equal((first.body.results as Array<{ status: string }>)[0]!.status, "stored");
    assert.deepEqual((second.body.results as Array<{ status: string; reason: string }>)[0], { eventKey: e.eventKey, status: "duplicate", reason: "stored" });
    assert.equal(await count("zalo_personal_messages", (q) => q.eq("connection_id", A.connectionId).eq("external_message_id", e.externalMessageId as string)), 1);
    const { data } = await db.from("zalo_personal_ingestion_events").select("delivery_count").eq("connection_id", A.connectionId).eq("event_key", e.eventKey).single();
    assert.equal(data?.delivery_count, 2);
  });

  it("the same Zalo message under a different eventKey is still stored once (identity = account + conversation + message id)", async () => {
    const e = msg();
    await call("events", A, batch(A, [e]));
    const again = await call("events", A, batch(A, [{ ...e, eventKey: randomBytes(32).toString("hex"), text: "khác" , textLength: 4 }]));
    assert.deepEqual((again.body.results as Array<{ status: string; reason: string }>)[0]!.reason, "message_already_stored");
    assert.equal(await count("zalo_personal_messages", (q) => q.eq("connection_id", A.connectionId).eq("external_message_id", e.externalMessageId as string)), 1);
  });

  it("a disabled group stores nothing even after it was monitored", async () => {
    await setGroup(A, { mode: "disabled" });
    const out = await call("events", A, batch(A, [msg()]));
    assert.equal((out.body.results as Array<{ reason: string }>)[0]!.reason, "group_disabled");
    await setGroup(A, { mode: "monitor", ...consent(A) });
  });

  it("mention_only: stored only when this account is mentioned", async () => {
    await setGroup(A, { mode: "mention_only" });
    const out = await call("events", A, batch(A, [msg(), msg({ mentionsSelf: true })]));
    assert.deepEqual((out.body.results as Array<{ status: string }>).map((r) => r.status), ["ignored", "stored"]);
    await setGroup(A, { mode: "monitor" });
  });

  it("direct messages follow direct_message_mode: metadata (default) keeps no text, off rejects, content keeps text", async () => {
    const dm = (over = {}) => msg({ conversationType: "user", conversationId: FRIEND, ...over });
    const e1 = dm();
    await call("events", A, batch(A, [e1]));
    const { data: m1 } = await db.from("zalo_personal_messages").select("text_content, content_stored, text_length").eq("connection_id", A.connectionId).eq("external_message_id", e1.externalMessageId as string).single();
    assert.deepEqual(m1, { text_content: null, content_stored: false, text_length: "nội dung thử".length });

    await db.from("zalo_personal_connections").update({ direct_message_mode: "off" }).eq("id", A.connectionId);
    const off = await call("events", A, batch(A, [dm()]));
    assert.equal((off.body.results as Array<{ reason: string }>)[0]!.reason, "direct_disabled");

    await db.from("zalo_personal_connections").update({ direct_message_mode: "content" }).eq("id", A.connectionId);
    const e3 = dm();
    await call("events", A, batch(A, [e3]));
    const { data: m3 } = await db.from("zalo_personal_messages").select("text_content").eq("connection_id", A.connectionId).eq("external_message_id", e3.externalMessageId as string).single();
    assert.equal(m3?.text_content, "nội dung thử");
    await db.from("zalo_personal_connections").update({ direct_message_mode: "metadata" }).eq("id", A.connectionId);
  });

  it("signals (reaction / undo / group_event) are recorded as metadata only", async () => {
    const out = await call("events", A, batch(A, [msg({ kind: "reaction", text: null, textLength: 0, messageType: null, subtype: "icon" })]));
    assert.equal((out.body.results as Array<{ status: string }>)[0]!.status, "recorded");
  });

  it("one invalid event is rejected alone; the rest of the batch is stored", async () => {
    const good = msg();
    const { data } = await db.rpc("zp_ingest_events", { p_worker_id: A.workerId, p_account_id: ACCOUNT_A, p_events: [{ ...msg(), messageType: "not-a-type" }, good] });
    const results = (data as { results: Array<{ status: string; reason: string }> }).results;
    assert.deepEqual(results.map((r) => [r.status, r.reason]), [["rejected", "invalid_event"], ["stored", null]]);
  });
});

describe("isolation", () => {
  it("worker A cannot write into connection B (payload naming B is refused)", async () => {
    const out = await call("events", A, { ...batch(A, [msg()]), connectionKey: B.connectionKey });
    assert.equal(out.status, 403);
    assert.equal(out.body.error, "connection_mismatch");
  });

  it("worker A cannot use B's account id", async () => {
    const out = await call("events", A, { ...batch(A, [msg()]), accountId: ACCOUNT_B });
    assert.equal(out.body.error, "account_mismatch");
  });

  it("the same group id under two accounts stays two separate groups / conversations / messages", async () => {
    await call("events", B, batch(B, [msg()])); // registers the group for B (disabled)
    await db.from("zalo_personal_groups").update({ mode: "monitor", ...consent(B) }).eq("connection_id", B.connectionId).eq("external_group_id", GROUP);
    const shared = `${RUN}shared`;
    await call("events", A, batch(A, [msg({ externalMessageId: shared })]));
    await call("events", B, batch(B, [msg({ externalMessageId: shared })]));
    const { data } = await db.from("zalo_personal_messages").select("connection_id, conversation_id").eq("external_message_id", shared);
    assert.equal(data?.length, 2);
    assert.notEqual(data?.[0]?.conversation_id, data?.[1]?.conversation_id);
    assert.equal(await count("zalo_personal_groups", (q) => q.eq("external_group_id", GROUP).in("connection_id", [A.connectionId, B.connectionId])), 2);
  });

  it("the database refuses a message pointing at another connection's conversation (composite FK)", async () => {
    const { data: convB } = await db.from("zalo_personal_conversations").select("id").eq("connection_id", B.connectionId).limit(1).single();
    const { data: evA } = await db.from("zalo_personal_ingestion_events").select("id").eq("connection_id", A.connectionId).limit(1).single();
    const { error } = await db.from("zalo_personal_messages").insert({ connection_id: A.connectionId, conversation_id: convB!.id, external_message_id: "x1", sender_external_id: FRIEND, message_type: "text", content_stored: false, is_self: false, received_at: new Date().toISOString(), ingestion_event_id: evA!.id });
    assert.equal(error?.code, "23503");
  });

  it("Zalo OA / Web threads are untouched: no zalo_personal rows, CHECKs unchanged", async () => {
    assert.equal(await count("ai_conversations"), baseline.aiConversations);
    assert.equal(await count("ai_messages"), baseline.aiMessages);
    assert.equal(await count("zalo_user_links"), baseline.zaloUserLinks);
    assert.equal(await count("notification_logs"), baseline.notificationLogs);
    const { error } = await db.from("ai_conversations").insert({ channel: "zalo_personal", external_user_id: "1" });
    assert.equal(error?.code, "23514", "the OA/Web thread table still refuses this channel");
  });
});

describe("security: RLS, privileges, replay, rate limit, revocation", () => {
  it("anon gets nothing (tables and functions)", async () => {
    const anon = createClient(url!, anonKey!, { auth: { persistSession: false } });
    for (const t of ["zalo_personal_messages", "zalo_personal_connections", "zalo_personal_workers", "zalo_personal_groups"]) {
      const { data, error } = await anon.from(t).select("*").limit(1);
      assert.ok(error || (data ?? []).length === 0, t);
    }
    const { error } = await anon.rpc("zp_ingest_events", { p_worker_id: A.workerId, p_account_id: ACCOUNT_A, p_events: [] });
    assert.ok(error);
  });

  it("an authenticated user — even the OWNER — cannot read or write through the API directly", async () => {
    const user = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signErr } = await user.auth.signInWithPassword({ email: A.email, password: PASSWORD });
    assert.equal(signErr, null);
    const read = await user.from("zalo_personal_messages").select("text_content").eq("connection_id", A.connectionId);
    assert.ok(read.error || (read.data ?? []).length === 0, "no rows visible");
    const secrets = await user.from("zalo_personal_workers").select("secret_encrypted");
    assert.ok(secrets.error || (secrets.data ?? []).length === 0);
    const write = await user.from("zalo_personal_groups").update({ mode: "monitor" }).eq("connection_id", A.connectionId).select();
    assert.ok(write.error || (write.data ?? []).length === 0);
    const rpc = await user.rpc("zp_register_request", { p_worker_id: A.workerId, p_nonce: "0".repeat(32), p_endpoint: "events", p_max_per_window: 10, p_window_seconds: 60 });
    assert.ok(rpc.error);
  });

  it("reused nonce is refused by the database (409)", async () => {
    const nonce = newNonce();
    assert.equal((await call("heartbeat", A, heartbeat(A), { nonce })).status, 200);
    const replay = await call("heartbeat", A, heartbeat(A), { nonce });
    assert.equal(replay.status, 409);
  });

  it("rate limit is enforced by the database across requests (429)", async () => {
    const env = { ZALO_PERSONAL_RATE_LIMIT_PER_MINUTE: "1" };
    // A already made many requests in the last minute
    const out = await call("heartbeat", A, heartbeat(A), { env });
    assert.equal(out.status, 429);
  });

  it("revoked worker → 403; disabled connection → 403", async () => {
    await db.from("zalo_personal_workers").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", B.workerId);
    assert.equal((await call("events", B, batch(B, [msg()]))).body.error, "worker_revoked");
    await db.from("zalo_personal_connections").update({ status: "disabled" }).eq("id", A.connectionId);
    assert.equal((await call("events", A, batch(A, [msg()]))).body.error, "connection_disabled");
    await db.from("zalo_personal_connections").update({ status: "active" }).eq("id", A.connectionId);
  });

  it("the worker secret is stored encrypted, bound to its worker id", async () => {
    const { data } = await db.from("zalo_personal_workers").select("secret_encrypted").eq("id", A.workerId).single();
    assert.ok(data?.secret_encrypted.startsWith("v1."));
    assert.ok(!data?.secret_encrypted.includes(A.secret));
    assert.throws(() => decryptSecret(data!.secret_encrypted, encKey, workerSecretContext(B.workerId)));
  });
});
