// ============================================================
// PHASE ZL1: OAuth state + PKCE (RFC 7636) generation.
//
// Pure, no I/O — safe to unit test directly. code_verifier is a
// high-entropy random string (43-128 chars per RFC 7636; we use 64 bytes of
// randomness, base64url-encoded, which lands well inside that range).
// code_challenge is BASE64URL(SHA256(code_verifier)) — the "S256" method,
// the only one Zalo's OAuth v4 documentation examples show.
// Not marked "server-only" — pure, no I/O, unit tested directly via plain
// `node --test`. Nothing in src/app/**/*.tsx imports this.
// ============================================================
import { randomBytes, createHash } from "node:crypto";

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Random, unguessable — bound to one OAuth attempt via a short-lived cookie,
// compared byte-for-byte against the callback's `state` query param.
export function generateState(): string {
  return base64url(randomBytes(32));
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(64));
}

export function generateCodeChallenge(codeVerifier: string): string {
  return base64url(createHash("sha256").update(codeVerifier).digest());
}
