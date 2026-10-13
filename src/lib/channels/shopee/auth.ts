// ============================================================
// PHASE SHOPEE-1: Shopee shop authorization (v2) — URL, code exchange,
// token refresh. Pure provider calls; persistence lives in ./token.ts.
//
//   1. Browser → {base}/api/v2/shop/auth_partner?partner_id&timestamp&sign&redirect=<callback>
//      (public signature; link valid ~5 min, so it is built fresh per click)
//   2. Seller approves → Shopee redirects to <callback>?code=…&shop_id=…
//      (a main/merchant account returns main_account_id instead — not
//      supported by this pilot)
//   3. POST /api/v2/auth/token/get        {code, shop_id, partner_id}
//      → access_token (~4h, expire_in seconds), refresh_token (~30 days)
//   4. POST /api/v2/auth/access_token/get {refresh_token, shop_id, partner_id}
//      → NEW access_token AND a NEW refresh_token (rotation: always persist both)
//
// The code is single-use (~10 min). Neither call is retried (POST, and a
// retried refresh could replay a rotated token).
// ============================================================
import type { ShopeeClient } from "./client.ts";
import { SHOPEE_PATHS } from "./constants.ts";
import { ShopeeApiError } from "./errors.ts";
import type { ShopeeTokenResponse } from "./types.ts";

export interface ShopeeTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  requestId: string | null;
}

/** Shopee shop ids are numeric; kept as a decimal string everywhere else. */
export function parseExternalShopId(raw: string | null | undefined): string | null {
  if (!raw || !/^\d{1,18}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

export function buildAuthorizationUrl(client: ShopeeClient, redirectUrl: string): string {
  return client.signedUrl(SHOPEE_PATHS.authPartner, { redirect: redirectUrl });
}

function toTokenSet(path: string, data: ShopeeTokenResponse, requestId: string | null): ShopeeTokenSet {
  const { access_token, refresh_token, expire_in } = data;
  if (!access_token || !refresh_token || typeof expire_in !== "number" || expire_in <= 0) {
    throw new ShopeeApiError({
      apiPath: path,
      errorCode: "invalid_response",
      message: "Phản hồi token của Shopee thiếu access_token / refresh_token / expire_in.",
      requestId,
    });
  }
  return { accessToken: access_token, refreshToken: refresh_token, expiresInSeconds: expire_in, requestId };
}

export async function exchangeAuthorizationCode(
  client: ShopeeClient,
  params: { code: string; externalShopId: string },
): Promise<ShopeeTokenSet> {
  const { data, requestId } = await client.request<ShopeeTokenResponse>({
    path: SHOPEE_PATHS.tokenGet,
    method: "POST",
    body: { code: params.code, shop_id: Number(params.externalShopId), partner_id: client.partnerId },
  });
  return toTokenSet(SHOPEE_PATHS.tokenGet, data, requestId);
}

export async function refreshShopAccessToken(
  client: ShopeeClient,
  params: { refreshToken: string; externalShopId: string; logShopId?: string },
): Promise<ShopeeTokenSet> {
  const { data, requestId } = await client.request<ShopeeTokenResponse>({
    path: SHOPEE_PATHS.accessTokenGet,
    method: "POST",
    body: { refresh_token: params.refreshToken, shop_id: Number(params.externalShopId), partner_id: client.partnerId },
    logShopId: params.logShopId,
  });
  return toTokenSet(SHOPEE_PATHS.accessTokenGet, data, requestId);
}
