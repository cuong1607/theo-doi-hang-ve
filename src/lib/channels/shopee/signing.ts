// ============================================================
// PHASE SHOPEE-1: Shopee Open Platform v2 request signing — the ONLY place
// a signature is built.
//
//   sign = hex( HMAC-SHA256( key = partner_key,
//                            msg = partner_id + api_path + timestamp
//                                  [+ access_token + shop_id] ) )
//
//   * public endpoints (auth_partner, auth/token/get, auth/access_token/get):
//       partner_id + api_path + timestamp
//   * shop-level endpoints: … + access_token + shop_id
//
// api_path is the path only (e.g. "/api/v2/shop/get_shop_info"), never the
// host or query. timestamp is Unix SECONDS and must be the same value sent
// in the query; Shopee rejects stale timestamps (~5 min), so sign per
// attempt, never reuse a signature.
//
// Never log the base string (it contains the access token) or the key.
// ============================================================
import { createHmac } from "node:crypto";

export type ShopeeSignScope =
  | { kind: "public" }
  | { kind: "shop"; accessToken: string; shopId: string };

export interface ShopeeSignInput {
  partnerId: number;
  partnerKey: string;
  path: string;
  timestamp: number;
  scope: ShopeeSignScope;
}

export function shopeeSignatureBase(input: Omit<ShopeeSignInput, "partnerKey">): string {
  const base = `${input.partnerId}${input.path}${input.timestamp}`;
  return input.scope.kind === "shop" ? `${base}${input.scope.accessToken}${input.scope.shopId}` : base;
}

export function signShopeeRequest(input: ShopeeSignInput): string {
  if (!input.path.startsWith("/api/v2/")) throw new Error(`Shopee api path không hợp lệ: ${input.path}`);
  if (!Number.isInteger(input.timestamp) || input.timestamp <= 0) throw new Error("Shopee timestamp phải là Unix giây.");
  return createHmac("sha256", input.partnerKey).update(shopeeSignatureBase(input)).digest("hex");
}

/** Common signed query params for a request (merged with endpoint params by the client). */
export function signedQuery(input: ShopeeSignInput): Record<string, string> {
  const query: Record<string, string> = {
    partner_id: String(input.partnerId),
    timestamp: String(input.timestamp),
    sign: signShopeeRequest(input),
  };
  if (input.scope.kind === "shop") {
    query.access_token = input.scope.accessToken;
    query.shop_id = input.scope.shopId;
  }
  return query;
}

export function unixSeconds(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000);
}
