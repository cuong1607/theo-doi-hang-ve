// Pure unit tests — no I/O, no env vars needed.
// Run: node --env-file=.env.local --test src/lib/zalo/pkce.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateState, generateCodeVerifier, generateCodeChallenge } from "./pkce.ts";

test("generateState: produces a URL-safe, high-entropy string", () => {
  const a = generateState();
  const b = generateState();
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 32, `expected a long state, got length ${a.length}`);
  assert.notEqual(a, b, "two calls must not collide");
});

test("generateCodeVerifier: URL-safe and within RFC 7636's 43-128 char range", () => {
  const verifier = generateCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `length ${verifier.length} out of RFC 7636 range`);
});

test("generateCodeChallenge: matches BASE64URL(SHA256(verifier)) — the S256 method", () => {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const expected = createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(challenge, expected);
});

test("generateCodeChallenge: deterministic for the same verifier, different for different ones", () => {
  const v1 = generateCodeVerifier();
  const v2 = generateCodeVerifier();
  assert.equal(generateCodeChallenge(v1), generateCodeChallenge(v1));
  assert.notEqual(generateCodeChallenge(v1), generateCodeChallenge(v2));
});
