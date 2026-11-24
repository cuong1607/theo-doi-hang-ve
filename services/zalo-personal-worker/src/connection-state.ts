// ============================================================
// ZP-07: connection lifecycle as an explicit state machine (pure).
//
//   disconnected ──start──► connecting ──need_qr──► qr_pending ──login_ok──► connecting
//   connecting ──listener_connected──► connected
//   connected ──connection_lost──► reconnecting ──retry──► connecting
//   reconnecting / connecting ──give_up──► error
//   any ──session_rejected | kicked | fatal──► error      (no automatic retry)
//   any ──stop──► disconnected
//
// `error` is terminal for the running process: leaving it needs an operator
// action (new QR login, or a restart after the cause is fixed).
// ============================================================

export const CONNECTION_STATES = ["disconnected", "connecting", "qr_pending", "connected", "reconnecting", "error"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type ConnectionEvent =
  | "start"
  | "need_qr"
  | "login_ok"
  | "listener_connected"
  | "connection_lost"
  | "retry"
  | "give_up"
  | "session_rejected"
  | "kicked"
  | "fatal"
  | "stop";

/** Why the connection is in `error` (shown in health.json; never contains personal data). */
export type ErrorReason =
  | "no_session"
  | "session_rejected"
  | "session_unreadable"
  | "kicked_duplicate_connection"
  | "kicked_by_server"
  | "reconnect_exhausted"
  | "qr_failed"
  | "qr_declined"
  | "qr_expired"
  | "fatal";

const TABLE: Record<ConnectionState, Partial<Record<ConnectionEvent, ConnectionState>>> = {
  disconnected: { start: "connecting", stop: "disconnected" },
  connecting: { need_qr: "qr_pending", login_ok: "connecting", listener_connected: "connected", connection_lost: "reconnecting", give_up: "error", session_rejected: "error", kicked: "error", fatal: "error", stop: "disconnected" },
  qr_pending: { login_ok: "connecting", give_up: "error", fatal: "error", stop: "disconnected" },
  connected: { connection_lost: "reconnecting", session_rejected: "error", kicked: "error", fatal: "error", stop: "disconnected" },
  reconnecting: { retry: "connecting", give_up: "error", session_rejected: "error", kicked: "error", fatal: "error", stop: "disconnected" },
  error: { stop: "disconnected" },
};

export class InvalidTransitionError extends Error {
  constructor(from: ConnectionState, event: ConnectionEvent) {
    super(`Chuyển trạng thái không hợp lệ: ${from} --${event}-->`);
    this.name = "InvalidTransitionError";
  }
}

export function nextState(from: ConnectionState, event: ConnectionEvent): ConnectionState {
  const to = TABLE[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function canTransition(from: ConnectionState, event: ConnectionEvent): boolean {
  return TABLE[from][event] !== undefined;
}

/**
 * Bounded exponential backoff with "equal jitter": attempt 1 → ~base,
 * doubling, capped at maxMs; the delay is never below half of the step so a
 * burst of failures cannot hammer Zalo.
 */
export function backoffDelay(attempt: number, opts: { baseMs: number; maxMs: number }, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt phải >= 1");
  const step = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.min(attempt - 1, 20));
  const half = step / 2;
  return Math.round(half + random() * half);
}

/** Listener close codes (zca-js CloseReason) that must NOT be retried. */
export const NO_RETRY_CLOSE_CODES: Readonly<Record<number, ErrorReason>> = {
  3000: "kicked_duplicate_connection", // Zalo Web opened elsewhere for this account
  3003: "kicked_by_server",
};
