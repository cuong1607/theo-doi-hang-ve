// ============================================================
// PHASE ZL1: Low-level Zalo HTTP endpoints, in one place.
//
// Endpoint values were cross-checked against Zalo's official OAuth v4 docs
// (developers.zalo.me is a JS-rendered SPA that couldn't be scraped
// directly at implementation time) plus multiple independent, mutually
// consistent secondary sources (Zalo's own PHP SDK on GitHub, community
// tutorials). See docs/zalo-integration.md's "Troubleshooting" section —
// if Zalo has since changed these, this is the ONLY file to edit.
//
// Every exported function takes an optional `fetchImpl` (defaults to the
// global fetch) purely so tests can inject a stub without needing a real
// Zalo App Secret or network access — production call sites never pass it.
// Not marked "server-only" — a generic timeout/fetch wrapper with no
// secrets, unit tested directly via plain `node --test` with an injected
// fetchImpl. Nothing in src/app/**/*.tsx imports this.
// ============================================================

export const ZALO_OA_AUTHORIZATION_URL = "https://oauth.zaloapp.com/v4/oa/permission";
export const ZALO_OA_TOKEN_URL = "https://oauth.zaloapp.com/v4/oa/access_token";
export const ZALO_SEND_MESSAGE_URL = "https://openapi.zalo.me/v3.0/oa/message/cs";

const REQUEST_TIMEOUT_MS = 10_000;

export type FetchImpl = typeof fetch;

export class ZaloRequestTimeoutError extends Error {
  constructor(url: string) {
    super(`Yêu cầu tới Zalo quá thời gian chờ: ${url}`);
    this.name = "ZaloRequestTimeoutError";
  }
}

// Every outbound call to Zalo goes through this — one timeout policy, one
// place to add retry/logging later, never duplicated per call site.
export async function zaloFetch(
  url: string,
  init: RequestInit,
  fetchImpl: FetchImpl = fetch
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ZaloRequestTimeoutError(url);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
