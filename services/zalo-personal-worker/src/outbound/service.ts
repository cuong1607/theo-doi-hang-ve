// ============================================================
// Phase 04.5 — outbound loop: the ONLY place a message leaves this account.
//
//   every tick  1. deliver pending reports (journal) to the backend
//               2. stop here when: paused (Zalo refused / auth), stopping,
//                  listener not connected, no account id, too soon after the
//                  previous send (local minimum interval)
//               3. claim ONE job (signed; the backend re-checks every gate)
//               4. journal "attempting" → send (timeout) → journal outcome
//               5. report; a "failed" (Zalo refused) pauses this loop until restart
// One job at a time, never in parallel. stop() waits for the in-flight send
// (bounded by its timeout) and its report attempt, so a graceful shutdown
// never loses a result; anything not yet claimed stays queued on the server.
// Never logged: message text, thread ids, secrets.
// ============================================================
import { safeError, type Logger } from "../logger.ts";
import type { HttpResult } from "../ingest/http-client.ts";
import type { ZaloSession } from "../zalo-client.ts";
import type { SendJournal } from "./journal.ts";
import { attemptSend, type SendOutcome } from "./sender.ts";

export const CLAIM_PATH = "/api/internal/zalo-personal/outbound/claim";
export const RESULT_PATH = "/api/internal/zalo-personal/outbound/result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutboundOptions {
  post(path: string, payload: unknown, signal?: AbortSignal): Promise<HttpResult>;
  journal: SendJournal;
  connectionKey: string;
  accountId: () => string | null;
  /** the current Zalo session, only while the listener is connected */
  session: () => ZaloSession | null;
  logger: Logger;
  pollMs: number;
  timeoutMs: number;
  minIntervalMs: number;
  /** realtime (nudge): poll this often for fastWindowMs after a message arrived */
  fastPollMs?: number;
  fastWindowMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type TickOutcome = "stopped" | "paused" | "not_ready" | "too_soon" | "idle" | "sent" | "not_sent" | "failed" | "unknown" | "backoff" | "duplicate";

export interface OutboundStats {
  sent: number;
  failed: number;
  unknown: number;
  notSent: number;
  lastSentAt: number | null;
  pausedReason: string | null;
  lastClaimReason: string | null;
}

interface Job {
  draftId: string;
  claimToken: string;
  threadId: string;
  threadType: "user" | "group";
  text: string;
}

function parseJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  if (typeof j.draftId !== "string" || !UUID.test(j.draftId)) return null;
  if (typeof j.claimToken !== "string" || !UUID.test(j.claimToken)) return null;
  if (typeof j.threadId !== "string" || !/^[0-9]{1,32}$/.test(j.threadId)) return null;
  if (j.threadType !== "user" && j.threadType !== "group") return null;
  if (typeof j.text !== "string" || j.text.trim().length === 0 || j.text.length > 2000) return null;
  return { draftId: j.draftId, claimToken: j.claimToken, threadId: j.threadId, threadType: j.threadType, text: j.text };
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export class OutboundService {
  private readonly o: OutboundOptions;
  private readonly controller = new AbortController();
  private loop: Promise<void> | null = null;
  private current: Promise<TickOutcome> | null = null;
  private lastSendAt = 0;
  private failures = 0;
  private fastUntil = 0;
  private wake: (() => void) | null = null;
  readonly stats: OutboundStats = { sent: 0, failed: 0, unknown: 0, notSent: 0, lastSentAt: null, pausedReason: null, lastClaimReason: null };

  constructor(o: OutboundOptions) {
    this.o = o;
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  start(): void {
    if (this.loop) return;
    this.loop = (async () => {
      while (!this.controller.signal.aborted) {
        let wait = this.o.pollMs;
        try {
          this.current = this.tick();
          const r = await this.current;
          if (r === "sent" || r === "not_sent" || r === "failed" || r === "unknown" || r === "duplicate") wait = this.o.minIntervalMs;
          else if (r === "backoff") wait = Math.min(this.o.pollMs * 2 ** Math.min(this.failures, 5), 10 * 60_000);
          else if (this.fastActive()) wait = Math.min(wait, this.o.fastPollMs ?? this.o.pollMs);
        } catch (err) {
          this.o.logger.error("outbound_tick_failed", { error: safeError(err) });
        } finally {
          this.current = null;
        }
        await this.idle(wait);
      }
    })();
  }

  private fastActive(): boolean {
    return this.now() < this.fastUntil;
  }

  /** Sleeps; stop() or nudge() ends the wait early. */
  private async idle(ms: number): Promise<void> {
    const sleep = this.o.sleep ?? defaultSleep;
    const ac = new AbortController();
    const onStop = () => ac.abort();
    this.controller.signal.addEventListener("abort", onStop, { once: true });
    this.wake = () => ac.abort();
    try {
      await sleep(ms, ac.signal);
    } finally {
      this.wake = null;
      this.controller.signal.removeEventListener("abort", onStop);
    }
  }

  /**
   * Realtime: a message from someone else just arrived. Claim now and then
   * every fastPollMs for fastWindowMs (the reply is drafted server-side within
   * seconds). Every gate (minimum interval, pause, backend checks) still applies.
   */
  nudge(): void {
    if (!this.o.fastWindowMs || this.controller.signal.aborted) return;
    this.fastUntil = this.now() + this.o.fastWindowMs;
    this.wake?.();
  }

  /** Graceful: no new claim; waits for the in-flight send (≤ its timeout) and its report. */
  async stop(): Promise<void> {
    this.controller.abort();
    await this.current?.catch(() => undefined);
    await this.loop?.catch(() => undefined);
    await this.flushReports().catch(() => undefined);
  }

  pause(reason: string): void {
    if (!this.stats.pausedReason) {
      this.stats.pausedReason = reason;
      this.o.logger.warn("outbound_paused", { reason });
    }
  }

  /** Sends the journal's unreported outcomes. */
  async flushReports(): Promise<void> {
    for (const e of this.o.journal.unreported()) {
      const r = await this.o.post(RESULT_PATH, { v: 1, connectionKey: this.o.connectionKey, draftId: e.draftId, claimToken: e.claimToken, outcome: e.outcome ?? "unknown", zaloMsgId: e.outcome === "sent" ? e.zaloMsgId : null, errorCategory: e.outcome === "sent" ? null : e.category });
      const status = r.kind === "response" ? r.status : 0;
      // 2xx = recorded; 404 unknown_job / 400 = the server will never accept it: stop retrying it
      if ((status >= 200 && status < 300) || status === 404 || status === 400) await this.o.journal.markReported(e.draftId);
      else if (status === 401 || status === 403) {
        this.pause("auth_failed");
        return;
      } else return; // backend unreachable: keep it for the next tick
    }
  }

  async tick(): Promise<TickOutcome> {
    await this.flushReports().catch((err) => this.o.logger.warn("outbound_report_failed", { error: safeError(err) }));
    if (this.controller.signal.aborted) return "stopped";
    if (this.stats.pausedReason) return "paused";
    const session = this.o.session();
    const accountId = this.o.accountId();
    if (!session || !accountId) return "not_ready";
    if (this.lastSendAt && this.now() - this.lastSendAt < this.o.minIntervalMs) return "too_soon";

    const res = await this.o.post(CLAIM_PATH, { v: 1, connectionKey: this.o.connectionKey, accountId, listenerState: "active" }, this.controller.signal);
    if (res.kind === "network") {
      this.failures++;
      return "backoff";
    }
    if (res.status === 401 || res.status === 403 || (res.status === 409 && res.body?.error !== "nonce_reused")) {
      this.pause(typeof res.body?.error === "string" ? `claim_${res.body.error}`.slice(0, 64) : "auth_failed");
      return "paused";
    }
    if (res.status < 200 || res.status >= 300) {
      this.failures++;
      return "backoff";
    }
    this.failures = 0;
    this.stats.lastClaimReason = typeof res.body?.reason === "string" ? res.body.reason : null;
    if (!res.body?.job) return "idle";
    const job = parseJob(res.body.job);
    if (!job) {
      this.o.logger.warn("outbound_invalid_job");
      return "idle";
    }

    // never twice: a job already attempted is reported, not resent
    if (this.o.journal.has(job.draftId)) {
      const prev = this.o.journal.get(job.draftId)!;
      if (prev.state === "attempting" || prev.outcome === null) await this.o.journal.finish(job.draftId, { outcome: "unknown", zaloMsgId: null, category: "duplicate_claim" });
      await this.flushReports().catch(() => undefined);
      return "duplicate";
    }

    await this.o.journal.begin(job.draftId, job.claimToken);
    this.lastSendAt = this.now();
    const attempt = attemptSend(session, job, this.o.timeoutMs);
    const outcome: SendOutcome = await attempt.result;
    await this.o.journal.finish(job.draftId, outcome);
    if (outcome.outcome === "unknown") {
      // a late answer from zca-js still upgrades unknown → sent (reported on a later tick)
      void attempt.late.then((late) => (late.outcome === "sent" ? this.o.journal.finish(job.draftId, late) : undefined)).catch(() => undefined);
    }
    this.count(outcome);
    if (outcome.outcome === "failed") this.pause(outcome.category);
    await this.flushReports().catch((err) => this.o.logger.warn("outbound_report_failed", { error: safeError(err) }));
    this.o.logger.info("outbound_attempt", { outcome: outcome.outcome, category: outcome.category });
    return outcome.outcome;
  }

  private count(r: SendOutcome) {
    if (r.outcome === "sent") {
      this.stats.sent++;
      this.stats.lastSentAt = this.now();
    } else if (r.outcome === "failed") this.stats.failed++;
    else if (r.outcome === "unknown") this.stats.unknown++;
    else this.stats.notSent++;
  }
}
