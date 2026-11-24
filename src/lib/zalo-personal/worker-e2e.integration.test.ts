// ZALO PERSONAL Phase 02 — end to end with the REAL worker modules
// (services/zalo-personal-worker/src/ingest/*) talking to the REAL request
// handler and the LOCAL database: normalize → outbox (encrypted, on disk) →
// signed request → HMAC / nonce / rate limit → ingest RPC → rows.
// The HTTP hop is in-process (fetchImpl → handleWorkerRequest); the route file
// itself is exercised separately against `next dev`.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createClient } from "@supabase/supabase-js";

import { normalizeEvent } from "../../../services/zalo-personal-worker/src/event-normalizer.ts";
import { DeliveryService, type AuthGate } from "../../../services/zalo-personal-worker/src/ingest/delivery.ts";
import { HeartbeatReporter } from "../../../services/zalo-personal-worker/src/ingest/heartbeat.ts";
import { SignedClient, type FetchLike } from "../../../services/zalo-personal-worker/src/ingest/http-client.ts";
import { Outbox } from "../../../services/zalo-personal-worker/src/ingest/outbox.ts";
import { toWireEvent } from "../../../services/zalo-personal-worker/src/ingest/serializer.ts";
import { createLogger } from "../../../services/zalo-personal-worker/src/logger.ts";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "../security/secrets.ts";
import { getZaloPersonalIngestConfig, workerSecretContext } from "./config.ts";
import { handleWorkerRequest } from "./ingest.ts";
import { generateWorkerSecret, secretKeyBytes } from "./signing.ts";
import { SupabaseZaloPersonalStore } from "./supabase-store.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (never production)");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const encKey = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);

const RUN = randomBytes(3).toString("hex");
const OWN = `93${Date.now()}`.slice(0, 18);
const GROUP = "2547837462290891500";
const OTHER_GROUP = "2547837462290891999";
const FRIEND = "3000000000000000001";
const silent = createLogger({ level: "error", writer: () => {} });

let userId = "";
let connectionId = "";
let workerKey = "";
let secret = "";
let dir = "";
let networkDown = false;

/** In-process "HTTP": exactly what the route does, minus Next.js. */
const inProcessFetch: FetchLike = async (u, init) => {
  if (networkDown) throw new TypeError("fetch failed");
  const out = await handleWorkerRequest(u.endsWith("/heartbeat") ? "heartbeat" : "events", { method: init.method, path: new URL(u).pathname, rawBody: init.body, header: (n) => init.headers[n] ?? null }, {
    store: new SupabaseZaloPersonalStore(db),
    config: getZaloPersonalIngestConfig({ ZALO_PERSONAL_INGEST_ENABLED: "true" }),
    secretKey: (w) => secretKeyBytes(decryptSecret(w.secretEncrypted, encKey, workerSecretContext(w.id))),
    log: () => {},
  });
  return { status: out.status, headers: { get: (n: string) => out.headers?.[n] ?? out.headers?.[n.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase())] ?? null }, text: async () => JSON.stringify(out.body) };
};

async function workerProcess() {
  const outbox = new Outbox({ dir, key: Buffer.alloc(32, 5), maxEvents: 100, maxBytes: 1024 * 1024 });
  await outbox.init();
  const client = new SignedClient({ baseUrl: "https://backend.example", workerKey, secretKey: secretKeyBytes(secret), timeoutMs: 5000, fetchImpl: inProcessFetch });
  const auth: AuthGate = { failed: false, reason: null };
  let offset = 0;
  const delivery = new DeliveryService({ outbox, post: (p, b, s) => client.post(p, b, s), connectionKey: `e2e-${RUN}`, accountId: () => OWN, auth, logger: silent, batchSize: 25, maxAttempts: 5, backoff: { baseMs: 1000, maxMs: 10_000 }, pollMs: 10, now: () => Date.now() + offset, random: () => 1 });
  const heartbeat = new HeartbeatReporter({ post: (p, b) => client.post(p, b), connectionKey: `e2e-${RUN}`, workerVersion: "0.2.0", intervalMs: 60_000, source: { state: () => ({ state: "connected", errorReason: null }), accountId: () => OWN, everAuthenticated: () => true, lastMessageReceivedAt: () => new Date().toISOString() }, outbox, delivery, auth, logger: silent });
  return { outbox, delivery, heartbeat, auth, advance: (ms: number) => (offset += ms) };
}

function groupMessage(msgId: string, groupId = GROUP, content = "e2e nội dung") {
  const r = normalizeEvent("message", { type: 1, threadId: groupId, isSelf: false, data: { msgId, uidFrom: FRIEND, msgType: "webchat", ts: String(Date.now() - 1000), content, dName: "Không được lưu" } }, { connectionId: `e2e-${RUN}`, now: new Date() });
  assert.ok(r.ok);
  return toWireEvent(r.event, { ownId: OWN, directMessages: "metadata" });
}

const stored = async (msgId: string) => (await db.from("zalo_personal_messages").select("text_content").eq("connection_id", connectionId).eq("external_message_id", msgId)).data ?? [];

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zp-e2e-"));
  const { data: u } = await db.auth.admin.createUser({ email: `zp-e2e-${RUN}@example.test`, password: `Pw-${RUN}-x9`, email_confirm: true });
  userId = u.user!.id;
  await db.from("profiles").update({ is_active: true }).eq("id", userId);
  const { data: c } = await db.from("zalo_personal_connections").insert({ connection_key: `e2e-${RUN}`, owner_user_id: userId }).select("id").single();
  connectionId = c!.id;
  const id = randomUUID();
  workerKey = `e2e-w-${RUN}`;
  secret = generateWorkerSecret();
  await db.from("zalo_personal_workers").insert({ id, worker_key: workerKey, connection_id: connectionId, secret_encrypted: encryptSecret(secret, encKey, workerSecretContext(id)) });
});

after(async () => {
  await db.from("zalo_personal_messages").delete().eq("connection_id", connectionId);
  await db.from("zalo_personal_ingestion_events").delete().eq("connection_id", connectionId);
  await db.from("zalo_personal_conversations").delete().eq("connection_id", connectionId);
  await db.from("zalo_personal_groups").delete().eq("connection_id", connectionId);
  await db.from("zalo_personal_sync_state").delete().eq("connection_id", connectionId);
  await db.from("zalo_personal_workers").delete().eq("connection_id", connectionId);
  await db.from("zalo_personal_connections").delete().eq("id", connectionId);
  await db.auth.admin.deleteUser(userId);
  await rm(dir, { recursive: true, force: true });
});

describe("worker → backend → database", () => {
  it("heartbeat binds the account; an event of a not-yet-authorized group is rejected and registered disabled", async () => {
    const w = await workerProcess();
    await w.heartbeat.send();
    assert.equal(w.heartbeat.lastOkAt !== null, true);
    await w.outbox.enqueue(groupMessage(`${RUN}1`), Date.now());
    assert.equal(await w.delivery.runOnce(), "delivered");
    assert.equal(w.delivery.stats.rejected, 1);
    assert.equal(w.outbox.stats().depth, 0, "a final server answer removes it");
    assert.deepEqual(await stored(`${RUN}1`), []);
  });

  it("after the owner authorizes the group (with consent), messages are stored with their text", async () => {
    await db.from("zalo_personal_groups").update({ mode: "monitor", consent_status: "granted", consent_recorded_by: userId, consent_recorded_at: new Date().toISOString() }).eq("connection_id", connectionId).eq("external_group_id", GROUP);
    const w = await workerProcess();
    await w.outbox.enqueue(groupMessage(`${RUN}2`), Date.now());
    await w.outbox.enqueue(groupMessage(`${RUN}3`, OTHER_GROUP), Date.now());
    await w.delivery.runOnce();
    assert.deepEqual(await stored(`${RUN}2`), [{ text_content: "e2e nội dung" }]);
    assert.deepEqual(await stored(`${RUN}3`), [], "another (unauthorized) group stores nothing");
    const { data } = await db.from("zalo_personal_messages").select("*").eq("connection_id", connectionId).eq("external_message_id", `${RUN}2`).single();
    assert.ok(!JSON.stringify(data).includes("Không được lưu"), "display names are never stored");
  });

  it("network down → kept on disk; after a restart and recovery it is delivered once", async () => {
    networkDown = true;
    const w1 = await workerProcess();
    await w1.outbox.enqueue(groupMessage(`${RUN}4`), Date.now());
    assert.equal(await w1.delivery.runOnce(), "backoff");
    networkDown = false;
    const w2 = await workerProcess(); // restart
    w2.advance(60_000);
    assert.equal(await w2.delivery.runOnce(), "delivered");
    assert.equal((await stored(`${RUN}4`)).length, 1);
  });

  it("the same event delivered again by a new process (replay / lost ack) is stored once", async () => {
    const w = await workerProcess();
    await w.outbox.enqueue(groupMessage(`${RUN}2`), Date.now());
    await w.delivery.runOnce();
    assert.equal(w.delivery.stats.duplicates, 1);
    assert.equal((await stored(`${RUN}2`)).length, 1);
    const { data } = await db.from("zalo_personal_sync_state").select("listener_state, session_state, last_ingested_at").eq("connection_id", connectionId).single();
    assert.equal(data?.listener_state, "active");
    assert.ok(data?.last_ingested_at);
  });

  it("a revoked worker is paused on the first 403 and keeps its outbox", async () => {
    await db.from("zalo_personal_workers").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("worker_key", workerKey);
    const w = await workerProcess();
    await w.outbox.enqueue(groupMessage(`${RUN}5`), Date.now());
    assert.equal(await w.delivery.runOnce(), "paused");
    assert.equal(w.auth.reason, "worker_revoked");
    assert.equal(w.outbox.stats().depth, 1);
  });
});
