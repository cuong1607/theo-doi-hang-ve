// Run: node --env-file=.env.local --test src/lib/zalo/oauth.test.ts
//
// Uses an injected fetchImpl stub — no real network call, no real Zalo App
// Secret needed. This tests OUR request-building/response-parsing logic,
// which is exactly what's under our control; a live (real-network,
// real-failure) check of the actual exchange/refresh HTTP calls lives in
// the throwaway zalo-live-check script (see PHASE ZL1 report) since it
// needs a running dev server and real (or intentionally fake) credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildZaloAuthorizationUrl,
  exchangeZaloAuthorizationCode,
  getZaloRedirectUri,
  refreshZaloToken,
} from "./oauth.ts";
import { ZALO_OA_TOKEN_URL } from "./client.ts";

// Force deterministic values for this test file, regardless of whatever
// .env.local has for local dev — these assertions check OUR request
// building, not the actual configured environment.
process.env.ZALO_APP_ID = "test-app-id";
process.env.ZALO_APP_SECRET = "test-app-secret";
process.env.ZALO_OA_ID = "test-oa-id";
process.env.APP_URL = "https://theo-doi-hang-ve.vercel.app";

function fakeFetch(responseBody: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responseBody), { status });
  }) as typeof fetch;
  return { impl, calls };
}

test("buildZaloAuthorizationUrl: embeds app_id, redirect_uri, state, code_challenge", () => {
  const url = new URL(
    buildZaloAuthorizationUrl({ state: "STATE123", codeChallenge: "CHALLENGE456" })
  );
  assert.equal(url.origin + url.pathname, "https://oauth.zaloapp.com/v4/oa/permission");
  assert.equal(url.searchParams.get("app_id"), "test-app-id");
  assert.equal(url.searchParams.get("redirect_uri"), getZaloRedirectUri());
  assert.equal(url.searchParams.get("state"), "STATE123");
  assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE456");
});

test("getZaloRedirectUri: matches the configured production callback path", () => {
  assert.equal(getZaloRedirectUri(), "https://theo-doi-hang-ve.vercel.app/api/zalo/oauth/callback");
});

test("exchangeZaloAuthorizationCode: success — posts correct params/headers, parses tokens", async () => {
  const { impl, calls } = fakeFetch({ access_token: "AT1", refresh_token: "RT1", expires_in: "3600" });
  const result = await exchangeZaloAuthorizationCode({ code: "CODE1", codeVerifier: "VERIFIER1" }, impl);

  assert.deepEqual(result, { ok: true, accessToken: "AT1", refreshToken: "RT1", expiresInSeconds: 3600 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ZALO_OA_TOKEN_URL);
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.secret_key, "test-app-secret");
  const body = new URLSearchParams(calls[0].init.body as string);
  assert.equal(body.get("app_id"), "test-app-id");
  assert.equal(body.get("code"), "CODE1");
  assert.equal(body.get("code_verifier"), "VERIFIER1");
  assert.equal(body.get("grant_type"), "authorization_code");
});

test("exchangeZaloAuthorizationCode: failure — Zalo error response becomes a structured result, not a throw", async () => {
  const { impl } = fakeFetch({ error: -14003, error_description: "Invalid authorization code" }, 400);
  const result = await exchangeZaloAuthorizationCode({ code: "BAD", codeVerifier: "V" }, impl);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorCode, "-14003");
    assert.match(result.errorMessage, /Invalid authorization code/);
  }
});

test("exchangeZaloAuthorizationCode: network failure becomes a structured result, not a throw", async () => {
  const failingFetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as typeof fetch;
  const result = await exchangeZaloAuthorizationCode({ code: "C", codeVerifier: "V" }, failingFetch);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorCode, "network_error");
  }
});

test("refreshZaloToken: success — uses grant_type=refresh_token", async () => {
  const { impl, calls } = fakeFetch({ access_token: "AT2", expires_in: 3600 });
  const result = await refreshZaloToken({ refreshToken: "RT1" }, impl);
  assert.equal(result.ok, true);
  const body = new URLSearchParams(calls[0].init.body as string);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "RT1");
});

test("refreshZaloToken: failure returns structured error", async () => {
  const { impl } = fakeFetch({ error: -14004, error_name: "invalid_refresh_token" }, 400);
  const result = await refreshZaloToken({ refreshToken: "EXPIRED" }, impl);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorCode, "-14004");
  }
});
