// PHẦN 2 — GET /api/zalo/oauth/callback: production callback URL is
// https://theo-doi-hang-ve.vercel.app/api/zalo/oauth/callback (already
// configured on the Zalo OA per the phase brief — do not change this path
// without updating that OA config too).
//
// Never logs the authorization code, the code_verifier, the app secret, or
// any token — only a short, safe `reason` query param on failure,
// consistent with "không log token" / "không trả token ra browser": success
// and failure both redirect with no token in the URL, ever.
import { NextResponse, type NextRequest } from "next/server";

import { canManageIntegrations, getCurrentRole } from "@/lib/auth/role";
import { exchangeZaloAuthorizationCode } from "@/lib/zalo/oauth";
import { saveZaloTokens } from "@/lib/zalo/token";

export const runtime = "nodejs";

const SETTINGS_PATH = "/settings/notifications";

function redirectWithReason(request: NextRequest, reason: string) {
  const url = new URL(SETTINGS_PATH, request.url);
  url.searchParams.set("zalo", "error");
  url.searchParams.set("reason", reason);
  const response = NextResponse.redirect(url);
  response.cookies.delete("zalo_oauth_state");
  response.cookies.delete("zalo_oauth_verifier");
  return response;
}

export async function GET(request: NextRequest) {
  if (!canManageIntegrations(getCurrentRole())) {
    return redirectWithReason(request, "forbidden");
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const zaloError = request.nextUrl.searchParams.get("error");

  if (zaloError) {
    // Zalo itself rejected/aborted the consent — its own error code is safe
    // to pass through (it's not a secret), just not logged with any token.
    return redirectWithReason(request, `zalo_${zaloError}`);
  }

  if (!code || !state) {
    return redirectWithReason(request, "missing_code_or_state");
  }

  const cookieState = request.cookies.get("zalo_oauth_state")?.value;
  const codeVerifier = request.cookies.get("zalo_oauth_verifier")?.value;

  // Reject immediately on any mismatch — this is the CSRF defense. Never
  // fall back to "trust it anyway" on a missing cookie (e.g. cleared,
  // expired, or a forged callback hit directly without going through
  // /oauth/start first).
  if (!cookieState || !codeVerifier || cookieState !== state) {
    return redirectWithReason(request, "state_mismatch");
  }

  const result = await exchangeZaloAuthorizationCode({ code, codeVerifier });

  if (!result.ok) {
    // Zalo's own errorCode (a short code, not a secret) is safe to forward;
    // errorMessage stays server-side only (may echo request details we
    // don't want round-tripped into a URL).
    return redirectWithReason(request, `exchange_failed_${result.errorCode}`);
  }

  try {
    await saveZaloTokens({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresInSeconds: result.expiresInSeconds,
      connectedBy: null, // no real session yet — Phase 5 (Authentication) is deferred
    });
  } catch {
    return redirectWithReason(request, "save_failed");
  }

  const successUrl = new URL(SETTINGS_PATH, request.url);
  successUrl.searchParams.set("zalo", "connected");
  const response = NextResponse.redirect(successUrl);
  response.cookies.delete("zalo_oauth_state");
  response.cookies.delete("zalo_oauth_verifier");
  return response;
}
