// ============================================================
// PHASE 06 — Notification channels (TASK-10 / TASK-11). Pure + injected.
//
// Web Inbox is THE channel of this phase: the inbox row and its 'delivered'
// web delivery are written by SQL in the same transaction as the reminder's
// final status (ai_reminder_resolve), so a web reminder is never "unknown".
//
// Zalo Personal / Zalo OA: ADAPTER CONTRACT ONLY. Phase 04.5 (a verified
// sending path for Zalo Personal) has not been built — the worker only listens,
// and no group has send_verified_at — and Zalo OA may only message a user
// inside its interaction window, which this code cannot verify. So no real
// adapter exists: both are `available: false`, and every gate below must pass
// before an adapter is even called:
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
}

export type ChannelSendResult =
  | { state: "sent"; providerMessageId: string | null }
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
  | { status: "failed"; reason: string; retry: boolean }
  | { status: "unknown"; reason: string; retry: false }
  | { status: "skipped"; reason: GateReason; retry: false };

/** One external delivery attempt; never throws (an adapter exception = unknown outcome). */
export async function dispatchExternal(adapter: NotificationChannelAdapter, gate: ReturnType<typeof externalGate>, input: Omit<ChannelSendInput, "recipientRef">): Promise<DeliveryRecord> {
  if (!gate.allowed) return { status: "skipped", reason: gate.reason, retry: false };
  try {
    const r = await adapter.send({ ...input, recipientRef: gate.recipientRef });
    if (r.state === "sent") return { status: "sent", providerMessageId: r.providerMessageId, reason: null, retry: false };
    if (r.state === "unknown") return { status: "unknown", reason: r.code, retry: false };
    return { status: "failed", reason: r.code, retry: r.retryable };
  } catch {
    // the request may have left: do not retry blindly
    return { status: "unknown", reason: "adapter_exception", retry: false };
  }
}
