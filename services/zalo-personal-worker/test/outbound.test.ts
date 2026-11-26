// Phase 04.5 — outbound (approved replies) with a MOCK session: no real Zalo call.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";
import type { HttpResult } from "../src/ingest/http-client.ts";
import { SendJournal } from "../src/outbound/journal.ts";
import { classifySendError } from "../src/outbound/sender.ts";
import { CLAIM_PATH, OutboundService, RESULT_PATH } from "../src/outbound/service.ts";
import { sendErrorInfo } from "../src/zalo-client.ts";
import { ZaloApiError } from "zca-js";
import { captureLogger, mockSession, OWN_ID, tempDir } from "./helpers.ts";

const DRAFT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const job = (over: Record<string, unknown> = {}) => ({ draftId: DRAFT, claimToken: TOKEN, threadId: "3000000000000000001", threadType: "user", text: "Trả lời đã duyệt", leaseUntil: new Date().toISOString(), ...over });
const ok = (body: Record<string, unknown>): HttpResult => ({ kind: "response", status: 200, body, retryAfterMs: null });

function harness(opts: { claims?: Array<HttpResult>; report?: (payload: Record<string, unknown>) => HttpResult; timeoutMs?: number } = {}) {
  const claims = [...(opts.claims ?? [])];
  const posts: Array<{ path: string; payload: Record<string, unknown> }> = [];
  const post = async (p: string, payload: unknown): Promise<HttpResult> => {
    posts.push({ path: p, payload: payload as Record<string, unknown> });
    if (p === CLAIM_PATH) return claims.shift() ?? ok({ ok: true, job: null, reason: "empty" });
    return opts.report ? opts.report(payload as Record<string, unknown>) : ok({ ok: true, status: "sent", changed: true });
  };
  return { posts, post };
}

async function setup(h: ReturnType<typeof harness>, extra: { session?: ReturnType<typeof mockSession> | null; timeoutMs?: number } = {}) {
  const t = await tempDir();
  const journal = new SendJournal({ file: path.join(t.dir, "outbound-journal.json") });
  await journal.init();
  const session = extra.session === undefined ? mockSession() : extra.session;
  const { logger, lines } = captureLogger();
  const svc = new OutboundService({ post: h.post, journal, connectionKey: "primary", accountId: () => OWN_ID, session: () => session, logger, pollMs: 1000, timeoutMs: extra.timeoutMs ?? 2000, minIntervalMs: 0 });
  return { t, journal, session, svc, lines };
}

const reports = (h: ReturnType<typeof harness>) => h.posts.filter((p) => p.path === RESULT_PATH).map((p) => p.payload);

describe("classifySendError", () => {
  it("Zalo refused (error_code) → failed; HTTP 5xx / unreadable → unknown; validation → not_sent", () => {
    assert.equal(classifySendError(sendErrorInfo(new ZaloApiError("Tài khoản bị hạn chế", -1))).outcome, "failed");
    assert.equal(classifySendError(sendErrorInfo(new ZaloApiError("Request failed with status code 502"))).outcome, "unknown");
    assert.equal(classifySendError(sendErrorInfo(new ZaloApiError("Request failed with status code 403"))).outcome, "failed");
    assert.equal(classifySendError(sendErrorInfo(new ZaloApiError("Failed to parse response data"))).outcome, "unknown");
    assert.equal(classifySendError(sendErrorInfo(new ZaloApiError("Missing message content"))).outcome, "not_sent");
  });
  it("network: DNS / refused → not_sent (nothing left); reset / unknown → unknown", () => {
    const dns = new TypeError("fetch failed");
    (dns as { cause?: unknown }).cause = { code: "ENOTFOUND" };
    assert.equal(classifySendError(sendErrorInfo(dns)).outcome, "not_sent");
    const reset = new TypeError("fetch failed");
    (reset as { cause?: unknown }).cause = { code: "ECONNRESET" };
    assert.equal(classifySendError(sendErrorInfo(reset)).outcome, "unknown");
    assert.equal(classifySendError(sendErrorInfo(new Error("boom"))).outcome, "unknown");
  });
});

describe("OutboundService", () => {
  it("approved job: claims, sends once through the session, reports sent with the Zalo msg id", async () => {
    const h = harness({ claims: [ok({ ok: true, job: job(), reason: null })] });
    const { t, svc, session, journal } = await setup(h);
    try {
      assert.equal(await svc.tick(), "sent");
      assert.equal(session!.sent.length, 1);
      assert.deepEqual(session!.sent[0], { threadId: "3000000000000000001", threadType: "user", text: "Trả lời đã duyệt" });
      const r = reports(h);
      assert.equal(r.length, 1);
      assert.equal(r[0]!.outcome, "sent");
      assert.match(String(r[0]!.zaloMsgId), /^\d+$/);
      assert.equal(r[0]!.claimToken, TOKEN);
      assert.equal(journal.unreported().length, 0);
      // the claim carried the bound account + listener state, never a destination
      const claim = h.posts.find((p) => p.path === CLAIM_PATH)!.payload;
      assert.deepEqual(Object.keys(claim).sort(), ["accountId", "connectionKey", "listenerState", "v"]);
    } finally {
      await t.cleanup();
    }
  });

  it("no session / not connected → never claims", async () => {
    const h = harness({ claims: [ok({ ok: true, job: job() })] });
    const { t, svc } = await setup(h, { session: null });
    try {
      assert.equal(await svc.tick(), "not_ready");
      assert.equal(h.posts.filter((p) => p.path === CLAIM_PATH).length, 0);
    } finally {
      await t.cleanup();
    }
  });

  it("backend kill switch (send_disabled / emergency_stop) → idle, nothing sent", async () => {
    const h = harness({ claims: [ok({ ok: true, job: null, reason: "send_disabled" }), ok({ ok: true, job: null, reason: "emergency_stop" })] });
    const { t, svc, session } = await setup(h);
    try {
      assert.equal(await svc.tick(), "idle");
      assert.equal(await svc.tick(), "idle");
      assert.equal(svc.stats.lastClaimReason, "emergency_stop");
      assert.equal(session!.sent.length, 0);
    } finally {
      await t.cleanup();
    }
  });

  it("send timeout → delivery unknown (reported, NOT retried); a late success upgrades it to sent", async () => {
    const h = harness({ claims: [ok({ ok: true, job: job() })] });
    const session = mockSession();
    let release!: (v: { msgId: string }) => void;
    session.onSend = () => new Promise((r) => (release = r));
    const { t, svc, journal } = await setup(h, { session, timeoutMs: 30 });
    try {
      assert.equal(await svc.tick(), "unknown");
      assert.equal(reports(h).at(-1)!.outcome, "unknown");
      assert.equal(reports(h).at(-1)!.errorCategory, "timeout");
      release({ msgId: "8000000000099" });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(journal.get(DRAFT)!.outcome, "sent");
      await svc.flushReports();
      assert.equal(reports(h).at(-1)!.outcome, "sent");
      assert.equal(reports(h).at(-1)!.zaloMsgId, "8000000000099");
      assert.equal(session.sent.length, 1, "sent exactly once");
    } finally {
      await t.cleanup();
    }
  });

  it("Zalo refuses → failed reported and the loop PAUSES (no further claim)", async () => {
    const h = harness({ claims: [ok({ ok: true, job: job() }), ok({ ok: true, job: job({ draftId: "33333333-3333-4333-8333-333333333333" }) })] });
    const session = mockSession();
    session.onSend = async () => {
      throw new ZaloApiError("Bạn đã gửi quá nhiều tin", 114);
    };
    const { t, svc } = await setup(h, { session });
    try {
      assert.equal(await svc.tick(), "failed");
      assert.equal(reports(h)[0]!.outcome, "failed");
      assert.equal(reports(h)[0]!.errorCategory, "zalo_rejected");
      assert.equal(await svc.tick(), "paused");
      assert.equal(h.posts.filter((p) => p.path === CLAIM_PATH).length, 1);
      assert.equal(svc.stats.pausedReason, "zalo_rejected");
    } finally {
      await t.cleanup();
    }
  });

  it("network error before any request → not_sent (server may re-queue it)", async () => {
    const h = harness({ claims: [ok({ ok: true, job: job() })] });
    const session = mockSession();
    session.onSend = async () => {
      const e = new TypeError("fetch failed");
      (e as { cause?: unknown }).cause = { code: "EAI_AGAIN" };
      throw e;
    };
    const { t, svc } = await setup(h, { session });
    try {
      assert.equal(await svc.tick(), "not_sent");
      assert.equal(reports(h)[0]!.outcome, "not_sent");
      assert.equal(svc.stats.pausedReason, null);
    } finally {
      await t.cleanup();
    }
  });

  it("report cannot reach the backend → kept in the journal and delivered on the next tick", async () => {
    let up = false;
    const h = harness({ claims: [ok({ ok: true, job: job() })], report: () => (up ? ok({ ok: true }) : { kind: "network", error: "network" }) });
    const { t, svc, journal, session } = await setup(h);
    try {
      assert.equal(await svc.tick(), "sent");
      assert.equal(journal.unreported().length, 1);
      up = true;
      await svc.tick();
      assert.equal(journal.unreported().length, 0);
      assert.equal(session!.sent.length, 1);
    } finally {
      await t.cleanup();
    }
  });

  it("worker restart in the middle of a send → reported unknown, the reply is NEVER sent again", async () => {
    const t = await tempDir();
    try {
      const file = path.join(t.dir, "outbound-journal.json");
      const j1 = new SendJournal({ file });
      await j1.init();
      await j1.begin(DRAFT, TOKEN); // crash here: no finish()
      const j2 = new SendJournal({ file });
      assert.equal(await j2.init(), 1);
      assert.equal(j2.get(DRAFT)!.outcome, "unknown");
      assert.equal(j2.get(DRAFT)!.category, "worker_restarted");
      // the server (wrongly) hands the same draft out again → not resent
      const h = harness({ claims: [ok({ ok: true, job: job() })] });
      const session = mockSession();
      const { logger } = captureLogger();
      const svc = new OutboundService({ post: h.post, journal: j2, connectionKey: "primary", accountId: () => OWN_ID, session: () => session, logger, pollMs: 1000, timeoutMs: 1000, minIntervalMs: 0 });
      assert.equal(await svc.tick(), "duplicate");
      assert.equal(session.sent.length, 0);
      assert.equal(reports(h)[0]!.outcome, "unknown");
      // nothing secret in the journal file
      const raw = await readFile(file, "utf8");
      assert.doesNotMatch(raw, /Trả lời|3000000000000000001/);
    } finally {
      await t.cleanup();
    }
  });

  it("auth refused at claim (401 / 403 / account mismatch) → paused, no retry loop", async () => {
    const h = harness({ claims: [{ kind: "response", status: 409, body: { ok: false, error: "account_mismatch" }, retryAfterMs: null }] });
    const { t, svc } = await setup(h);
    try {
      assert.equal(await svc.tick(), "paused");
      assert.equal(await svc.tick(), "paused");
      assert.equal(h.posts.filter((p) => p.path === CLAIM_PATH).length, 1);
    } finally {
      await t.cleanup();
    }
  });

  it("invalid job (bad thread id / empty text) is never sent", async () => {
    const h = harness({ claims: [ok({ ok: true, job: job({ threadId: "abc" }) }), ok({ ok: true, job: job({ text: "  " }) })] });
    const { t, svc, session } = await setup(h);
    try {
      assert.equal(await svc.tick(), "idle");
      assert.equal(await svc.tick(), "idle");
      assert.equal(session!.sent.length, 0);
    } finally {
      await t.cleanup();
    }
  });

  it("graceful stop waits for the in-flight send and its report", async () => {
    const h = harness({ claims: [ok({ ok: true, job: job() })] });
    const session = mockSession();
    session.onSend = () => new Promise((r) => setTimeout(() => r({ msgId: "8000000000123" }), 40));
    const { t, svc } = await setup(h, { session, timeoutMs: 1000 });
    try {
      svc.start();
      await new Promise((r) => setTimeout(r, 10));
      await svc.stop();
      assert.equal(reports(h).at(-1)!.outcome, "sent");
      assert.equal(session.sent.length, 1);
    } finally {
      await t.cleanup();
    }
  });

  it("realtime nudge: an incoming message wakes the idle loop and claims fast for a window, then back to the idle poll", async () => {
    const h = harness();
    const t = await tempDir();
    const journal = new SendJournal({ file: path.join(t.dir, "outbound-journal.json") });
    await journal.init();
    const { logger } = captureLogger();
    let clock = 0;
    const svc = new OutboundService({ post: h.post, journal, connectionKey: "primary", accountId: () => OWN_ID, session: () => mockSession(), logger, pollMs: 60_000, timeoutMs: 1000, minIntervalMs: 0, fastPollMs: 10, fastWindowMs: 1_000, now: () => clock });
    const claims = () => h.posts.filter((p) => p.path === CLAIM_PATH).length;
    try {
      svc.start();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(claims(), 1, "idle: one claim, then the long poll");
      svc.nudge();
      await new Promise((r) => setTimeout(r, 80));
      const fast = claims();
      assert.ok(fast >= 4, `fast window claims quickly (got ${fast})`);
      clock = 5_000; // the window is over → back to the 60 s idle poll
      await new Promise((r) => setTimeout(r, 40));
      const settled = claims();
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(claims(), settled, "no more fast claims after the window");
    } finally {
      await svc.stop();
      await t.cleanup();
    }
  });

  it("nudge without a fast window (ZP_SEND_FAST_WINDOW_MS=0) changes nothing", async () => {
    const h = harness();
    const { t, svc } = await setup(h);
    try {
      svc.start();
      await new Promise((r) => setTimeout(r, 30));
      svc.nudge();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(h.posts.filter((p) => p.path === CLAIM_PATH).length, 1);
    } finally {
      await svc.stop();
      await t.cleanup();
    }
  });

  it("a corrupted journal file refuses to start (never sends blind)", async () => {
    const t = await tempDir();
    try {
      const file = path.join(t.dir, "outbound-journal.json");
      await writeFile(file, "{not json");
      await assert.rejects(new SendJournal({ file }).init());
    } finally {
      await t.cleanup();
    }
  });
});

describe("send config", () => {
  const base = { ZP_ENABLED: "true", ZP_SESSION_PROTECTION: "aes-key", ZP_SESSION_KEY: Buffer.alloc(32, 1).toString("base64"), ZP_DATA_DIR: path.join(process.cwd(), "..", "..", "..", "zp-test-data") };
  it("ZP_SEND_ENABLED is off by default", () => {
    assert.equal(loadConfig(base, { platform: "linux", workerDir: "/w", exists: () => false }).send.enabled, false);
  });
  it("sending needs the signed ingestion client", () => {
    assert.throws(() => loadConfig({ ...base, ZP_SEND_ENABLED: "true" }, { platform: "linux", workerDir: "/w", exists: () => false }), ConfigError);
    const c = loadConfig({ ...base, ZP_SEND_ENABLED: "true", ZP_INGEST_ENABLED: "true", ZP_INGEST_URL: "http://localhost:3000", ZP_WORKER_KEY: "win-primary" }, { platform: "linux", workerDir: "/w", exists: () => false });
    assert.equal(c.send.enabled, true);
    assert.equal(c.send.minIntervalMs, 5000);
    assert.deepEqual([c.send.fastPollMs, c.send.fastWindowMs], [1500, 60_000], "realtime defaults");
  });
});
