// PHẦN 1 — GET /api/zalo/oauth/start: begins the OAuth flow.
//
// admin-only (same gate as /api/zalo/test-message): connecting the OA is a
// system-level config action, not a day-to-day one. state + code_verifier
// are stored in short-lived httpOnly cookies rather than a server-side
// session table — this app has no session concept yet (Phase 5 deferred),
// and a signed, short-TTL cookie is the standard place for OAuth-in-flight
// state when there's no session to hang it off.
import { NextResponse } from "next/server";

import { canManageIntegrations, getCurrentRole } from "@/lib/auth/role";
import { buildZaloAuthorizationUrl } from "@/lib/zalo/oauth";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "@/lib/zalo/pkce";
import { ZaloEnvError } from "@/lib/zalo/env";

export const runtime = "nodejs";

const COOKIE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes — long enough to click through Zalo's consent screen

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: COOKIE_MAX_AGE_SECONDS,
};

export async function GET() {
  if (!canManageIntegrations(getCurrentRole())) {
    return NextResponse.json({ success: false, errorMessage: "Bạn không có quyền thực hiện thao tác này." }, { status: 403 });
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  let authorizationUrl: string;
  try {
    authorizationUrl = buildZaloAuthorizationUrl({ state, codeChallenge });
  } catch (err) {
    // ZaloEnvError message names which env var is missing but never a
    // secret value — safe to surface directly.
    const message = err instanceof ZaloEnvError ? err.message : "Không thể khởi tạo OAuth Zalo.";
    return NextResponse.json({ success: false, errorMessage: message }, { status: 500 });
  }

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set("zalo_oauth_state", state, cookieOptions);
  response.cookies.set("zalo_oauth_verifier", codeVerifier, cookieOptions);
  return response;
}
