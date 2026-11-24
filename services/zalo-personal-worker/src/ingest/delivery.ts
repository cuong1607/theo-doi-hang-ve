// ============================================================
// Delivery loop: outbox → backend, at-least-once.
//
//   2xx               each event's result (stored / recorded / duplicate /
//                     ignored / rejected) is FINAL → removed from the outbox
//   5xx / timeout /   retry the batch later: exponential backoff + jitter,
//   network / 429     per-event attempt counter; after maxAttempts → dead letter
//   409 nonce         immediate retry with a new request
//   409 not bound     wait for a heartbeat, retry later
//   400 / 413         resend the batch one event at a time; a lone bad event → dead letter
//   401 / 403 / 409   AUTH PAUSE: nothing is retried until restart / secret
//   (account)         fix — never an infinite retry loop on a permanent error
//
// "Logically once": if the server stored a batch but the worker died before
// removing it, the resend gets `duplicate` (database idempotency) and is
// removed then. Only one request in flight; stop() waits for it, and every
// outbox write is atomic, so a shutdown never corrupts the outbox.
// ============================================================
import { backoffDelay } from "../connection-state.ts";
import { safeError, type Logger } from "../logger.ts";
import { classifyResult, type HttpResult } from "./http-client.ts";
import { OutboxCorruptError, type Outbox, type OutboxEntry } from "./outbox.ts";
import type { WireEvent } from "./serializer.ts";

export const EVENTS_PATH = "/api/internal/zalo-personal/events";

interface ServerResult {
  eventKey: string;
  status: string;
  reason: string | null;
}

function bodyOf(r: HttpResult): Record<string, unknown> | null {
  return r.kind === "response" ? r.body : null;
}

function resultsOf(r: HttpResult): ServerResult[] {
  const results = bodyOf(r)?.results;
  return Array.isArray(results) ? (results as ServerResult[]).filter((x) => x && typeof x.eventKey === "string" && typeof x.status === "string") : [];
}

function errorOf(r: HttpResult): string | null {
  const e = bodyOf(r)?.error;
  return typeof e === "string" ? e : null;
}

export interface AuthGate {
  failed: boolean;
  reason: string | null;
}

export interface DeliveryOptions {
  outbox: Outbox;
  post(path: string, payload: unknown, signal?: AbortSignal): Promise<HttpResult>;
  connectionKey: string;
  accountId: () => string | null;
  auth: AuthGate;
  logger: Logger;
  batchSize: number;
  maxAttempts: number;
  backoff: { baseMs: number; maxMs: number };
  pollMs: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type RunOutcome = "idle" | "delivered" | "backoff" | "paused" | "no_account";

export interface DeliveryStats {
  lastDeliveryOkAt: number | null;
  consecutiveFailures: number;
  stored: number;
  duplicates: number;
  rejected: number;
  deadLettered: number;
  lastErrorCategory: string | null;
}

export class DeliveryService {
  private readonly o: DeliveryOptions;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private backoffUntil = 0;
  /** remaining runs that must send ONE event (isolating a bad event after 400/413) */
  private isolateRuns = 0;
  readonly stats: DeliveryStats = { lastDeliveryOkAt: null, consecutiveFailures: 0, stored: 0, duplicates: 0, rejected: 0, deadLettered: 0, lastErrorCategory: null };

  constructor(options: DeliveryOptions) {
    this.o = options;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  start(): void {
    if (this.loop) return;
    const sleep = this.o.sleep ?? defaultSleep;
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        let outcome: RunOutcome;
        try {
          outcome = await this.runOnce();
        } catch (err) {
          this.o.logger.error("delivery_loop_error", { error: safeError(err) });
          outcome = "backoff";
        }
        if (this.abort.signal.aborted) break;
        const wait = outcome === "delivered" ? 0 : outcome === "backoff" ? Math.max(this.o.pollMs, this.backoffUntil - this.now()) : this.o.pollMs;
        if (wait > 0) await sleep(wait, this.abort.signal);
      }
    })();
  }

  /** Stops after the in-flight request (bounded by the HTTP timeout). */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  /** One batch. Exposed for tests. */
  async runOnce(): Promise<RunOutcome> {
    const { outbox, logger } = this.o;
    if (this.o.auth.failed) return "paused";
    const now = this.now();
    if (now < this.backoffUntil) return "backoff";
    const accountId = this.o.accountId();
    if (!accountId) return "no_account";

    const entries = outbox.due(now, this.isolateRuns > 0 ? 1 : this.o.batchSize);
    if (!entries.length) return "idle";
    if (this.isolateRuns > 0) this.isolateRuns--;

    const batch: Array<{ entry: OutboxEntry; event: WireEvent }> = [];
    for (const entry of entries) {
      try {
        batch.push({ entry, event: await outbox.read(entry) });
      } catch (err) {
        await outbox.deadLetter(entry, err instanceof OutboxCorruptError ? "unreadable" : "read_failed");
        this.stats.deadLettered++;
      }
    }
    if (!batch.length) return "delivered";

    const result = await this.o.post(EVENTS_PATH, { v: 1, connectionKey: this.o.connectionKey, accountId, events: batch.map((b) => b.event) });
    const cls = classifyResult(result);
    const status = result.kind === "response" ? result.status : result.error;

    switch (cls) {
      case "success": {
        const byKey = new Map(resultsOf(result).map((r) => [r.eventKey, r]));
        const missing: OutboxEntry[] = [];
        for (const { entry } of batch) {
          const r = byKey.get(entry.eventKey);
          if (!r) {
            missing.push(entry);
            continue;
          }
          if (r.status === "duplicate") this.stats.duplicates++;
          else if (r.status === "rejected") {
            this.stats.rejected++;
            logger.warn("event_rejected_by_server", { reason: r.reason });
          } else this.stats.stored++;
          await outbox.ack(entry);
        }
        this.stats.consecutiveFailures = 0;
        this.stats.lastDeliveryOkAt = this.now();
        this.stats.lastErrorCategory = null;
        if (missing.length) await this.retryLater(missing, "missing_result", false);
        logger.debug("batch_delivered", { events: batch.length });
        return "delivered";
      }
      case "retry_now":
        for (const { entry } of batch) await this.bumpOrDead(entry, this.now(), "nonce_reused");
        return "delivered";
      case "split":
        if (batch.length > 1) {
          this.isolateRuns = batch.length;
          logger.warn("batch_rejected_isolating", { status, events: batch.length });
          return "delivered";
        }
        await outbox.deadLetter(batch[0]!.entry, `http_${status}`);
        this.stats.deadLettered++;
        logger.error("event_dead_lettered", { reason: `http_${status}`, error: errorOf(result) });
        return "delivered";
      case "auth": {
        const error = errorOf(result) ?? `http_${status}`;
        this.o.auth.failed = true;
        this.o.auth.reason = error;
        this.stats.lastErrorCategory = "auth_failed";
        logger.error("delivery_paused_auth", { status, error, hint: "Kiểm tra worker key / secret / đồng hồ máy, rồi khởi động lại worker. Outbox được giữ nguyên." });
        return "paused";
      }
      case "rate_limited":
      case "not_bound":
      case "retry":
      default: {
        const retryAfter = result.kind === "response" ? result.retryAfterMs : null;
        await this.retryLater(batch.map((b) => b.entry), cls === "retry" ? String(status) : cls, true, retryAfter);
        return "backoff";
      }
    }
  }

  private async retryLater(entries: OutboxEntry[], error: string, countFailure: boolean, retryAfterMs: number | null = null): Promise<void> {
    if (countFailure) this.stats.consecutiveFailures++;
    this.stats.lastErrorCategory = error === "rate_limited" ? "rate_limited" : error === "not_bound" ? "account_not_bound" : "backend_unreachable";
    const delay = Math.max(retryAfterMs ?? 0, backoffDelay(Math.max(1, this.stats.consecutiveFailures), this.o.backoff, this.o.random));
    const at = this.now() + delay;
    if (countFailure) this.backoffUntil = at;
    for (const entry of entries) await this.bumpOrDead(entry, at, error);
    this.o.logger.warn("delivery_retry_scheduled", { events: entries.length, error, delayMs: delay, consecutiveFailures: this.stats.consecutiveFailures });
  }

  private async bumpOrDead(entry: OutboxEntry, at: number, error: string): Promise<void> {
    if (entry.attempts + 1 >= this.o.maxAttempts) {
      await this.o.outbox.deadLetter(entry, `max_attempts:${error}`);
      this.stats.deadLettered++;
      this.o.logger.error("event_dead_lettered", { reason: "max_attempts", lastError: error });
      return;
    }
    await this.o.outbox.reschedule(entry, at, error);
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
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
