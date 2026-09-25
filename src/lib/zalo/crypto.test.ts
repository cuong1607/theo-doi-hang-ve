// Requires ZALO_TOKEN_ENCRYPTION_KEY (any non-empty string) in the env.
// Run: node --env-file=.env.local --test src/lib/zalo/crypto.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptToken, decryptToken } from "./crypto.ts";

if (!process.env.ZALO_TOKEN_ENCRYPTION_KEY) {
  throw new Error("Thiếu ZALO_TOKEN_ENCRYPTION_KEY — chạy với `node --env-file=.env.local --test ...`.");
}

test("encryptToken/decryptToken: round-trips the original plaintext", () => {
  const plaintext = "fake-access-token-value-1234567890";
  const ciphertext = encryptToken(plaintext);
  assert.notEqual(ciphertext, plaintext, "ciphertext must not equal the plaintext");
  assert.equal(decryptToken(ciphertext), plaintext);
});

test("encryptToken: never stores the plaintext token as a substring of the ciphertext", () => {
  const plaintext = "super-secret-zalo-token-abcdef";
  const ciphertext = encryptToken(plaintext);
  assert.ok(!ciphertext.includes(plaintext), "ciphertext leaked the plaintext");
});

test("encryptToken: random IV means two encryptions of the same plaintext differ", () => {
  const plaintext = "same-token-value";
  const a = encryptToken(plaintext);
  const b = encryptToken(plaintext);
  assert.notEqual(a, b);
  assert.equal(decryptToken(a), plaintext);
  assert.equal(decryptToken(b), plaintext);
});

test("decryptToken: rejects tampered ciphertext (GCM auth tag mismatch)", () => {
  const ciphertext = encryptToken("some-token");
  const [iv, tag, body] = ciphertext.split(".");
  const tamperedBody = Buffer.from(body, "base64");
  tamperedBody[0] = tamperedBody[0] ^ 0xff; // flip a bit
  const tampered = [iv, tag, tamperedBody.toString("base64")].join(".");
  assert.throws(() => decryptToken(tampered));
});

test("decryptToken: rejects a malformed stored value", () => {
  assert.throws(() => decryptToken("not-a-valid-stored-token"));
});
