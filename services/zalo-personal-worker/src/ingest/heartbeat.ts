// ============================================================
// Heartbeat → backend: separate, explicit signals instead of one "connected":
//   worker online             (the heartbeat itself arrives)
//   sessionState              Zalo session authenticated / rejected / …
//   listenerState             zca-js listener active / reconnecting / …
//   lastMessageReceivedAt     Zalo → worker
//   lastDeliveryOkAt          worker → backend (backend reachable)
//   (the server adds last_ingested_at itself)
// Sent on every connection state change and every interval. A 401 / 403
// opens the shared auth gate: heartbeats stop too (no infinite retry).
// ============================================================
import type { ConnectionState, ErrorReason } from "../connection-state.ts";
import { safeError, type Logger } from "../logger.ts";
import type { AuthGate, DeliveryService } from "./delivery.ts";
import { classifyResult, type HttpResult } from "./http-client.ts";
import type { Outbox } from "./outbox.ts";

export const HEARTBEAT_PATH = "/api/internal/zalo-personal/heartbeat";

export type SessionState = "unknown" | "authenticated" | "unauthenticated" | "rejected";
export type ListenerState = "unknown" | "active" | "connecting" | "reconnecting" | "inactive" | "error";

/** Connection-manager state → the two separate heartbeat signals. Pure. */
export function describeConnection(state: ConnectionState, errorReason: ErrorReason | null, everAuthenticated: boolean): { sessionState: SessionState; listenerState: ListenerState } {
  switch (state) {
    case "connected":
      return { sessionState: "authenticated", listenerState: "active" };
    case "connecting":
    case "qr_pending":
      return { sessionState: everAuthenticated ? "authenticated" : "unknown", listenerState: "connecting" };
    case "reconnecting":
      return { sessionState: everAuthenticated ? "authenticated" : "unknown", listenerState: "reconnecting" };
    case "error":
      return {
        sessionState: errorReason === "session_rejected" ? "rejected" : errorReason === "no_session" || errorReason === "session_unreadable" ? "unauthenticated" : everAuthenticated ? "authenticated" : "unknown",
        listenerState: "error",
      };
    default:
      return { sessionState: everAuthenticated ? "authenticated" : "unknown", listenerState: "inactive" };
  }
}

export interface HeartbeatSource {
  state(): { state: ConnectionState; errorReason: ErrorReason | null };
  accountId(): string | null;
  everAuthenticated(): boolean;
  lastMessageReceivedAt(): string | null;
}

export class HeartbeatReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending: Promise<void> = Promise.resolve();
  private readonly startedAt = new Date().toISOString();
  private readonly o: {
    post(path: string, payload: unknown): Promise<HttpResult>;
    connectionKey: string;
    workerVersion: string;
    intervalMs: number;
    source: HeartbeatSource;
    outbox: Outbox;
    delivery: DeliveryService;
    auth: AuthGate;
    logger: Logger;
  };
  lastOkAt: string | null = null;

  constructor(options: HeartbeatReporter["o"]) {
    this.o = options;
  }

  payload(): Record<string, unknown> {
    const { state, errorReason } = this.o.source.state();
    const stats = this.o.outbox.stats();
    const d = this.o.delivery.stats;
    return {
      v: 1,
      connectionKey: this.o.connectionKey,
      accountId: this.o.source.accountId(),
      workerVersion: this.o.workerVersion,
      workerStartedAt: this.startedAt,
      ...describeConnection(state, errorReason, this.o.source.everAuthenticated()),
      lastMessageReceivedAt: this.o.source.lastMessageReceivedAt(),
      lastDeliveryOkAt: d.lastDeliveryOkAt ? new Date(d.lastDeliveryOkAt).toISOString() : null,
      outboxDepth: stats.depth,
      deadLetterCount: stats.dead,
      outboxFullDrops: stats.fullDrops,
      lastErrorCategory: this.o.auth.failed ? "auth_failed" : state === "error" ? (errorReason ?? "error") : d.lastErrorCategory,
    };
  }

  /** Serialized: never two heartbeats in flight. */
  send(): Promise<void> {
    this.sending = this.sending.then(async () => {
      if (this.o.auth.failed) return;
      try {
        const res = await this.o.post(HEARTBEAT_PATH, this.payload());
        const cls = classifyResult(res);
        if (cls === "success") this.lastOkAt = new Date().toISOString();
        else if (cls === "auth") {
          this.o.auth.failed = true;
          this.o.auth.reason = res.kind === "response" && typeof res.body?.error === "string" ? res.body.error : "heartbeat_auth";
          this.o.logger.error("heartbeat_auth_failed", { error: this.o.auth.reason });
        } else this.o.logger.warn("heartbeat_failed", { status: res.kind === "response" ? res.status : res.error });
      } catch (err) {
        this.o.logger.warn("heartbeat_failed", { error: safeError(err) });
      }
    });
    return this.sending;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.send(), this.o.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
