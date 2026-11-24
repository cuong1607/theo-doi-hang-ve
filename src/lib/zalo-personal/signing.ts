// ============================================================
// ZALO PERSONAL Phase 02 — service-to-service request signing (worker → backend).
//
// Headers:
//   x-zp-worker     worker key (identity, not a secret)
//   x-zp-timestamp  unix milliseconds
//   x-zp-nonce      32 hex chars (128 random bits), unique per REQUEST
//   x-zp-signature  "v1=" + hex(HMAC-SHA256(secret, canonical))
// canonical = "v1\n" + METHOD + "\n" + path + "\n" + workerKey + "\n" + timestamp + "\n" + nonce + "\n" + hex(SHA-256(raw body))
//
// Signing the body HASH together with method, path, identity, time and nonce
// binds every byte of the raw body (equivalent to an HMAC over the body) and
// prevents replaying a signature on another endpoint. A retry of the same
// EVENTS is a new request (new nonce, new signature); event identity lives in
// the payload (eventKey) and is deduplicated by the database.
//
// The worker (services/zalo-personal-worker/src/ingest/signing.ts) carries a
// copy of this algorithm; both test suites check the same fixed vector.
// Pure: node:crypto only.
// ============================================================
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_VERSION = "v1";
export const HEADER = {
  worker: "x-zp-worker",
  timestamp: "x-zp-timestamp",
  nonce: "x-zp-nonce",
  signature: "x-zp-signature",
} as const;

export const WORKER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{2,47}$/;
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const SECRET_PREFIX = "zps_";

export interface SignatureParts {
  method: string;
  path: string;
  workerKey: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}

export function canonicalString(p: SignatureParts): string {
  const bodyHash = createHash("sha256").update(p.rawBody, "utf8").digest("hex");
  return [SIGNATURE_VERSION, p.method.toUpperCase(), p.path, p.workerKey, p.timestamp, p.nonce, bodyHash].join("\n");
}

/** A worker secret: "zps_" + base64url(32 random bytes). */
export function generateWorkerSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64url");
}

export function secretKeyBytes(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error("Worker secret không đúng định dạng.");
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), "base64url");
  if (key.length !== 32) throw new Error("Worker secret không đúng định dạng.");
  return key;
}

export function sign(secretKey: Buffer, parts: SignatureParts): string {
  return `${SIGNATURE_VERSION}=${createHmac("sha256", secretKey).update(canonicalString(parts), "utf8").digest("hex")}`;
}

/** Constant-time comparison of a received signature header against the expected one. */
export function signatureMatches(secretKey: Buffer, parts: SignatureParts, header: string): boolean {
  const m = /^v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = Buffer.from(sign(secretKey, parts).slice(3), "hex");
  const given = Buffer.from(m[1] ?? "", "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
