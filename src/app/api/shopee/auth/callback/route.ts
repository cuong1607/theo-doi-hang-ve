// SHOPEE-1 — GET /api/shopee/auth/callback: Shopee redirects here after the
// seller approves (…?state=<ours>&code=…&shop_id=…).
//
// Order of checks: admin session → state (cookie vs query, constant time)
// → shop_id format → code exchange (which proves the code belongs to that
// shop_id) → upsert shop + connection. The external shop id therefore only
// ever comes from Shopee, never from a user-typed value.
//
// Never logs or echoes the code or tokens; failures redirect to the
// settings page with a short, safe reason code.
import { NextResponse, type NextRequest } from "next/server";

import { authorizeAction } from "@/lib/auth/session";
import { parseExternalShopId } from "@/lib/channels/shopee/auth";
import { AUTH_STATE_COOKIE } from "@/lib/channels/shopee/constants";
import { ShopeeApiError } from "@/lib/channels/shopee/errors";
import { getShopee } from "@/lib/channels/shopee/server";
import { statesMatch } from "@/lib/channels/shopee/state";

export const runtime = "nodejs";

function settingsRedirect(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/settings/shopee", request.url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url);
  response.cookies.set(AUTH_STATE_COOKIE, "", { path: "/api/shopee/auth", maxAge: 0 });
  return response;
}

const fail = (request: NextRequest, reason: string) => settingsRedirect(request, { shopee: "error", reason });

export async function GET(request: NextRequest) {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return fail(request, "forbidden");

  const query = request.nextUrl.searchParams;
  if (!statesMatch(query.get("state"), request.cookies.get(AUTH_STATE_COOKIE)?.value)) {
    return fail(request, "state_mismatch");
  }
  if (query.get("main_account_id") && !query.get("shop_id")) return fail(request, "main_account_not_supported");

  const code = query.get("code");
  const externalShopId = parseExternalShopId(query.get("shop_id"));
  if (!code || !externalShopId) return fail(request, "missing_code_or_shop");

  try {
    const result = await getShopee().service.completeAuthorization({ code, externalShopId });
    return settingsRedirect(request, { shopee: result.reconnected ? "reconnected" : "connected" });
  } catch (err) {
    if (err instanceof ShopeeApiError) {
      const safeCode = err.errorCode.replace(/[^a-z0-9_]/gi, "").slice(0, 60) || "unknown";
      return fail(request, `exchange_failed_${safeCode}`);
    }
    console.warn(JSON.stringify({ source: "shopee", event: "shopee_auth_callback_failed", ok: false }));
    return fail(request, "save_failed");
  }
}
