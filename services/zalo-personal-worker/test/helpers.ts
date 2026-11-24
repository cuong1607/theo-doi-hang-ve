import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger, type Logger } from "../src/logger.ts";
import type { SessionCredentials } from "../src/session-manager.ts";
import type { ListenerLike, QrEvent, ZaloConnector, ZaloSession } from "../src/zalo-client.ts";

export const OWN_ID = "1000000000000000001";
export const GROUP_ALLOWED = "2000000000000000001";
export const GROUP_OTHER = "2000000000000000002";
export const FRIEND = "3000000000000000001";
export const NOW = new Date("2026-11-24T08:00:00.000Z");

export const FAKE_CREDENTIALS: SessionCredentials = {
  imei: "fake-imei-00000000-0000-0000-0000-000000000000",
  cookie: [{ key: "zpw_sek", value: "FAKE_COOKIE_VALUE_SHOULD_NEVER_APPEAR_IN_FILES", domain: "chat.zalo.me" }],
  userAgent: "Mozilla/5.0 (fake test agent)",
  language: "vi",
};

export function captureLogger(level: "debug" | "info" = "debug"): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ level, writer: (line) => lines.push(line), now: () => NOW }), lines };
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "zp-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A zca-js listener stand-in: tests decide what happens on start(). */
export class MockListener extends EventEmitter implements ListenerLike {
  starts = 0;
  stops = 0;
  onStart: (self: MockListener) => void = (self) => queueMicrotask(() => self.emit("connected"));

  override on(event: string, cb: (...args: never[]) => void): this {
    return super.on(event, cb as (...args: unknown[]) => void);
  }

  start(): void {
    this.starts++;
    this.onStart(this);
  }

  stop(): void {
    this.stops++;
  }
}

export function mockSession(listener: MockListener = new MockListener()): ZaloSession & { listener: MockListener; logouts: number } {
  const s = {
    listener,
    logouts: 0,
    ownId: () => OWN_ID,
    async logout() {
      s.logouts++;
    },
  };
  return s;
}

type SessionStep = (() => ZaloSession) | Error;

/** Scripted connector: each loginWithSession call consumes the next step. */
export class MockConnector implements ZaloConnector {
  readonly steps: SessionStep[];
  logins = 0;
  qrScript: ((emit: (e: QrEvent) => void) => Promise<ZaloSession>) | null = null;

  constructor(steps: SessionStep[] = []) {
    this.steps = steps;
  }

  async loginWithSession(): Promise<ZaloSession> {
    this.logins++;
    const step = this.steps.shift();
    if (!step) throw new Error("no more scripted logins");
    if (step instanceof Error) throw step;
    return step();
  }

  async loginWithQR(onEvent: (event: QrEvent) => void): Promise<ZaloSession> {
    if (!this.qrScript) throw new Error("no qr script");
    return this.qrScript(onEvent);
  }
}

export function networkError(): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = { code: "ECONNRESET" };
  return err;
}

export function rejectedError(): Error {
  const err = new Error('Đăng nhập thất bại {"error_code":-1,"data":"SERVER_SECRET_ECHO"}');
  err.name = "ZaloApiError";
  return err;
}

// ------------------------------------------------------------ raw zca-js-like payloads
export function rawGroupMessage(overrides: { threadId?: string; msgId?: string; uidFrom?: string; content?: unknown; isSelf?: boolean; ts?: unknown; mentions?: unknown; msgType?: string } = {}) {
  return {
    type: 1,
    threadId: overrides.threadId ?? GROUP_ALLOWED,
    isSelf: overrides.isSelf ?? false,
    data: {
      msgId: overrides.msgId ?? "7000000000001",
      cliMsgId: "1",
      uidFrom: overrides.uidFrom ?? FRIEND,
      idTo: overrides.threadId ?? GROUP_ALLOWED,
      dName: "Tên Hiển Thị",
      msgType: overrides.msgType ?? "webchat",
      ts: "ts" in overrides ? overrides.ts : String(NOW.getTime() - 1500),
      content: overrides.content ?? "xin chào nhóm",
      mentions: overrides.mentions,
    },
  };
}

export function rawDirectMessage(overrides: { uidFrom?: string; msgId?: string; content?: unknown; isSelf?: boolean } = {}) {
  const sender = overrides.uidFrom ?? FRIEND;
  return {
    type: 0,
    threadId: overrides.isSelf ? FRIEND : sender,
    isSelf: overrides.isSelf ?? false,
    data: { msgId: overrides.msgId ?? "7100000000001", uidFrom: overrides.isSelf ? OWN_ID : sender, idTo: OWN_ID, msgType: "webchat", ts: String(NOW.getTime()), content: overrides.content ?? "tin riêng tư" },
  };
}
