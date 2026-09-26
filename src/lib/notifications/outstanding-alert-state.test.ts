// Run: node --env-file=.env.local --test src/lib/notifications/outstanding-alert-state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toTrackedState, shouldAlert } from "./outstanding-alert-state.ts";

test("toTrackedState: maps v_outstanding's status vocabulary to the alert vocabulary", () => {
  assert.equal(toTrackedState("normal"), "normal");
  assert.equal(toTrackedState("low"), "near_empty");
  assert.equal(toTrackedState("need_makeup"), "over_received");
});

// INV-FROM-RECEIPTS: remaining_qty = 0 is "Đã đủ", never a low-stock alert.
test("toTrackedState: complete (remaining = 0) is tracked as normal, not near_empty", () => {
  assert.equal(toTrackedState("complete"), "normal");
  assert.equal(shouldAlert("normal", toTrackedState("complete")), false);
  assert.equal(shouldAlert("near_empty", toTrackedState("complete")), false);
});

// Spec's worked example: 30 -> 12 (gửi "Sắp hết"); 12 -> 10 (không gửi lại —
// handled by the caller's oldState===newState skip, not exercised here);
// 10 -> 20 (trở lại Bình thường); 20 -> 13 (được phép gửi cảnh báo mới).
test("shouldAlert: normal -> near_empty alerts (30 -> 12)", () => {
  assert.equal(shouldAlert("normal", "near_empty"), true);
});

test("shouldAlert: near_empty -> normal does NOT alert (10 -> 20, a recovery)", () => {
  assert.equal(shouldAlert("near_empty", "normal"), false);
});

test("shouldAlert: normal -> near_empty alerts again after a reset (20 -> 13)", () => {
  // Same rule as the first case — the state machine itself doesn't need a
  // separate "second time" rule, since near_empty -> normal already reset
  // oldState back to normal.
  assert.equal(shouldAlert("normal", "near_empty"), true);
});

test("shouldAlert: normal -> over_received alerts", () => {
  assert.equal(shouldAlert("normal", "over_received"), true);
});

test("shouldAlert: near_empty -> over_received alerts", () => {
  assert.equal(shouldAlert("near_empty", "over_received"), true);
});

test("shouldAlert: over_received -> normal does NOT alert (a recovery)", () => {
  assert.equal(shouldAlert("over_received", "normal"), false);
});

test("shouldAlert: over_received -> near_empty does NOT alert (not one of the 2 documented transitions)", () => {
  assert.equal(shouldAlert("over_received", "near_empty"), false);
});
