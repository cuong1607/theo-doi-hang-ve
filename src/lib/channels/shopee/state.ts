// ============================================================
// PHASE SHOPEE-1: anti-CSRF state for the Shopee authorization round-trip.
//
// Shopee's auth_partner has no dedicated `state` parameter, so the state
// travels inside our own redirect URL (?state=…) and must come back on the
// callback, where it is compared (constant time) with the httpOnly cookie
// set by /api/shopee/auth/start. Missing on either side → reject.
// ============================================================
import { randomBytes, timingSafeEqual } from "node:crypto";

export function generateAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function statesMatch(fromQuery: string | null | undefined, fromCookie: string | null | undefined): boolean {
  if (!fromQuery || !fromCookie) return false;
  const a = Buffer.from(fromQuery);
  const b = Buffer.from(fromCookie);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function redirectUrlWithState(redirectUrl: string, state: string): string {
  const url = new URL(redirectUrl);
  url.searchParams.set("state", state);
  return url.toString();
}
