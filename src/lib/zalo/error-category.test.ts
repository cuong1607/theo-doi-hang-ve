// Run: node --env-file=.env.local --test src/lib/zalo/error-category.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { categorizeZaloError } from "./error-category.ts";

test("internal auth-related codes -> auth_error", () => {
  assert.equal(categorizeZaloError("not_connected"), "auth_error");
  assert.equal(categorizeZaloError("no_refresh_token"), "auth_error");
  assert.equal(categorizeZaloError("decrypt_failed"), "auth_error");
});

test("internal transient codes -> provider_temporary_error", () => {
  assert.equal(categorizeZaloError("network_error"), "provider_temporary_error");
  assert.equal(categorizeZaloError("invalid_response"), "provider_temporary_error");
  assert.equal(categorizeZaloError("unexpected_error"), "provider_temporary_error");
});

test("invalid_input -> invalid_recipient", () => {
  assert.equal(categorizeZaloError("invalid_input"), "invalid_recipient");
});

test("known Zalo numeric codes map to their documented category", () => {
  assert.equal(categorizeZaloError("-201"), "auth_error");
  assert.equal(categorizeZaloError("-213"), "invalid_recipient");
  assert.equal(categorizeZaloError("-214"), "recipient_unreachable");
  assert.equal(categorizeZaloError("-32"), "rate_limit");
});

test("bare HTTP status fallback: 401 -> auth_error, 429 -> rate_limit, 5xx -> provider_temporary_error", () => {
  assert.equal(categorizeZaloError("401"), "auth_error");
  assert.equal(categorizeZaloError("429"), "rate_limit");
  assert.equal(categorizeZaloError("500"), "provider_temporary_error");
  assert.equal(categorizeZaloError("503"), "provider_temporary_error");
});

test("unrecognized code, null, or empty -> unknown", () => {
  assert.equal(categorizeZaloError("-99999"), "unknown");
  assert.equal(categorizeZaloError(null), "unknown");
  assert.equal(categorizeZaloError(undefined), "unknown");
  assert.equal(categorizeZaloError(""), "unknown");
});
