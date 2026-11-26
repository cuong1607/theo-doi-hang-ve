// ============================================================
// PHASE 06 — Notification channels (TASK-10 / TASK-11). Pure + injected.
//
// Web Inbox is THE channel of this phase: the inbox row and its 'delivered'
// web delivery are written by SQL in the same transaction as the reminder's
// final status (ai_reminder_resolve), so a web reminder is never "unknown".
//
// Zalo Personal (PHASE 07): zaloPersonalQueueAdapter below — the reminder goes
// into the Phase 04.5 outbound queue, sent only by the connection's worker.
// Zalo OA: still contract only (`available: false`): OA may only message a user
// inside its interaction window, which this code cannot verify.
// Every gate below must pass before an adapter is even called:
//   kill switch (ON by default) → channel flag (OFF by default) → user preference
//   → adapter available → recipient verified (linked account of THIS user)
//   → per-user hourly rate limit → anti-loop.
// A send whose outcome is not known (timeout after the request left) is
// recorded 'unknown' and NEVER retried automatically; only a failure known not
// to have delivered anything is retried (with backoff).
// ============================================================
import type { ExternalChannelConfig } from "./config.ts";
import type { ReminderPrefs } from "./reminders.ts";

export type ExternalChannel = "zalo_personal" | "zalo_oa";

export interface ChannelSendInput {
  notificationId: string;
  userId: string;
  /** verified external id of THIS user on that channel (never taken from a message) */
  recipientRef: string;
  text: string;
  idempotencyKey: string;
  /** PHASE 07: a queued reminder not sent by then is dropped (no stale catch-up after an outage) */
  expiresAt?: Date;
}

export type ChannelSendResult =
  | { state: "sent"; providerMessageId: string | null }
  // PHASE 07: handed to a durable queue; the real outcome is written later by the sender
  | { state: "queued" }
  | { state: "failed"; retryable: boolean; code: string }
  | { state: "unknown"; code: string };

export interface NotificationChannelAdapter {
  readonly channel: ExternalChannel;
  readonly available: boolean;
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
}

/** The only adapters this phase ships: nothing can be sent. */
export const unavailableAdapter = (channel: ExternalChannel): NotificationChannelAdapter => ({
  channel,
  available: false,
  async send() {
    return { state: "failed", retryable: false, code: "adapter_unavailable" };
  },
});

export type GateReason = "kill_switch" | "channel_disabled" | "preference_off" | "adapter_unavailable" | "not_verified" | "rate_limited" | "loop";

export interface GateState {
  /** verified external id for this user on this channel, or null */
  recipientRef: string | null;
  sentLastHour: number;
  /** the text would be sent into a conversation the engine itself analyses (e.g. the source group) */
  wouldLoop: boolean;
}

export function externalGate(channel: ExternalChannel, cfg: ExternalChannelConfig, prefs: ReminderPrefs, adapter: NotificationChannelAdapter, s: GateState): { allowed: true; recipientRef: string } | { allowed: false; reason: GateReason } {
  if (cfg.killSwitch) return { allowed: false, reason: "kill_switch" };
  if (channel === "zalo_personal" ? !cfg.zaloPersonalEnabled : !cfg.zaloOaEnabled) return { allowed: false, reason: "channel_disabled" };
  if (channel === "zalo_personal" ? !prefs.zalo_personal_enabled : !prefs.zalo_oa_enabled) return { allowed: false, reason: "preference_off" };
  if (!adapter.available) return { allowed: false, reason: "adapter_unavailable" };
  if (!s.recipientRef) return { allowed: false, reason: "not_verified" };
  if (s.sentLastHour >= cfg.maxPerUserPerHour) return { allowed: false, reason: "rate_limited" };
  if (s.wouldLoop) return { allowed: false, reason: "loop" };
  return { allowed: true, recipientRef: s.recipientRef };
}

export type DeliveryRecord =
  | { status: "sent"; providerMessageId: string | null; reason: null; retry: false }
  | { status: "pending"; reason: null; retry: false }
  | { status: "failed"; reason: string; retry: boolean }
  | { status: "unknown"; reason: string; retry: false }
  | { status: "skipped"; reason: GateReason; retry: false };

// ------------------------------------------------------------------ PHASE 07: Zalo Personal via the outbound queue

export interface ReminderEnqueueInput {
  connectionId: string;
  userId: string;
  externalUserId: string;
  text: string;
  sourceKey: string;
  notificationId: string | null;
  expiresAt: Date;
}
export type ReminderEnqueue = (i: ReminderEnqueueInput) => Promise<{ ok: true; draftId: string | null; duplicate: boolean } | { ok: false; error: string }>;

/** recipientRef of Zalo Personal = "<connection uuid>:<zalo user id>" (both from a verified identity row) */
export function zaloPersonalRecipientRef(connectionId: string, externalUserId: string): string {
  return `${connectionId}:${externalUserId}`;
}

const REF = /^([0-9a-f-]{36}):([0-9]{1,32})$/i;

/**
 * The real Zalo Personal adapter: it never talks to Zalo. It puts the reminder
 * into the durable outbound queue (zalo_personal_reply_drafts, kind
 * 'reminder', idempotent per notification) that ONLY the connection's worker
 * claims — after the same last-moment gates as every reply (emergency stop,
 * connection send switch, pause, caps, identity re-check, task still open).
 * 'queued' ≠ 'sent': the delivery row stays 'pending' until the worker reports.
 */
export function zaloPersonalQueueAdapter(enqueue: ReminderEnqueue, available: boolean): NotificationChannelAdapter {
  return {
    channel: "zalo_personal",
    available,
    async send(input) {
      const m = REF.exec(input.recipientRef);
      if (!m) return { state: "failed", retryable: false, code: "not_verified" };
      const r = await enqueue({
        connectionId: m[1]!,
        userId: input.userId,
        externalUserId: m[2]!,
        text: input.text,
        sourceKey: input.idempotencyKey,
        notificationId: input.notificationId,
        expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 60_000),
      });
      return r.ok ? { state: "queued" } : { state: "failed", retryable: false, code: r.error.replace(/[^a-z_]/g, "_").slice(0, 64) || "enqueue_failed" };
    },
  };
}

/**
 * How long a queued external reminder may wait for the worker — the Phase 06
 * catch-up policy applied to the SEND as well (worker offline → dropped, never
 * a burst of stale reminders when it comes back):
 *   DAY 60′ · HOUR 15′ · OVERDUE (+digest) 60′ · MORNING until the cut-off hour (VN) · others 30′
 */
export function externalExpiry(kind: string, now: Date, r: { dayGraceMs: number; hourGraceMs: number; overdueOnTimeMs: number; morningCutoffHour: number }): Date {
  const at = (ms: number) => new Date(now.getTime() + ms);
  if (kind === "deadline_day") return at(r.dayGraceMs);
  if (kind === "deadline_hour") return at(r.hourGraceMs);
  if (kind === "overdue" || kind === "overdue_digest") return at(r.overdueOnTimeMs);
  if (kind === "morning_digest") {
    const vn = new Date(now.getTime() + 7 * 3_600_000);
    const cutoff = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), r.morningCutoffHour) - 7 * 3_600_000;
    return new Date(Math.max(cutoff, now.getTime() + 60_000));
  }
  return at(30 * 60_000);
}

/** One external delivery attempt; never throws (an adapter exception = unknown outcome). */
export async function dispatchExternal(adapter: NotificationChannelAdapter, gate: ReturnType<typeof externalGate>, input: Omit<ChannelSendInput, "recipientRef">): Promise<DeliveryRecord> {
  if (!gate.allowed) return { status: "skipped", reason: gate.reason, retry: false };
  try {
    const r = await adapter.send({ ...input, recipientRef: gate.recipientRef });
    if (r.state === "sent") return { status: "sent", providerMessageId: r.providerMessageId, reason: null, retry: false };
    if (r.state === "queued") return { status: "pending", reason: null, retry: false };
    if (r.state === "unknown") return { status: "unknown", reason: r.code, retry: false };
    return { status: "failed", reason: r.code, retry: r.retryable };
  } catch {
    // the request may have left: do not retry blindly
    return { status: "unknown", reason: "adapter_exception", retry: false };
  }
}
