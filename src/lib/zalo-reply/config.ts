// ============================================================
// PHASE 04.5 — Zalo Personal AI Reply configuration. Pure. Everything is OFF
// by default; the BACKEND enforces every flag (the UI only reflects them).
//
//   PERSONAL_REPLY_ENABLED       router + draft generation + dashboard (default OFF)
//   PERSONAL_SEND_ENABLED        the worker may claim approved replies (default OFF)
//   PERSONAL_AUTO_REPLY_ENABLED  allowlisted conversations of an 'auto' connection
//                                may be sent without approval (default OFF)
//   PERSONAL_REPLY_GLOBAL_DAILY_LIMIT  sends per VN day, all connections (default 100)
//   PERSONAL_REPLY_MAX_PER_TICK  inbound questions processed per tick (default 5)
//   PERSONAL_REPLY_LEASE_SECONDS outbound claim lease (default 120)
//
// Per connection (DB, owner only): reply mode off / draft_only / auto, 1-1 on/off,
// unlinked guidance, cooldown, per-user / per-group / daily limits, draft TTL,
// send pause. Global DB emergency stop (dashboard) + worker STOP file +
// ZP_SEND_ENABLED on the worker: four independent ways to stop sending.
// ============================================================

type Env = Record<string, string | undefined>;

const on = (raw: string | undefined) => ["true", "1", "on", "yes"].includes((raw ?? "").trim().toLowerCase());
function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export interface ReplyConfig {
  enabled: boolean;
  sendEnabled: boolean;
  autoReplyEnabled: boolean;
  globalDailyLimit: number;
  maxPerTick: number;
  leaseSeconds: number;
  /** scan batches per connection per tick */
  scanBatch: number;
  /** a message is scanned only once it is this old (concurrent commits) */
  scanLagMs: number;
}

export function getReplyConfig(env: Env = process.env): ReplyConfig {
  const enabled = on(env.PERSONAL_REPLY_ENABLED);
  const sendEnabled = enabled && on(env.PERSONAL_SEND_ENABLED);
  return {
    enabled,
    sendEnabled,
    // auto needs sending, which needs replies
    autoReplyEnabled: sendEnabled && on(env.PERSONAL_AUTO_REPLY_ENABLED),
    globalDailyLimit: int(env.PERSONAL_REPLY_GLOBAL_DAILY_LIMIT, 100, 1, 2000),
    maxPerTick: int(env.PERSONAL_REPLY_MAX_PER_TICK, 5, 1, 20),
    leaseSeconds: int(env.PERSONAL_REPLY_LEASE_SECONDS, 120, 30, 600),
    scanBatch: 200,
    scanLagMs: 3_000,
  };
}

/** The explicit bot command (whole word at the start of the message). */
export const BOT_COMMAND = "/bot";
/** Hard cap of one Zalo reply (characters). */
export const MAX_REPLY_CHARS = 1800;
