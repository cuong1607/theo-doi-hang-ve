// ZALO PERSONAL Phase 02 — unit tests (no database, no network): signing,
// contract, and the full request path of the ingestion endpoints against an
// in-memory store.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getZaloPersonalIngestConfig } from "./config.ts";
import { ingestBatchSchema, ingestEventSchema } from "./contracts.ts";
import { handleWorkerRequest, type IngestDeps, type WorkerRecord, type ZaloPersonalStore } from "./ingest.ts";
import { canonicalString, HEADER, secretKeyBytes, sign, signatureMatches } from "./signing.ts";

// Same fixed vector as services/zalo-personal-worker/test/ingest-signing.test.ts
const VECTOR = {
  secret: "zps_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
  parts: { method: "POST", path: "/api/internal/zalo-personal/events", workerKey: "win-test-01", timestamp: "1764000000000", nonce: "0123456789abcdef0123456789abcdef", rawBody: '{"v":1,"hello":"Xin chào"}' },
  signature: "v1=bccc93d914ccb3d042474a331feea993b4f8331e7ad5861a433407cc6a78817f",
};

describe("signing", () => {
  it("matches the fixed cross-package vector", () => {
    assert.equal(sign(secretKeyBytes(VECTOR.secret), VECTOR.parts), VECTOR.signature);
  });
  it("covers method, path, identity, time, nonce and every body byte", () => {
    const key = secretKeyBytes(VECTOR.secret);
    for (const change of [{ method: "PUT" }, { path: "/api/internal/zalo-personal/heartbeat" }, { workerKey: "other-01" }, { timestamp: "1764000000001" }, { nonce: "f".repeat(32) }, { rawBody: VECTOR.parts.rawBody + " " }]) {
      assert.equal(signatureMatches(key, { ...VECTOR.parts, ...change }, VECTOR.signature), false, JSON.stringify(change));
    }
    assert.equal(signatureMatches(key, VECTOR.parts, VECTOR.signature), true);
    assert.ok(canonicalString(VECTOR.parts).startsWith("v1\nPOST\n"));
  });
  it("rejects malformed signature headers and secrets", () => {
    const key = secretKeyBytes(VECTOR.secret);
    for (const bad of ["", "v1=xyz", VECTOR.signature.toUpperCase(), `v2=${"0".repeat(64)}`]) assert.equal(signatureMatches(key, VECTOR.parts, bad), false);
    assert.throws(() => secretKeyBytes("not-a-secret"));
    assert.throws(() => secretKeyBytes("zps_short"));
  });
});

// ------------------------------------------------------------ contract
const EVENT = {
  eventKey: "a".repeat(64),
  kind: "message",
  conversationType: "group",
  conversationId: "2547837462290891500",
  externalMessageId: "7000000000001",
  senderId: "3000000000000000001",
  messageType: "text",
  text: "xin chào",
  textLength: 8,
  mentions: [],
  mentionsSelf: false,
  isSelf: false,
  subtype: null,
  sentAt: "2026-11-24T08:00:00.000Z",
  receivedAt: "2026-11-24T08:00:01.000Z",
} as const;

describe("contract", () => {
  it("accepts a valid event and refuses unknown fields", () => {
    assert.equal(ingestEventSchema.safeParse(EVENT).success, true);
    assert.equal(ingestEventSchema.safeParse({ ...EVENT, displayName: "x" }).success, false);
  });
  it("messages need ids; textLength must match; only messages carry text", () => {
    assert.equal(ingestEventSchema.safeParse({ ...EVENT, senderId: null }).success, false);
    assert.equal(ingestEventSchema.safeParse({ ...EVENT, textLength: 3 }).success, false);
    assert.equal(ingestEventSchema.safeParse({ ...EVENT, kind: "reaction" }).success, false);
    assert.equal(ingestEventSchema.safeParse({ ...EVENT, text: null, textLength: 8 }).success, true, "stripped text keeps its length");
  });
  it("ids must be numeric strings (no JS numbers, no injection)", () => {
    assert.equal(ingestEventSchema.safeParse({ ...EVENT, conversationId: 2547837462290891500 }).success, false);
    assert.equal(ingestEventSchema.safeParse({ ...EVENT, conversationId: "1 OR 1=1" }).success, false);
  });
  it("batch: 1..25 events, unique eventKeys", () => {
    const batch = { v: 1, connectionKey: "primary", accountId: "1000000000000000001", events: [EVENT] };
    assert.equal(ingestBatchSchema.safeParse(batch).success, true);
    assert.equal(ingestBatchSchema.safeParse({ ...batch, events: [] }).success, false);
    assert.equal(ingestBatchSchema.safeParse({ ...batch, events: Array.from({ length: 26 }, (_, i) => ({ ...EVENT, eventKey: i.toString(16).padStart(64, "0") })) }).success, false);
    assert.equal(ingestBatchSchema.safeParse({ ...batch, events: [EVENT, EVENT] }).success, false);
  });
});

// ------------------------------------------------------------ request handling
const NOW = new Date("2026-11-24T08:00:00.000Z");
const WORKER: WorkerRecord = { id: "11111111-1111-4111-8111-111111111111", workerKey: "win-test-01", status: "active", connectionKey: "primary", connectionStatus: "active", secretEncrypted: "v1.x" };

class FakeStore implements ZaloPersonalStore {
  workers = new Map<string, WorkerRecord>([[WORKER.workerKey, { ...WORKER }]]);
  nonces = new Set<string>();
  ingested: unknown[] = [];
  rateLimited = false;
  async findWorker(k: string) {
    return this.workers.get(k) ?? null;
  }
  async registerRequest(workerId: string, nonce: string) {
    if (this.rateLimited) return "rate_limited" as const;
    const k = `${workerId}:${nonce}`;
    if (this.nonces.has(k)) return "nonce_reused" as const;
    this.nonces.add(k);
    return "ok" as const;
  }
  async ingest(_w: string, _a: string, events: Array<{ eventKey: string }>) {
    this.ingested.push(...events);
    return { ok: true as const, results: events.map((e) => ({ eventKey: e.eventKey, status: "stored" as const, reason: null })) };
  }
  async heartbeat() {
    return { ok: true as const, serverTime: NOW.toISOString() };
  }
}

function setup(env: Record<string, string> = { ZALO_PERSONAL_INGEST_ENABLED: "true" }) {
  const store = new FakeStore();
  const logs: Array<Record<string, unknown>> = [];
  const deps: IngestDeps = { store, config: getZaloPersonalIngestConfig(env), secretKey: () => secretKeyBytes(VECTOR.secret), now: () => NOW, log: (event, fields) => logs.push({ event, ...fields }) };
  return { store, deps, logs };
}

let nonceCounter = 0;
function request(body: unknown, overrides: { path?: string; workerKey?: string; timestamp?: number; nonce?: string; signature?: string; secret?: string; raw?: string } = {}) {
  const rawBody = overrides.raw ?? JSON.stringify(body);
  const path = overrides.path ?? "/api/internal/zalo-personal/events";
  const workerKey = overrides.workerKey ?? WORKER.workerKey;
  const timestamp = String(overrides.timestamp ?? NOW.getTime());
  const nonce = overrides.nonce ?? (++nonceCounter).toString(16).padStart(32, "0");
  const signature = overrides.signature ?? sign(secretKeyBytes(overrides.secret ?? VECTOR.secret), { method: "POST", path, workerKey, timestamp, nonce, rawBody });
  const headers: Record<string, string> = { [HEADER.worker]: workerKey, [HEADER.timestamp]: timestamp, [HEADER.nonce]: nonce, [HEADER.signature]: signature };
  return { method: "POST", path, rawBody, header: (n: string) => headers[n] ?? null };
}

const BATCH = { v: 1, connectionKey: "primary", accountId: "1000000000000000001", events: [EVENT] };

describe("ingestion endpoint", () => {
  it("valid signature → 200 with per-event results", async () => {
    const t = setup();
    const out = await handleWorkerRequest("events", request(BATCH), t.deps);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.results, [{ eventKey: EVENT.eventKey, status: "stored", reason: null }]);
  });

  it("disabled flag → 503 and nothing touched", async () => {
    const t = setup({});
    assert.equal((await handleWorkerRequest("events", request(BATCH), t.deps)).status, 503);
    assert.equal(t.store.nonces.size, 0);
  });

  it("invalid signature → 401 (same body as unknown worker), nothing written", async () => {
    const t = setup();
    const bad = await handleWorkerRequest("events", request(BATCH, { secret: "zps_" + Buffer.alloc(32, 9).toString("base64url") }), t.deps);
    const unknown = await handleWorkerRequest("events", request(BATCH, { workerKey: "ghost-worker" }), t.deps);
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.body, unknown.body);
    assert.equal(unknown.status, 401);
    assert.equal(t.store.nonces.size, 0);
    assert.equal(t.store.ingested.length, 0);
    assert.deepEqual(t.logs.map((l) => l.reason), ["bad_signature", "unknown_worker"]);
  });

  it("body tampered after signing → 401", async () => {
    const t = setup();
    const req = request(BATCH);
    const tampered = { ...req, rawBody: req.rawBody.replace("xin chào", "xin chao") };
    assert.equal((await handleWorkerRequest("events", tampered, t.deps)).status, 401);
  });

  it("expired / future timestamp → 401 timestamp_out_of_window", async () => {
    const t = setup();
    for (const ts of [NOW.getTime() - 301_000, NOW.getTime() + 301_000]) {
      const out = await handleWorkerRequest("events", request(BATCH, { timestamp: ts }), t.deps);
      assert.equal(out.status, 401);
      assert.equal(out.body.error, "timestamp_out_of_window");
    }
    assert.equal((await handleWorkerRequest("events", request(BATCH, { timestamp: NOW.getTime() - 299_000 }), t.deps)).status, 200);
  });

  it("reused nonce → 409; the same events with a NEW nonce are accepted (retry)", async () => {
    const t = setup();
    const nonce = "ab".repeat(16);
    assert.equal((await handleWorkerRequest("events", request(BATCH, { nonce }), t.deps)).status, 200);
    const replay = await handleWorkerRequest("events", request(BATCH, { nonce }), t.deps);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, "nonce_reused");
    assert.equal((await handleWorkerRequest("events", request(BATCH), t.deps)).status, 200);
  });

  it("missing / malformed auth headers → 401", async () => {
    const t = setup();
    const req = request(BATCH);
    for (const drop of [HEADER.worker, HEADER.timestamp, HEADER.nonce, HEADER.signature]) {
      const out = await handleWorkerRequest("events", { ...req, header: (n: string) => (n === drop ? null : req.header(n)) }, t.deps);
      assert.equal(out.status, 401, drop);
    }
    assert.equal((await handleWorkerRequest("events", request(BATCH, { nonce: "not-hex" }), t.deps)).status, 401);
  });

  it("revoked worker / disabled connection → 403 (after the signature is proven)", async () => {
    const t = setup();
    t.store.workers.set(WORKER.workerKey, { ...WORKER, status: "revoked" });
    assert.equal((await handleWorkerRequest("events", request(BATCH), t.deps)).body.error, "worker_revoked");
    t.store.workers.set(WORKER.workerKey, { ...WORKER, connectionStatus: "disabled" });
    assert.equal((await handleWorkerRequest("events", request(BATCH), t.deps)).body.error, "connection_disabled");
  });

  it("unknown connection (payload names another connection) → 403 connection_mismatch", async () => {
    const t = setup();
    const out = await handleWorkerRequest("events", request({ ...BATCH, connectionKey: "someone-else" }), t.deps);
    assert.equal(out.status, 403);
    assert.equal(out.body.error, "connection_mismatch");
    assert.equal(t.store.ingested.length, 0);
  });

  it("invalid payload → 400 with issue paths only (no values echoed)", async () => {
    const t = setup();
    const out = await handleWorkerRequest("events", request({ ...BATCH, events: [{ ...EVENT, text: "BÍ MẬT", textLength: 99 }] }), t.deps);
    assert.equal(out.status, 400);
    assert.ok(!JSON.stringify(out.body).includes("BÍ MẬT"));
    assert.equal((await handleWorkerRequest("events", request(null, { raw: "{not json" }), t.deps)).status, 400);
  });

  it("oversized payload → 413 before any verification", async () => {
    const t = setup({ ZALO_PERSONAL_INGEST_ENABLED: "true", ZALO_PERSONAL_MAX_BODY_BYTES: "4096" });
    const out = await handleWorkerRequest("events", request(null, { raw: "x".repeat(5000) }), t.deps);
    assert.equal(out.status, 413);
    assert.equal(t.logs.length, 0);
  });

  it("rate limit → 429 with Retry-After", async () => {
    const t = setup();
    t.store.rateLimited = true;
    const out = await handleWorkerRequest("events", request(BATCH), t.deps);
    assert.equal(out.status, 429);
    assert.equal(out.headers?.["Retry-After"], "30");
  });

  it("a signature for /events cannot be replayed on /heartbeat", async () => {
    const t = setup();
    const req = request(BATCH); // signed for the events path
    assert.equal((await handleWorkerRequest("heartbeat", { ...req, path: "/api/internal/zalo-personal/heartbeat" }, t.deps)).status, 401);
  });

  it("logs never contain the body, text, signature or secret", async () => {
    const t = setup();
    await handleWorkerRequest("events", request(BATCH), t.deps);
    await handleWorkerRequest("events", request(BATCH, { workerKey: "ghost-worker" }), t.deps);
    const all = JSON.stringify(t.logs);
    for (const needle of ["xin chào", VECTOR.secret, "v1=", EVENT.senderId]) assert.ok(!all.includes(needle), needle);
  });
});
