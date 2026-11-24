import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";

import { normalizeEvent } from "../src/event-normalizer.ts";
import { DeliveryService, EVENTS_PATH, type AuthGate } from "../src/ingest/delivery.ts";
import { describeConnection, HeartbeatReporter } from "../src/ingest/heartbeat.ts";
import { assertSafeBaseUrl, classifyResult, SignedClient, type HttpResult } from "../src/ingest/http-client.ts";
import { Outbox } from "../src/ingest/outbox.ts";
import { loadIngestSecret, loadOrCreateOutboxKey, saveIngestSecret } from "../src/ingest/secret-store.ts";
import { discoveryWireEvent, eventKey, toWireEvent, type WireEvent } from "../src/ingest/serializer.ts";
import { HEADER, secretKeyBytes, sign, signatureMatches } from "../src/ingest/signing.ts";
import { AesKeyProtector } from "../src/session-protector.ts";
import type { NormalizedMessage } from "../src/types.ts";
import { captureLogger, FRIEND, GROUP_ALLOWED, NOW, OWN_ID, rawDirectMessage, rawGroupMessage, tempDir } from "./helpers.ts";

// Same fixed vector as src/lib/zalo-personal/zalo-personal.test.ts (backend verifier)
const VECTOR = {
  secret: "zps_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
  parts: { method: "POST", path: "/api/internal/zalo-personal/events", workerKey: "win-test-01", timestamp: "1764000000000", nonce: "0123456789abcdef0123456789abcdef", rawBody: '{"v":1,"hello":"Xin chào"}' },
  signature: "v1=bccc93d914ccb3d042474a331feea993b4f8331e7ad5861a433407cc6a78817f",
};

const norm = (raw: unknown) => {
  const r = normalizeEvent("message", raw, { connectionId: "primary", now: NOW });
  assert.ok(r.ok);
  return r.event as NormalizedMessage;
};

function wire(i: number, over: Partial<WireEvent> = {}): WireEvent {
  return { ...toWireEvent(norm(rawGroupMessage({ msgId: String(7000000000000 + i) })), { ownId: OWN_ID, directMessages: "metadata" }), ...over };
}

async function makeOutbox(dir: string, limits: { maxEvents?: number; maxBytes?: number } = {}, key = Buffer.alloc(32, 3)) {
  const o = new Outbox({ dir, key, maxEvents: limits.maxEvents ?? 100, maxBytes: limits.maxBytes ?? 10 * 1024 * 1024 });
  await o.init();
  return o;
}

describe("signing (worker copy)", () => {
  it("matches the backend's fixed vector", () => {
    assert.equal(sign(secretKeyBytes(VECTOR.secret), VECTOR.parts), VECTOR.signature);
    assert.equal(signatureMatches(secretKeyBytes(VECTOR.secret), VECTOR.parts, VECTOR.signature), true);
  });

  it("SignedClient sends a fresh nonce/timestamp/signature per request over the exact body", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const client = new SignedClient({
      baseUrl: "https://example.test",
      workerKey: "win-test-01",
      secretKey: secretKeyBytes(VECTOR.secret),
      timeoutMs: 1000,
      fetchImpl: async (url, init) => {
        seen.push({ url, headers: init.headers, body: init.body });
        return { status: 200, headers: { get: () => null }, text: async () => '{"ok":true}' };
      },
    });
    await client.post(EVENTS_PATH, { a: 1 });
    await client.post(EVENTS_PATH, { a: 1 });
    assert.equal(seen[0]!.url, "https://example.test/api/internal/zalo-personal/events");
    assert.notEqual(seen[0]!.headers[HEADER.nonce], seen[1]!.headers[HEADER.nonce]);
    const h = seen[0]!.headers;
    assert.ok(signatureMatches(secretKeyBytes(VECTOR.secret), { method: "POST", path: EVENTS_PATH, workerKey: "win-test-01", timestamp: h[HEADER.timestamp]!, nonce: h[HEADER.nonce]!, rawBody: seen[0]!.body }, h[HEADER.signature]!));
  });

  it("HTTPS only (http allowed for localhost), no credentials in the URL", () => {
    assert.throws(() => assertSafeBaseUrl("http://example.com"));
    assert.throws(() => assertSafeBaseUrl("https://user:pw@example.com"));
    assert.doesNotThrow(() => assertSafeBaseUrl("http://localhost:3000"));
    assert.doesNotThrow(() => assertSafeBaseUrl("https://theo-doi-hang-ve.vercel.app"));
  });
});

describe("serializer", () => {
  it("eventKey is stable for the same event and differs per message", () => {
    const a = toWireEvent(norm(rawGroupMessage()), { ownId: OWN_ID, directMessages: "metadata" });
    const b = toWireEvent(norm(rawGroupMessage()), { ownId: OWN_ID, directMessages: "metadata" });
    const c = toWireEvent(norm(rawGroupMessage({ msgId: "7000000000002" })), { ownId: OWN_ID, directMessages: "metadata" });
    assert.equal(a.eventKey, b.eventKey);
    assert.notEqual(a.eventKey, c.eventKey);
    assert.match(a.eventKey, /^[0-9a-f]{64}$/);
    assert.equal(eventKey(["x"]), eventKey(["x"]));
  });

  it("group text is sent; 1-1 text is stripped unless directMessages=content", () => {
    assert.equal(toWireEvent(norm(rawGroupMessage({ content: "abc" })), { ownId: null, directMessages: "metadata" }).text, "abc");
    const dm = toWireEvent(norm(rawDirectMessage({ content: "riêng tư" })), { ownId: null, directMessages: "metadata" });
    assert.equal(dm.text, null);
    assert.equal(dm.textLength, "riêng tư".length);
    assert.equal(dm.conversationType, "user");
    assert.equal(toWireEvent(norm(rawDirectMessage({ content: "riêng tư" })), { ownId: null, directMessages: "content" }).text, "riêng tư");
  });

  it("mentionsSelf is computed from the own UID; no display name ever", () => {
    const w = toWireEvent(norm(rawGroupMessage({ content: "@Me hi", mentions: [{ uid: OWN_ID, pos: 0, len: 3, type: 0 }] })), { ownId: OWN_ID, directMessages: "metadata" });
    assert.equal(w.mentionsSelf, true);
    assert.ok(!JSON.stringify(w).includes("Tên Hiển Thị"));
  });

  it("discovery event carries the group id only", () => {
    const d = discoveryWireEvent("primary", GROUP_ALLOWED, NOW);
    assert.deepEqual([d.kind, d.conversationId, d.text, d.senderId, d.externalMessageId], ["group_discovery", GROUP_ALLOWED, null, null, null]);
  });
});

describe("outbox", () => {
  it("is encrypted at rest and survives a restart", async () => {
    const { dir, cleanup } = await tempDir();
    const o1 = await makeOutbox(dir);
    await o1.enqueue(wire(1, { text: "BÍ MẬT NỘI DUNG", textLength: "BÍ MẬT NỘI DUNG".length }), 1000);
    const files = await readdir(path.join(dir, "pending"));
    const raw = await readFile(path.join(dir, "pending", files[0]!), "utf8");
    assert.ok(!raw.includes("BÍ MẬT") && !raw.includes(FRIEND), "no text / ids in clear");
    const o2 = await makeOutbox(dir); // restart
    assert.equal(o2.stats().depth, 1);
    const [entry] = o2.due(2000, 10);
    assert.equal((await o2.read(entry!)).text, "BÍ MẬT NỘI DUNG");
    await cleanup();
  });

  it("an interrupted write (*.tmp) is discarded at start; a wrong key cannot read entries", async () => {
    const { dir, cleanup } = await tempDir();
    const o = await makeOutbox(dir);
    await o.enqueue(wire(1), 1);
    await writeFile(path.join(dir, "pending", "x.json.123.ab.tmp"), "{partial");
    const again = await makeOutbox(dir);
    assert.equal(again.stats().depth, 1);
    assert.ok(!(await readdir(path.join(dir, "pending"))).some((n) => n.endsWith(".tmp")));
    const wrong = await makeOutbox(dir, {}, Buffer.alloc(32, 9));
    await assert.rejects(() => wrong.read(wrong.due(10, 1)[0]!), /outbox/i);
    await cleanup();
  });

  it("full outbox refuses NEW events and counts them (count and byte limits)", async () => {
    const { dir, cleanup } = await tempDir();
    const o = await makeOutbox(dir, { maxEvents: 2 });
    assert.equal(await o.enqueue(wire(1), 1), "queued");
    assert.equal(await o.enqueue(wire(2), 2), "queued");
    assert.equal(await o.enqueue(wire(3), 3), "full");
    assert.equal(await o.enqueue(wire(1), 4), "already_queued");
    assert.deepEqual([o.stats().depth, o.stats().fullDrops], [2, 1]);
    const small = await makeOutbox(path.join(dir, "b"), { maxBytes: 64 * 1024 });
    let full = false;
    for (let i = 0; i < 200 && !full; i++) full = (await small.enqueue(wire(100 + i, { text: "x".repeat(3000), textLength: 3000 }), i)) === "full";
    assert.ok(full);
    assert.ok(small.stats().bytes <= 64 * 1024);
    await cleanup();
  });
});

// ------------------------------------------------------------ delivery
type Reply = HttpResult | ((events: WireEvent[]) => HttpResult);
const ok = (results: Array<{ eventKey: string; status: string; reason?: string | null }>): HttpResult => ({ kind: "response", status: 200, body: { ok: true, results }, retryAfterMs: null });
const status = (code: number, error?: string, retryAfterMs: number | null = null): HttpResult => ({ kind: "response", status: code, body: error ? { ok: false, error } : null, retryAfterMs });

/** Fake backend with database-like idempotency on eventKey. */
function fakeServer() {
  const stored = new Set<string>();
  const accept = (events: WireEvent[]) => ok(events.map((e) => (stored.has(e.eventKey) ? { eventKey: e.eventKey, status: "duplicate" } : (stored.add(e.eventKey), { eventKey: e.eventKey, status: "stored" }))));
  return { stored, accept };
}

async function harness(replies: Reply[], opts: { maxAttempts?: number; outboxDir?: string; accountId?: string | null } = {}) {
  const t = opts.outboxDir ? { dir: opts.outboxDir, cleanup: async () => {} } : await tempDir();
  const outbox = await makeOutbox(t.dir);
  const { logger, lines } = captureLogger();
  let clock = 1_000_000;
  const auth: AuthGate = { failed: false, reason: null };
  const posts: WireEvent[][] = [];
  const delivery = new DeliveryService({
    outbox,
    post: async (p, payload) => {
      assert.equal(p, EVENTS_PATH);
      const events = (payload as { events: WireEvent[] }).events;
      posts.push(events);
      const r = replies.length > 1 ? replies.shift()! : replies[0]!;
      return typeof r === "function" ? r(events) : r;
    },
    connectionKey: "primary",
    accountId: () => (opts.accountId === undefined ? OWN_ID : opts.accountId),
    auth,
    logger,
    batchSize: 25,
    maxAttempts: opts.maxAttempts ?? 5,
    backoff: { baseMs: 1000, maxMs: 60_000 },
    pollMs: 10,
    now: () => clock,
    random: () => 1,
  });
  return { outbox, delivery, auth, posts, lines, dir: t.dir, advance: (ms: number) => (clock += ms), cleanup: t.cleanup };
}

describe("delivery", () => {
  it("API success → removed from the outbox", async () => {
    const s = fakeServer();
    const h = await harness([s.accept]);
    await h.outbox.enqueue(wire(1), 1);
    await h.outbox.enqueue(wire(2), 2);
    assert.equal(await h.delivery.runOnce(), "delivered");
    assert.equal(h.outbox.stats().depth, 0);
    assert.equal(h.posts[0]!.length, 2, "one batch");
    assert.ok(h.delivery.stats.lastDeliveryOkAt);
    await h.cleanup();
  });

  it("timeout / network / 500 → kept, retried with exponential backoff", async () => {
    const s = fakeServer();
    const h = await harness([{ kind: "network", error: "timeout" }, { kind: "network", error: "network" }, status(500, "server_error"), s.accept]);
    await h.outbox.enqueue(wire(1), 1);
    assert.equal(await h.delivery.runOnce(), "backoff");
    assert.equal(await h.delivery.runOnce(), "backoff", "still inside the backoff window: nothing sent");
    assert.equal(h.posts.length, 1);
    h.advance(1_000);
    await h.delivery.runOnce();
    h.advance(2_000);
    await h.delivery.runOnce();
    assert.equal(h.delivery.stats.consecutiveFailures, 3);
    h.advance(4_000);
    assert.equal(await h.delivery.runOnce(), "delivered");
    assert.equal(h.outbox.stats().depth, 0);
    assert.equal(h.delivery.stats.consecutiveFailures, 0);
    await h.cleanup();
  });

  it("429 → honours Retry-After", async () => {
    const h = await harness([status(429, "rate_limited", 30_000), fakeServer().accept]);
    await h.outbox.enqueue(wire(1), 1);
    assert.equal(await h.delivery.runOnce(), "backoff");
    h.advance(29_000);
    assert.equal(await h.delivery.runOnce(), "backoff");
    h.advance(1_000);
    assert.equal(await h.delivery.runOnce(), "delivered");
    await h.cleanup();
  });

  it("retry after restart: pending events are delivered by a new process", async () => {
    const { dir, cleanup } = await tempDir();
    const h1 = await harness([{ kind: "network", error: "network" }], { outboxDir: dir });
    await h1.outbox.enqueue(wire(1), 1);
    await h1.delivery.runOnce();
    const s = fakeServer();
    const h2 = await harness([s.accept], { outboxDir: dir }); // restart: new outbox + delivery on the same dir
    h2.advance(10 * 60_000);
    assert.equal(await h2.delivery.runOnce(), "delivered");
    assert.equal(s.stored.size, 1);
    assert.equal(h2.outbox.stats().depth, 0);
    await cleanup();
  });

  it("stored on the server but crashed before the local ack → resend is a duplicate, stored once", async () => {
    const { dir, cleanup } = await tempDir();
    const s = fakeServer();
    const h1 = await harness([s.accept], { outboxDir: dir });
    await h1.outbox.enqueue(wire(1), 1);
    h1.outbox.ack = async () => {
      throw new Error("simulated crash before ack");
    };
    await assert.rejects(() => h1.delivery.runOnce());
    assert.equal(s.stored.size, 1);
    const h2 = await harness([s.accept], { outboxDir: dir });
    assert.equal(await h2.delivery.runOnce(), "delivered");
    assert.equal(h2.delivery.stats.duplicates, 1);
    assert.equal(s.stored.size, 1, "logically once");
    assert.equal(h2.outbox.stats().depth, 0);
    await cleanup();
  });

  it("server-side rejection (e.g. group_disabled) is final: removed, not retried", async () => {
    const h = await harness([(ev) => ok(ev.map((e) => ({ eventKey: e.eventKey, status: "rejected", reason: "group_disabled" })))]);
    await h.outbox.enqueue(wire(1), 1);
    await h.delivery.runOnce();
    assert.equal(h.outbox.stats().depth, 0);
    assert.equal(h.delivery.stats.rejected, 1);
    await h.cleanup();
  });

  it("401 / 403 → delivery PAUSED, no further requests, outbox kept (no infinite retry)", async () => {
    for (const code of [401, 403]) {
      const h = await harness([status(code, code === 401 ? "unauthorized" : "worker_revoked")]);
      await h.outbox.enqueue(wire(1), 1);
      assert.equal(await h.delivery.runOnce(), "paused");
      h.advance(24 * 3600_000);
      assert.equal(await h.delivery.runOnce(), "paused");
      assert.equal(h.posts.length, 1, "never called again");
      assert.equal(h.outbox.stats().depth, 1, "events kept for after the fix");
      assert.equal(h.auth.failed, true);
      await h.cleanup();
    }
  });

  it("max attempts → dead letter", async () => {
    const h = await harness([status(503, "not_enabled")], { maxAttempts: 3 });
    await h.outbox.enqueue(wire(1), 1);
    for (let i = 0; i < 3; i++) {
      await h.delivery.runOnce();
      h.advance(3_600_000);
    }
    assert.deepEqual([h.outbox.stats().depth, h.outbox.stats().dead], [0, 1]);
    assert.equal(h.posts.length, 3);
    await h.cleanup();
  });

  it("400 on a batch → isolates events one by one; only the bad one is dead-lettered", async () => {
    const bad = wire(2);
    const h = await harness([(ev) => (ev.some((e) => e.eventKey === bad.eventKey) ? status(400, "invalid_payload") : fakeServer().accept(ev))]);
    await h.outbox.enqueue(wire(1), 1);
    await h.outbox.enqueue(bad, 2);
    await h.outbox.enqueue(wire(3), 3);
    for (let i = 0; i < 5; i++) await h.delivery.runOnce();
    assert.deepEqual([h.outbox.stats().depth, h.outbox.stats().dead], [0, 1]);
    await h.cleanup();
  });

  it("409 nonce_reused → immediate retry; 409 account_not_bound → backoff", async () => {
    const h = await harness([status(409, "nonce_reused"), status(409, "account_not_bound"), fakeServer().accept]);
    await h.outbox.enqueue(wire(1), 1);
    assert.equal(await h.delivery.runOnce(), "delivered");
    assert.equal(await h.delivery.runOnce(), "backoff");
    h.advance(5_000);
    assert.equal(await h.delivery.runOnce(), "delivered");
    assert.equal(h.outbox.stats().depth, 0);
    await h.cleanup();
  });

  it("no account id yet (not logged in) → nothing is sent", async () => {
    const h = await harness([fakeServer().accept], { accountId: null });
    await h.outbox.enqueue(wire(1), 1);
    assert.equal(await h.delivery.runOnce(), "no_account");
    assert.equal(h.posts.length, 0);
    await h.cleanup();
  });

  it("stop() during the loop leaves a consistent outbox", async () => {
    const { dir, cleanup } = await tempDir();
    const h = await harness([async () => {
      await new Promise((r) => setTimeout(r, 30));
      return fakeServer().accept([]);
    }] as unknown as Reply[], { outboxDir: dir });
    for (let i = 0; i < 3; i++) await h.outbox.enqueue(wire(i), i);
    h.delivery.start();
    await new Promise((r) => setTimeout(r, 5));
    await h.delivery.stop();
    const again = await makeOutbox(dir);
    assert.equal(again.stats().depth, 3, "unacknowledged events are still there, readable");
    for (const e of again.due(Number.MAX_SAFE_INTEGER, 10)) await again.read(e);
    await cleanup();
  });

  it("classification table", () => {
    assert.equal(classifyResult(status(200)), "success");
    assert.equal(classifyResult(status(413)), "split");
    assert.equal(classifyResult(status(409, "account_mismatch")), "auth");
    assert.equal(classifyResult(status(502)), "retry");
    assert.equal(classifyResult({ kind: "network", error: "timeout" }), "retry");
  });
});

describe("heartbeat", () => {
  it("keeps session, listener and backend signals separate", () => {
    assert.deepEqual(describeConnection("connected", null, true), { sessionState: "authenticated", listenerState: "active" });
    assert.deepEqual(describeConnection("reconnecting", null, true), { sessionState: "authenticated", listenerState: "reconnecting" });
    assert.deepEqual(describeConnection("error", "session_rejected", true), { sessionState: "rejected", listenerState: "error" });
    assert.deepEqual(describeConnection("error", "no_session", false), { sessionState: "unauthenticated", listenerState: "error" });
    assert.deepEqual(describeConnection("disconnected", null, false), { sessionState: "unknown", listenerState: "inactive" });
  });

  it("payload has only aggregates; a 401 stops heartbeats", async () => {
    const { dir, cleanup } = await tempDir();
    const outbox = await makeOutbox(dir);
    const { logger } = captureLogger();
    const auth: AuthGate = { failed: false, reason: null };
    const sent: unknown[] = [];
    const delivery = new DeliveryService({ outbox, post: async () => status(200), connectionKey: "primary", accountId: () => OWN_ID, auth, logger, batchSize: 1, maxAttempts: 1, backoff: { baseMs: 1, maxMs: 1 }, pollMs: 1 });
    const hb = new HeartbeatReporter({
      post: async (_p, payload) => (sent.push(payload), status(401, "unauthorized")),
      connectionKey: "primary",
      workerVersion: "0.2.0",
      intervalMs: 60_000,
      source: { state: () => ({ state: "connected", errorReason: null }), accountId: () => OWN_ID, everAuthenticated: () => true, lastMessageReceivedAt: () => null },
      outbox,
      delivery,
      auth,
      logger,
    });
    await hb.send();
    await hb.send();
    assert.equal(sent.length, 1, "stopped after 401");
    assert.equal(auth.failed, true);
    assert.deepEqual(Object.keys(sent[0] as object).sort(), ["accountId", "connectionKey", "deadLetterCount", "lastDeliveryOkAt", "lastErrorCategory", "lastMessageReceivedAt", "listenerState", "outboxDepth", "outboxFullDrops", "sessionState", "v", "workerStartedAt", "workerVersion"].sort());
    await cleanup();
  });
});

describe("secret store", () => {
  it("ingest secret and outbox key are stored protected, never in clear", async () => {
    const { dir, cleanup } = await tempDir();
    const p = new AesKeyProtector(randomBytes(32).toString("base64"));
    await saveIngestSecret(path.join(dir, "ingest-secret.json"), p, VECTOR.secret);
    assert.ok(!(await readFile(path.join(dir, "ingest-secret.json"), "utf8")).includes(VECTOR.secret.slice(4)));
    assert.equal(await loadIngestSecret(path.join(dir, "ingest-secret.json"), p, null), VECTOR.secret);
    await assert.rejects(() => saveIngestSecret(path.join(dir, "x.json"), p, "not-a-secret"));
    const k1 = await loadOrCreateOutboxKey(path.join(dir, "outbox.key"), p);
    const k2 = await loadOrCreateOutboxKey(path.join(dir, "outbox.key"), p);
    assert.deepEqual(k1, k2);
    assert.equal(await loadIngestSecret(path.join(dir, "none.json"), p, null), null);
    await cleanup();
  });
});
