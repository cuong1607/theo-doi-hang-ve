// ============================================================
// ZP-07: connection lifecycle.
//
// One attempt = restore the saved session (login with cookies) + start ONE
// listener. Outcomes:
//   connected → stays until the listener closes or stop() is called
//   closed 3000 / 3003 (Zalo Web opened elsewhere / kicked) → error, no retry
//   session refused by Zalo → session marked "rejected", error, no retry
//   network failure / abnormal close / connect timeout → reconnecting with
//     bounded exponential backoff; after maxAttempts consecutive failures → error
// The attempt counter resets after a successful connection.
//
// Never more than one listener: the previous one is detached and stopped
// before a new attempt, and run() refuses to start twice.
// QR login is NOT done here (it needs the operator): see qr-login.ts / `npm run login`.
// ============================================================
import type { WorkerConfig } from "./config.ts";
import { backoffDelay, NO_RETRY_CLOSE_CODES, nextState, type ConnectionEvent, type ConnectionState, type ErrorReason } from "./connection-state.ts";
import type { RawEventName } from "./event-normalizer.ts";
import type { HealthMonitor } from "./health-monitor.ts";
import { safeError, type Logger } from "./logger.ts";
import { attachListener } from "./message-listener.ts";
import type { SessionManager } from "./session-manager.ts";
import { classifyLoginError, type ZaloConnector, type ZaloSession } from "./zalo-client.ts";

export type RunResult = { state: "disconnected" } | { state: "error"; reason: ErrorReason };

export interface ConnectionManagerDeps {
  connector: ZaloConnector;
  sessions: Pick<SessionManager, "load" | "markRejected">;
  config: Pick<WorkerConfig, "reconnect" | "connectTimeoutMs">;
  logger: Logger;
  health: HealthMonitor;
  onEvent(name: RawEventName, raw: unknown): void;
  onSession?(session: ZaloSession | null): void;
  /** Abortable sleep (tests inject an instant one). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
}

type ListenOutcome = { type: "stopped" | "timeout" } | { type: "closed"; code: number };

class LoginTimeoutError extends Error {
  constructor() {
    super("login timeout");
    this.name = "TimeoutError";
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class ConnectionManager {
  private readonly deps: ConnectionManagerDeps;
  private stateValue: ConnectionState = "disconnected";
  private readonly abort = new AbortController();
  private running = false;
  private active: ZaloSession | null = null;

  constructor(deps: ConnectionManagerDeps) {
    this.deps = deps;
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  get stopping(): boolean {
    return this.abort.signal.aborted;
  }

  /** Graceful stop: closes the listener and makes run() resolve with "disconnected". */
  stop(reason: string): void {
    if (this.abort.signal.aborted) return;
    this.deps.logger.info("stop_requested", { reason });
    this.abort.abort();
  }

  async run(): Promise<RunResult> {
    if (this.running) throw new Error("ConnectionManager.run() đang chạy.");
    this.running = true;
    const { logger, config } = this.deps;
    const sleep = this.deps.sleep ?? abortableSleep;
    try {
      this.go("start");
      let attempt = 0;
      for (;;) {
        if (this.stopping) return this.finishStopped();

        // 1. saved session
        let loaded;
        try {
          loaded = await this.deps.sessions.load();
        } catch (err) {
          logger.error("session_unreadable", { error: safeError(err) });
          return this.fail("session_unreadable", "fatal");
        }
        if (loaded.status === "none") return this.fail("no_session", "fatal");
        if (loaded.status === "rejected") return this.fail("session_rejected", "session_rejected");

        // 2. login with the saved session
        let session: ZaloSession | null = null;
        try {
          session = await this.withTimeout(this.deps.connector.loginWithSession(loaded.credentials), config.connectTimeoutMs);
        } catch (err) {
          if (this.stopping) return this.finishStopped();
          if (err instanceof LoginTimeoutError || classifyLoginError(err) === "network") {
            logger.warn("login_network_error", { error: safeError(err) });
          } else {
            logger.error("session_rejected", { error: safeError(err) });
            await this.deps.sessions.markRejected().catch(() => {});
            return this.fail("session_rejected", "session_rejected");
          }
        }

        // 3. one listener
        let connected = false;
        if (session) {
          if (this.stopping) return this.finishStopped();
          this.go("login_ok");
          this.active = session;
          this.deps.onSession?.(session);
          const outcome = await this.listen(session, () => {
            connected = true;
          });
          this.detach();
          if (outcome.type === "stopped" || this.stopping) return this.finishStopped();
          if (outcome.type === "closed") {
            const noRetry = NO_RETRY_CLOSE_CODES[outcome.code];
            logger.warn("listener_closed", { code: outcome.code, willRetry: !noRetry });
            if (noRetry) return this.fail(noRetry, "kicked");
          } else {
            logger.warn("listener_connect_timeout", { timeoutMs: config.connectTimeoutMs });
          }
        }

        // 4. bounded backoff
        if (connected) attempt = 0;
        this.go("connection_lost");
        attempt++;
        if (attempt > config.reconnect.maxAttempts) return this.fail("reconnect_exhausted", "give_up");
        const delayMs = backoffDelay(attempt, config.reconnect, this.deps.random);
        this.deps.health.setState("reconnecting", { reconnectAttempt: attempt });
        logger.warn("reconnect_scheduled", { attempt, maxAttempts: config.reconnect.maxAttempts, delayMs });
        await sleep(delayMs, this.abort.signal);
        if (this.stopping) return this.finishStopped();
        this.go("retry");
      }
    } finally {
      this.detach();
      this.running = false;
    }
  }

  private listen(session: ZaloSession, markConnected: () => void): Promise<ListenOutcome> {
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      let connected = false;
      let done = false;
      const finish = (outcome: ListenOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish({ type: "stopped" });
      const timer = setTimeout(() => {
        if (!connected) finish({ type: "timeout" });
      }, this.deps.config.connectTimeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });

      attachListener(session.listener, {
        onConnected: () => {
          if (done || connected) return;
          connected = true;
          clearTimeout(timer);
          markConnected();
          this.go("listener_connected", { reconnectAttempt: 0 });
        },
        onClosed: (code) => finish({ type: "closed", code }),
        onError: (error) => this.deps.logger.warn("listener_error", { error: safeError(error) }),
        onEvent: (name, raw) => {
          if (connected && !done) this.deps.onEvent(name, raw);
        },
      });
      try {
        session.listener.start();
      } catch (err) {
        this.deps.logger.error("listener_start_failed", { error: safeError(err) });
        finish({ type: "closed", code: -1 });
      }
    });
  }

  private detach(): void {
    const session = this.active;
    if (!session) return;
    this.active = null;
    try {
      session.listener.removeAllListeners();
    } catch {
      /* ignore */
    }
    try {
      session.listener.stop();
    } catch {
      /* ignore */
    }
    this.deps.onSession?.(null);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new LoginTimeoutError()), ms);
      promise.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  private go(event: ConnectionEvent, extra: { errorReason?: ErrorReason; reconnectAttempt?: number } = {}): void {
    const previousState = this.stateValue;
    const state = nextState(previousState, event);
    this.stateValue = state;
    this.deps.health.setState(state, extra);
    if (state !== previousState) this.deps.logger.info("state_changed", { state, previousState, ...extra });
  }

  private fail(reason: ErrorReason, event: ConnectionEvent): RunResult {
    this.detach();
    this.go(event, { errorReason: reason });
    return { state: "error", reason };
  }

  private finishStopped(): RunResult {
    this.detach();
    if (this.stateValue !== "disconnected") this.go("stop");
    return { state: "disconnected" };
  }
}
