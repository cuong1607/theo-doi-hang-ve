// ============================================================
// PHASE ZL1: OAuth authorization URL + code-for-token exchange.
//
// Only the two things the OAuth start/callback routes need — no route
// handler ever talks to fetch() or builds a Zalo URL directly.
// ============================================================
import { getAppUrl, getZaloAppConfig } from "./env.ts";
import { ZALO_OA_AUTHORIZATION_URL, ZALO_OA_TOKEN_URL, zaloFetch, type FetchImpl } from "./client.ts";

export function getZaloRedirectUri(): string {
  return `${getAppUrl()}/api/zalo/oauth/callback`;
}

export function buildZaloAuthorizationUrl(params: { state: string; codeChallenge: string }): string {
  const { appId } = getZaloAppConfig();
  const url = new URL(ZALO_OA_AUTHORIZATION_URL);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("redirect_uri", getZaloRedirectUri());
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  return url.toString();
}

export type ZaloTokenExchangeResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string | null;
      expiresInSeconds: number | null;
    }
  | { ok: false; errorCode: string; errorMessage: string };

// Shared by both the initial exchange (grant_type=authorization_code) and
// refresh (grant_type=refresh_token) — same endpoint, same response shape,
// only the grant params differ. Never logs the secret, the code, the
// verifier, or any token — only Zalo's own numeric error code (if any) and
// a short message, per the phase's "không log token" requirement.
async function requestZaloToken(
  body: Record<string, string>,
  fetchImpl?: FetchImpl
): Promise<ZaloTokenExchangeResult> {
  const { appId, appSecret } = getZaloAppConfig();

  let response: Response;
  try {
    response = await zaloFetch(
      ZALO_OA_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          secret_key: appSecret,
        },
        body: new URLSearchParams({ app_id: appId, ...body }).toString(),
      },
      fetchImpl
    );
  } catch (err) {
    return {
      ok: false,
      errorCode: "network_error",
      errorMessage: err instanceof Error ? err.message : "Không thể kết nối tới Zalo.",
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, errorCode: "invalid_response", errorMessage: "Zalo trả về dữ liệu không hợp lệ." };
  }

  const parsed = data as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: string | number;
    error?: number | string;
    error_name?: string;
    error_description?: string;
  };

  if (!response.ok || !parsed.access_token) {
    return {
      ok: false,
      errorCode: String(parsed.error ?? response.status),
      errorMessage: parsed.error_description || parsed.error_name || "Zalo từ chối yêu cầu lấy token.",
    };
  }

  const expiresInSeconds =
    parsed.expires_in != null && parsed.expires_in !== "" ? Number(parsed.expires_in) : null;

  return {
    ok: true,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresInSeconds: Number.isFinite(expiresInSeconds) ? expiresInSeconds : null,
  };
}

export function exchangeZaloAuthorizationCode(
  params: { code: string; codeVerifier: string },
  fetchImpl?: FetchImpl
): Promise<ZaloTokenExchangeResult> {
  return requestZaloToken(
    { code: params.code, code_verifier: params.codeVerifier, grant_type: "authorization_code" },
    fetchImpl
  );
}

export function refreshZaloToken(
  params: { refreshToken: string },
  fetchImpl?: FetchImpl
): Promise<ZaloTokenExchangeResult> {
  return requestZaloToken({ refresh_token: params.refreshToken, grant_type: "refresh_token" }, fetchImpl);
}
