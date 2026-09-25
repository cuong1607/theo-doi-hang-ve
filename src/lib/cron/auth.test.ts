// Run: node --env-file=.env.local --test src/lib/cron/auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedCronSecret } from "./auth.ts";

test("case 1: valid cron secret — correct Bearer header authorizes", () => {
  assert.equal(isAuthorizedCronSecret("Bearer abc123", "abc123"), true);
});

test("case 2: invalid secret — wrong value is rejected", () => {
  assert.equal(isAuthorizedCronSecret("Bearer wrong-secret", "abc123"), false);
});

test("missing Authorization header is rejected", () => {
  assert.equal(isAuthorizedCronSecret(null, "abc123"), false);
});

test("header missing the 'Bearer ' prefix is rejected (exact match required)", () => {
  assert.equal(isAuthorizedCronSecret("abc123", "abc123"), false);
});

test("fails closed when CRON_SECRET itself is unset/empty — never treats that as 'open'", () => {
  assert.equal(isAuthorizedCronSecret("Bearer anything", undefined), false);
  assert.equal(isAuthorizedCronSecret("Bearer ", ""), false);
  assert.equal(isAuthorizedCronSecret(null, undefined), false);
});

test("case-sensitive, no partial/prefix match", () => {
  assert.equal(isAuthorizedCronSecret("bearer abc123", "abc123"), false);
  assert.equal(isAuthorizedCronSecret("Bearer abc1234", "abc123"), false);
});
