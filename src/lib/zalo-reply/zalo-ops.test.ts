// ============================================================
// PHASE 07 — unit tests (pure): health classification, AI / reminder health,
// the Zalo Personal reminder adapter, the send-window policy, permissions.
//   node --test src/lib/zalo-reply/zalo-ops.test.ts
// ============================================================
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dispatchExternal, externalExpiry, externalGate, zaloPersonalQueueAdapter, zaloPersonalRecipientRef, type ReminderEnqueueInput } from "../ai-tasks/channels.ts";
import { hasPermission } from "../auth/permissions.ts";
import { classifyAi, classifyConnection, classifyReminders, HEARTBEAT_STALE_MS, type SnapshotConnection } from "./ops.ts";

const NOW = new Date("2026-11-26T03:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const conn = (o: Partial<SnapshotConnection> = {}, sync: Partial<NonNullable<SnapshotConnection["sync"]>> = {}): SnapshotConnection => ({
  id: "c1",
  key: "k",
  status: "active",
  directMessageMode: "linked",
  accountBound: true,
  lastHeartbeatAt: ago(30_000),
  lastErrorCategory: null,
  sync: { sessionState: "authenticated", listenerState: "active", lastHeartbeatAt: ago(30_000), lastMessageReceivedAt: null, lastDeliveryOkAt: null, lastIngestedAt: null, outboxDepth: 0, deadLetters: 0, lastErrorCategory: null, workerVersion: "0.2.0", ...sync },
  settings: { replyMode: "manual_approval", sendEnabled: true, autoDirect: "off", autoGroups: false, sendPaused: false, pausedReason: null, dailySendLimit: 50 },
  lastScanAt: null,
  lastInboundAt: null,
  outbound: { pendingApproval: 0, queued: 0, sending: 0, unknown: 0, failed24h: 0, sentToday: 0, remindersQueued: 0, lastSentAt: null },
  groups: null,
  directAllowlisted: 0,
  linkedUsers: 1,
  ops: null,
  ...o,
});
const ctx = { now: NOW, replyEnabled: true, lastTickAt: ago(60_000), lastTickStatus: "ok" };

describe("OPS-07 connection health", () => {
  it("healthy only with a fresh heartbeat + authenticated session + active listener", () => {
    assert.deepEqual(classifyConnection(conn(), ctx), { state: "healthy", reasons: [] });
  });
  it("a running process with a stale heartbeat is NOT healthy", () => {
    assert.equal(classifyConnection(conn({ lastHeartbeatAt: ago(HEARTBEAT_STALE_MS + 1) }, { lastHeartbeatAt: ago(HEARTBEAT_STALE_MS + 1) }), ctx).state, "disconnected");
  });
  it("Zalo refused / kicked the session → authentication_required (manual check, no auto re-login)", () => {
    for (const e of ["session_rejected", "kicked_by_server", "kicked_duplicate_connection"]) {
      const h = classifyConnection(conn({}, { listenerState: "error", lastErrorCategory: e }), ctx);
      assert.deepEqual(h, { state: "authentication_required", reasons: [e] }, e);
    }
    assert.equal(classifyConnection(conn({}, { listenerState: "inactive", sessionState: "rejected" }), ctx).state, "authentication_required");
  });
  it("reconnecting = degraded; listener down = disconnected; switched off = stopped; never reported = unknown", () => {
    assert.equal(classifyConnection(conn({}, { listenerState: "reconnecting" }), ctx).state, "degraded");
    assert.equal(classifyConnection(conn({}, { listenerState: "inactive" }), ctx).state, "disconnected");
    assert.equal(classifyConnection(conn({ status: "disabled" }), ctx).state, "stopped");
    assert.deepEqual(classifyConnection(conn({ sync: null, accountBound: false }), ctx), { state: "unknown", reasons: ["never_connected"] });
  });
  it("degraded reasons: dead letters, paused, unknown delivery, failed sends, scheduler not running", () => {
    const h = classifyConnection(
      conn({ settings: { ...conn().settings!, sendPaused: true }, outbound: { ...conn().outbound!, unknown: 1, failed24h: 2 } }, { deadLetters: 3 }),
      { ...ctx, lastTickAt: ago(10 * 60_000) },
    );
    assert.equal(h.state, "degraded");
    assert.deepEqual(h.reasons, ["outbox_dead_letters", "send_paused", "delivery_unknown", "send_failed_24h", "reply_tick_stale"]);
  });
  it("reply tick staleness only matters while replies are on for that connection", () => {
    assert.equal(classifyConnection(conn({ settings: { ...conn().settings!, replyMode: "disabled" } }), { ...ctx, lastTickAt: null }).state, "healthy");
    assert.equal(classifyConnection(conn(), { ...ctx, replyEnabled: false, lastTickAt: null }).state, "healthy");
  });
});

describe("OPS-07 AI + reminder health", () => {
  const cfg = { enabled: true, provider: "gemini", apiKeyConfigured: true, modelValid: true };
  const ai = (o = {}) => ({ requests24h: 4, completed24h: 3, quotaErrors24h: 0, otherErrors24h: 0, refused24h: 0, inputTokens24h: 1, outputTokens24h: 1, providers: ["gemini"], lastOkAt: ago(60_000), lastErrorAt: null, lastErrorReason: null, ...o });
  it("configuration first: off / fake / missing key or model", () => {
    assert.equal(classifyAi(ai(), { ...cfg, enabled: false }), "unconfigured");
    assert.equal(classifyAi(ai(), { ...cfg, provider: "fake" }), "fake");
    assert.equal(classifyAi(ai(), { ...cfg, apiKeyConfigured: false }), "unconfigured");
  });
  it("quota exhausted after the last success → quota_limited; other error → failing; a later success → ok", () => {
    assert.equal(classifyAi(ai({ quotaErrors24h: 1, lastErrorAt: ago(1_000), lastErrorReason: "quota_exceeded" }), cfg), "quota_limited");
    assert.equal(classifyAi(ai({ otherErrors24h: 1, lastErrorAt: ago(1_000), lastErrorReason: "network" }), cfg), "failing");
    assert.equal(classifyAi(ai({ quotaErrors24h: 1, lastErrorAt: ago(120_000), lastErrorReason: "quota_exceeded" }), cfg), "ok");
    assert.equal(classifyAi(ai({ requests24h: 0 }), cfg), "idle");
  });
  it("reminder scheduler: off / stale (> 5 min) / behind / failing / ok", () => {
    const r = { pendingDue: 0, claimed: 0, failed: 0, lastOkAt: ago(60_000) };
    assert.equal(classifyReminders(r, false, NOW), "off");
    assert.equal(classifyReminders({ ...r, lastOkAt: ago(6 * 60_000) }, true, NOW), "stale");
    assert.equal(classifyReminders({ ...r, pendingDue: 2 }, true, NOW), "behind");
    assert.equal(classifyReminders({ ...r, failed: 1 }, true, NOW), "failing");
    assert.equal(classifyReminders(r, true, NOW), "ok");
  });
});

describe("OPS-06 reminder adapter (Zalo Personal → outbound queue)", () => {
  const CONN = "11111111-1111-4111-8111-111111111111";
  it("queues with the verified recipient + idempotency key; result = pending, never 'sent'", async () => {
    const calls: ReminderEnqueueInput[] = [];
    const a = zaloPersonalQueueAdapter(async (i) => (calls.push(i), { ok: true, draftId: "d", duplicate: false }), true);
    const gate = externalGate("zalo_personal", { killSwitch: false, zaloPersonalEnabled: true, zaloOaEnabled: false, maxPerUserPerHour: 6 }, { zalo_personal_enabled: true } as never, a, { recipientRef: zaloPersonalRecipientRef(CONN, "3000000000000000001"), sentLastHour: 0, wouldLoop: false });
    const exp = new Date(NOW.getTime() + 15 * 60_000);
    const r = await dispatchExternal(a, gate, { notificationId: "n1", userId: "u1", text: "[Nhắc việc] X", idempotencyKey: "n1:zalo_personal", expiresAt: exp });
    assert.deepEqual(r, { status: "pending", reason: null, retry: false });
    assert.deepEqual(calls, [{ connectionId: CONN, userId: "u1", externalUserId: "3000000000000000001", text: "[Nhắc việc] X", sourceKey: "n1:zalo_personal", notificationId: "n1", expiresAt: exp }]);
  });
  it("a malformed recipient never reaches the queue; a refused enqueue is a final failure (no blind retry)", async () => {
    let called = 0;
    const a = zaloPersonalQueueAdapter(async () => (called++, { ok: false, error: "not_verified" }), true);
    assert.deepEqual(await a.send({ notificationId: "n", userId: "u", recipientRef: "3000000000000000001", text: "x", idempotencyKey: "k" }), { state: "failed", retryable: false, code: "not_verified" });
    assert.equal(called, 0);
    assert.deepEqual(await a.send({ notificationId: "n", userId: "u", recipientRef: `${CONN}:3000000000000000001`, text: "x", idempotencyKey: "k" }), { state: "failed", retryable: false, code: "not_verified" });
  });
  it("kill switch / channel flag / preference / unverified recipient stop it before the adapter", () => {
    const a = zaloPersonalQueueAdapter(async () => ({ ok: true, draftId: "d", duplicate: false }), true);
    const base = { killSwitch: false, zaloPersonalEnabled: true, zaloOaEnabled: false, maxPerUserPerHour: 6 };
    const s = { recipientRef: `${CONN}:1`, sentLastHour: 0, wouldLoop: false };
    assert.deepEqual(externalGate("zalo_personal", { ...base, killSwitch: true }, { zalo_personal_enabled: true } as never, a, s), { allowed: false, reason: "kill_switch" });
    assert.deepEqual(externalGate("zalo_personal", { ...base, zaloPersonalEnabled: false }, { zalo_personal_enabled: true } as never, a, s), { allowed: false, reason: "channel_disabled" });
    assert.deepEqual(externalGate("zalo_personal", base, { zalo_personal_enabled: false } as never, a, s), { allowed: false, reason: "preference_off" });
    assert.deepEqual(externalGate("zalo_personal", base, { zalo_personal_enabled: true } as never, a, { ...s, recipientRef: null }), { allowed: false, reason: "not_verified" });
    assert.deepEqual(externalGate("zalo_personal", base, { zalo_personal_enabled: true } as never, zaloPersonalQueueAdapter(async () => ({ ok: true, draftId: "d", duplicate: false }), false), s), { allowed: false, reason: "adapter_unavailable" });
  });
  it("send window = the catch-up policy: DAY 60′, HOUR 15′, OVERDUE 60′, MORNING until 10:00 VN", () => {
    const r = { dayGraceMs: 60 * 60_000, hourGraceMs: 15 * 60_000, overdueOnTimeMs: 60 * 60_000, morningCutoffHour: 10 };
    const at = new Date("2026-11-26T01:05:00Z"); // 08:05 VN
    assert.equal(externalExpiry("deadline_day", at, r).toISOString(), "2026-11-26T02:05:00.000Z");
    assert.equal(externalExpiry("deadline_hour", at, r).toISOString(), "2026-11-26T01:20:00.000Z");
    assert.equal(externalExpiry("overdue_digest", at, r).toISOString(), "2026-11-26T02:05:00.000Z");
    assert.equal(externalExpiry("morning_digest", at, r).toISOString(), "2026-11-26T03:00:00.000Z", "10:00 VN");
  });
});

describe("PHASE 07 permissions", () => {
  it("operations + reply configuration are admin-only", () => {
    assert.equal(hasPermission("admin", "zalo_personal:operate"), true);
    assert.equal(hasPermission("staff", "zalo_personal:operate"), false);
    assert.equal(hasPermission("viewer", "zalo_personal:operate"), false);
  });
});
