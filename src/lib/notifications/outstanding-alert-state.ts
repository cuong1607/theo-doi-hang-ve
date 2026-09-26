// Pure state-machine logic for the LOW_STOCK_ALERT event (Phase ZL4) — kept
// separate from evaluateOutstandingNotifications() (DB access) so the
// transition rules themselves are unit-testable with plain `node --test`.

import type { OutstandingAlertState } from "./outstanding-alert-message";

export type TrackedState = "normal" | OutstandingAlertState;

// v_outstanding's status vocabulary (need_makeup/complete/low/normal — the
// numeric thresholds live in the view and stay the single source of truth)
// mapped to this phase's alert vocabulary (STATE MAPPING in the spec).
//
// "complete" (remaining_qty = 0, added in INV-FROM-RECEIPTS / migration
// 00034) means the invoice is fully received — NOT "sắp hết". It maps to
// "normal" so it never alerts, and a later drop back into "low" (e.g. a
// receipt correction) is again a normal -> near_empty transition.
export function toTrackedState(outstandingStatus: "need_makeup" | "complete" | "low" | "normal"): TrackedState {
  if (outstandingStatus === "need_makeup") return "over_received";
  if (outstandingStatus === "low") return "near_empty";
  return "normal";
}

// "Gửi khi: Bình thường -> Sắp hết, hoặc Bình thường/Sắp hết -> Cần xuất
// bù. Không gửi lại liên tục khi trạng thái không đổi." Callers are
// expected to have already filtered out oldState === newState (a
// non-transition) before calling this — it only decides whether a REAL
// transition is alert-worthy. Every other transition (near_empty ->
// normal recovery; over_received -> anything) is a silent state update.
export function shouldAlert(oldState: TrackedState, newState: TrackedState): boolean {
  if (newState === "near_empty") return oldState === "normal";
  if (newState === "over_received") return oldState === "normal" || oldState === "near_empty";
  return false;
}
