// ============================================================
// PHASE ZL1: Centralized, validated access to Zalo env vars.
//
// Every var here is server-only by convention (no NEXT_PUBLIC_ prefix — see
// docs/zalo-integration.md's security section for why). Throwing a clear,
// specific error when something required is missing (test case 13 — "env
// thiếu -> error rõ ràng") beats a generic fetch/undefined crash three
// layers deeper in the OAuth or send-message flow.
//
// Not marked "server-only": pure env reads with no secrets module-loaded at
// import time, and unit tests (env.test.ts) import this directly via plain
// `node --test` — see token.ts/messages.ts (which DO carry the marker) for
// where that guard actually matters.
// ============================================================

export class ZaloEnvError extends Error {
  constructor(missing: string[]) {
    super(`Thiếu biến môi trường Zalo bắt buộc: ${missing.join(", ")}`);
    this.name = "ZaloEnvError";
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ZaloEnvError([name]);
  }
  return value;
}

// Core app credentials — needed for both OAuth and token refresh.
export function getZaloAppConfig() {
  return {
    appId: required("ZALO_APP_ID"),
    appSecret: required("ZALO_APP_SECRET"),
    oaId: required("ZALO_OA_ID"),
  };
}

// APP_URL builds redirect_uri for the OAuth flow — must exactly match the
// callback URL configured on the Zalo OA (https://theo-doi-hang-ve.vercel.app
// in production, per the phase brief). Falls back to localhost for local dev
// only when APP_URL isn't set, so `next dev` doesn't hard-fail on this alone.
export function getAppUrl(): string {
  return process.env.APP_URL || "http://localhost:3000";
}

export function getZaloEncryptionKey(): string {
  return required("ZALO_TOKEN_ENCRYPTION_KEY");
}

// Manual-token test bootstrap (Phần 3/6 of the phase spec) — optional, only
// used by getValidZaloAccessToken() as a fallback when no OAuth connection
// has been persisted yet.
export function getManualZaloTokens(): { accessToken?: string; refreshToken?: string } {
  return {
    accessToken: process.env.ZALO_ACCESS_TOKEN || undefined,
    refreshToken: process.env.ZALO_REFRESH_TOKEN || undefined,
  };
}

export function getZaloTestRecipientId(): string {
  return required("ZALO_TEST_RECIPIENT_ID");
}
