// SHOPEE-1 — GET /api/shopee/auth/start: begins (re)connecting a Shopee shop.
//
// Admin only (channel:manage), enforced here, not just by hiding the button.
// Sets a short-lived httpOnly state cookie and redirects the browser to
// Shopee's auth_partner page with a freshly signed link (valid ~5 min).
// Nothing secret reaches the browser: the URL carries partner_id, timestamp
// and sign — never the partner key.
import { NextResponse, type NextRequest } from "next/server";

import { authorizeRoute } from "@/lib/auth/session";
import { buildAuthorizationUrl } from "@/lib/channels/shopee/auth";
import { ShopeeConfigError } from "@/lib/channels/shopee/config";
import { AUTH_STATE_COOKIE, AUTH_STATE_MAX_AGE_SECONDS } from "@/lib/channels/shopee/constants";
import { getShopee } from "@/lib/channels/shopee/server";
import { generateAuthState, redirectUrlWithState } from "@/lib/channels/shopee/state";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authz = await authorizeRoute("channel:manage");
  if (!authz.ok) return authz.response;

  let authorizationUrl: string;
  const state = generateAuthState();
  try {
    const { client, config } = getShopee();
    authorizationUrl = buildAuthorizationUrl(client, redirectUrlWithState(config.redirectUrl, state));
  } catch (err) {
    const url = new URL("/settings/shopee", request.url);
    url.searchParams.set("shopee", "error");
    url.searchParams.set("reason", err instanceof ShopeeConfigError ? "config" : "start_failed");
    return NextResponse.redirect(url);
  }

  console.info(JSON.stringify({ source: "shopee", event: "shopee_auth_start", userId: authz.auth.user.id }));
  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(AUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // sent on Shopee's top-level GET redirect back to us
    path: "/api/shopee/auth",
    maxAge: AUTH_STATE_MAX_AGE_SECONDS,
  });
  return response;
}
