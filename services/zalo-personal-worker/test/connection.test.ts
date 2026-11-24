import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";

import { ConnectionManager } from "../src/connection-manager.ts";
import { backoffDelay, canTransition, CONNECTION_STATES, InvalidTransitionError, nextState, type ConnectionEvent } from "../src/connection-state.ts";
import { HealthMonitor } from "../src/health-monitor.ts";
import type { LoadResult } from "../src/session-manager.ts";
import { captureLogger, FAKE_CREDENTIALS, MockConnector, MockListener, mockSession, networkError, rawGroupMessage, rejectedError, tempDir } from "./helpers.ts";

describe("connection-state: transitions", () => {
  it("happy path disconnected → connecting → connected", () => {
    let s = nextState("disconnected", "start");
    assert.equal(s, "connecting");
    s = nextState(s, "login_ok");
    s = nextState(s, "listener_connected");
    assert.equal(s, "connected");
  });

  it("QR path", () => {
    assert.equal(nextState("connecting", "need_qr"), "qr_pending");
    assert.equal(nextState("qr_pending", "login_ok"), "connecting");
  });

  it("lost → reconnecting → connecting; give_up → error", () => {
    assert.equal(nextState("connected", "connection_lost"), "reconnecting");
    assert.equal(nextState("reconnecting", "retry"), "connecting");
    assert.equal(nextState("reconnecting", "give_up"), "error");
  });

  it("session_rejected / kicked always land in error", () => {
    for (const from of ["connecting", "connected", "reconnecting"] as const) {
      assert.equal(nextState(from, "session_rejected"), "error");
      assert.equal(nextState(from, "kicked"), "error");
    }
  });

  it("error is terminal except for stop", () => {
    const events: ConnectionEvent[] = ["start", "need_qr", "login_ok", "listener_connected", "connection_lost", "retry", "give_up", "session_rejected", "kicked", "fatal"];
    for (const e of events) assert.equal(canTransition("error", e), false, e);
    assert.equal(nextState("error", "stop"), "disconnected");
  });

  it("stop is accepted from every state", () => {
    for (const s of CONNECTION_STATES) assert.equal(nextState(s, "stop"), "disconnected");
  });

  it("invalid transitions throw", () => {
    assert.throws(() => nextState("disconnected", "listener_connected"), InvalidTransitionError);
    assert.throws(() => nextState("connected", "start"), InvalidTransitionError);
  });
});

describe("connection-state: backoff", () => {
  const opts = { baseMs: 1000, maxMs: 30_000 };
  it("grows exponentially within [step/2, step]", () => {
    assert.equal(backoffDelay(1, opts, () => 0), 500);
    assert.equal(backoffDelay(1, opts, () => 1), 1000);
    assert.equal(backoffDelay(2, opts, () => 1), 2000);
    assert.equal(backoffDelay(4, opts, () => 1), 8000);
  });
  it("is capped at maxMs", () => {
    assert.equal(backoffDelay(10, opts, () => 1), 30_000);
    assert.equal(backoffDelay(1000, opts, () => 1), 30_000);
    assert.ok(backoffDelay(50, opts, () => 0) >= 15_000);
  });
  it("rejects attempt < 1", () => {
    assert.throws(() => backoffDelay(0, opts));
  });
});

// ------------------------------------------------------------ manager
async function setup(steps: ConstructorParameters<typeof MockConnector>[0], options: { load?: LoadResult | Error; maxAttempts?: number } = {}) {
  const { dir, cleanup } = await tempDir();
  const { logger, lines } = captureLogger();
  const health = new HealthMonitor({ file: path.join(dir, "health.json"), connectionId: "primary" });
  const connector = new MockConnector(steps);
  const sleeps: number[] = [];
  const events: unknown[] = [];
  let rejectedMarks = 0;
  const load = options.load ?? { status: "active", savedAt: "x", credentials: FAKE_CREDENTIALS };
  const manager = new ConnectionManager({
    connector,
    sessions: {
      load: async () => {
        if (load instanceof Error) throw load;
        return load;
      },
      markRejected: async () => {
        rejectedMarks++;
      },
    },
    config: { reconnect: { baseMs: 1000, maxMs: 8000, maxAttempts: options.maxAttempts ?? 3 }, connectTimeoutMs: 200 },
    logger,
    health,
    onEvent: (name, raw) => events.push({ name, raw }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
  });
  return { manager, connector, health, lines, sleeps, events, get rejectedMarks() { return rejectedMarks; }, cleanup: async () => { await health.flush(); await cleanup(); } };
}

describe("connection-manager", () => {
  it("connects, forwards events only after connected, and stops gracefully", async () => {
    const listener = new MockListener();
    listener.onStart = (l) =>
      queueMicrotask(() => {
        l.emit("message", rawGroupMessage()); // before connected → ignored
        l.emit("connected");
        l.emit("message", rawGroupMessage());
      });
    const t = await setup([() => mockSession(listener)]);
    const running = t.manager.run();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.manager.state, "connected");
    assert.equal(t.events.length, 1);
    t.manager.stop("test");
    assert.deepEqual(await running, { state: "disconnected" });
    assert.equal(listener.stops, 1);
    assert.equal(listener.listenerCount("message"), 0, "listeners detached");
    assert.equal(t.health.current.state, "disconnected");
    await t.cleanup();
  });

  it("refuses to run twice (never two listeners)", async () => {
    const t = await setup([() => mockSession()]);
    const running = t.manager.run();
    await assert.rejects(() => t.manager.run(), /đang chạy/);
    t.manager.stop("test");
    await running;
    await t.cleanup();
  });

  it("abnormal close → reconnect with backoff, one listener at a time, counter reset after success", async () => {
    const l1 = new MockListener();
    l1.onStart = (l) => queueMicrotask(() => { l.emit("connected"); queueMicrotask(() => l.emit("closed", 1006, "")); });
    const l2 = new MockListener();
    l2.onStart = (l) => queueMicrotask(() => { l.emit("connected"); queueMicrotask(() => l.emit("closed", 1006, "")); });
    const l3 = new MockListener();
    const t = await setup([() => mockSession(l1), () => mockSession(l2), () => mockSession(l3)]);
    const running = t.manager.run();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(t.manager.state, "connected");
    assert.equal(t.connector.logins, 3);
    assert.deepEqual(t.sleeps, [1000, 1000], "attempt counter reset after each successful connection");
    assert.equal(l1.stops, 1);
    assert.equal(l2.stops, 1);
    assert.equal(l1.listenerCount("message") + l2.listenerCount("message"), 0, "old listeners detached");
    t.manager.stop("test");
    await running;
    await t.cleanup();
  });

  it("network errors at login → bounded exponential backoff, then error reconnect_exhausted", async () => {
    const t = await setup([networkError(), networkError(), networkError(), networkError()], { maxAttempts: 3 });
    assert.deepEqual(await t.manager.run(), { state: "error", reason: "reconnect_exhausted" });
    assert.deepEqual(t.sleeps, [1000, 2000, 4000]);
    assert.equal(t.connector.logins, 4);
    assert.equal(t.health.current.errorReason, "reconnect_exhausted");
    await t.cleanup();
  });

  it("connect timeout counts as a failed attempt", async () => {
    const silent = new MockListener();
    silent.onStart = () => {};
    const t = await setup([() => mockSession(silent), networkError()], { maxAttempts: 1 });
    assert.deepEqual(await t.manager.run(), { state: "error", reason: "reconnect_exhausted" });
    assert.equal(silent.stops, 1);
    await t.cleanup();
  });

  it("close 3000 (Zalo Web opened elsewhere) → error, NO reconnect", async () => {
    const l = new MockListener();
    l.onStart = (x) => queueMicrotask(() => { x.emit("connected"); queueMicrotask(() => x.emit("closed", 3000, "")); });
    const t = await setup([() => mockSession(l), () => mockSession()]);
    assert.deepEqual(await t.manager.run(), { state: "error", reason: "kicked_duplicate_connection" });
    assert.equal(t.connector.logins, 1);
    assert.deepEqual(t.sleeps, []);
    await t.cleanup();
  });

  it("close 3003 (kicked) → error, NO reconnect", async () => {
    const l = new MockListener();
    l.onStart = (x) => queueMicrotask(() => x.emit("closed", 3003, ""));
    const t = await setup([() => mockSession(l)]);
    assert.deepEqual(await t.manager.run(), { state: "error", reason: "kicked_by_server" });
    await t.cleanup();
  });

  it("session refused by Zalo → marked rejected, error, NO retry (no login loop)", async () => {
    const t = await setup([rejectedError(), () => mockSession()]);
    assert.deepEqual(await t.manager.run(), { state: "error", reason: "session_rejected" });
    assert.equal(t.connector.logins, 1);
    assert.equal(t.rejectedMarks, 1);
    assert.deepEqual(t.sleeps, []);
    assert.ok(!t.lines.join("\n").includes("SERVER_SECRET_ECHO"), "zca-js error message never logged");
    await t.cleanup();
  });

  it("a previously rejected session is not even tried", async () => {
    const t = await setup([() => mockSession()], { load: { status: "rejected", savedAt: "x" } });
    assert.deepEqual(await t.manager.run(), { state: "error", reason: "session_rejected" });
    assert.equal(t.connector.logins, 0);
    await t.cleanup();
  });

  it("no session → error no_session without any network call", async () => {
    const t = await setup([], { load: { status: "none" } });
    assert.deepEqual(await t.manager.run(), { state: "error", reason: "no_session" });
    assert.equal(t.connector.logins, 0);
    await t.cleanup();
  });

  it("unreadable session (decrypt failure) → error session_unreadable", async () => {
    const t = await setup([], { load: new Error("decrypt") });
    assert.deepEqual(await t.manager.run(), { state: "error", reason: "session_unreadable" });
    await t.cleanup();
  });

  it("stop during backoff ends cleanly", async () => {
    const { dir, cleanup } = await tempDir();
    const { logger } = captureLogger();
    const connector = new MockConnector([networkError(), networkError()]);
    const health = new HealthMonitor({ file: path.join(dir, "h.json"), connectionId: "primary" });
    const manager: ConnectionManager = new ConnectionManager({
      connector,
      sessions: { load: async () => ({ status: "active", savedAt: "x", credentials: FAKE_CREDENTIALS }), markRejected: async () => {} },
      config: { reconnect: { baseMs: 1000, maxMs: 8000, maxAttempts: 5 }, connectTimeoutMs: 200 },
      logger,
      health,
      onEvent: () => {},
      sleep: async () => manager.stop("during_backoff"),
    });
    assert.deepEqual(await manager.run(), { state: "disconnected" });
    assert.equal(connector.logins, 1);
    await health.flush();
    await cleanup();
  });
});
