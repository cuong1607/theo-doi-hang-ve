// ============================================================
// PHASE ZL1: Token persistence + the getValidZaloAccessToken() helper every
// Zalo API call (currently just sendZaloTextMessage) goes through.
//
// Never called from a Client Component — this module touches the
// service-role admin client and decrypted tokens, both server-only.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken, encryptToken } from "./crypto.ts";
import { getManualZaloTokens, getZaloAppConfig } from "./env.ts";
import { refreshZaloToken, type ZaloTokenExchangeResult } from "./oauth.ts";

// Refresh this many seconds before actual expiry — avoids a request racing
// past expiry mid-flight, without hammering Zalo on every single call.
const EXPIRY_SAFETY_BUFFER_SECONDS = 300;

export type ZaloTokenError = { errorCode: string; errorMessage: string };

export type ZaloTokenResult = { ok: true; accessToken: string } | { ok: false; error: ZaloTokenError };

// Upserted by oa_id — one row for the one OA in scope (see migration
// 00028). Called only from the OAuth callback and from
// getValidZaloAccessToken() after a successful refresh.
export async function saveZaloTokens(params: {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
  connectedBy?: string | null;
}): Promise<void> {
  const { oaId } = getZaloAppConfig();
  const supabase = createAdminClient();

  const expiresAt =
    params.expiresInSeconds != null
      ? new Date(Date.now() + params.expiresInSeconds * 1000).toISOString()
      : null;

  const { error } = await supabase.from("zalo_connections").upsert(
    {
      oa_id: oaId,
      access_token_encrypted: encryptToken(params.accessToken),
      refresh_token_encrypted: params.refreshToken ? encryptToken(params.refreshToken) : null,
      expires_at: expiresAt,
      connected_by: params.connectedBy ?? null,
    },
    { onConflict: "oa_id" }
  );

  if (error) {
    throw new Error(`Không thể lưu token Zalo: ${error.message}`);
  }
}

export type ZaloConnectionStatus = {
  connected: boolean;
  oaId: string | null;
  expiresAt: string | null;
};

// Read-only status for the settings UI — never returns the decrypted
// tokens themselves, only enough to render "Đã kết nối" / "Chưa kết nối".
export async function getZaloConnectionStatus(): Promise<ZaloConnectionStatus> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("zalo_connections")
    .select("oa_id, expires_at")
    .maybeSingle();

  if (!data) {
    return { connected: false, oaId: null, expiresAt: null };
  }
  return { connected: true, oaId: data.oa_id, expiresAt: data.expires_at };
}

async function getStoredConnection(): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
} | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("zalo_connections")
    .select("access_token_encrypted, refresh_token_encrypted, expires_at")
    .maybeSingle();

  if (!data) return null;

  return {
    accessToken: decryptToken(data.access_token_encrypted),
    refreshToken: data.refresh_token_encrypted ? decryptToken(data.refresh_token_encrypted) : null,
    expiresAt: data.expires_at ? new Date(data.expires_at) : null,
  };
}

function isExpiringSoon(expiresAt: Date | null): boolean {
  if (!expiresAt) return false; // unknown expiry (e.g. manual env token) — treat as still valid
  return expiresAt.getTime() - Date.now() <= EXPIRY_SAFETY_BUFFER_SECONDS * 1000;
}

function toTokenError(result: Extract<ZaloTokenExchangeResult, { ok: false }>): ZaloTokenError {
  return { errorCode: result.errorCode, errorMessage: result.errorMessage };
}

// PHẦN 4: refresh using the stored refresh_token, atomically replacing the
// row's tokens (upsert overwrites both columns together, never a partial
// update that could leave a fresh access_token paired with a stale
// refresh_token or vice versa).
export async function refreshZaloAccessToken(): Promise<ZaloTokenResult> {
  const connection = await getStoredConnection();
  if (!connection?.refreshToken) {
    return {
      ok: false,
      error: { errorCode: "no_refresh_token", errorMessage: "Chưa có refresh token để làm mới." },
    };
  }

  const result = await refreshZaloToken({ refreshToken: connection.refreshToken });
  if (!result.ok) {
    return { ok: false, error: toTokenError(result) };
  }

  await saveZaloTokens({
    accessToken: result.accessToken,
    // Zalo may omit refresh_token on a refresh response — keep the existing
    // one rather than nulling it out.
    refreshToken: result.refreshToken ?? connection.refreshToken,
    expiresInSeconds: result.expiresInSeconds,
  });

  return { ok: true, accessToken: result.accessToken };
}

// PHẦN 4: the one function every send-message call goes through.
// - a stored connection with a still-valid token -> return it as-is
// - a stored connection that's expired/expiring -> refresh, return the new one
// - no stored connection at all -> fall back to the manual test env vars
//   (ZALO_ACCESS_TOKEN), per the phase spec's "chưa cần OAuth xong vẫn test
//   được" allowance. This fallback path does NOT auto-refresh — see
//   docs/zalo-integration.md's documented limitation.
export async function getValidZaloAccessToken(): Promise<ZaloTokenResult> {
  const connection = await getStoredConnection();

  if (connection) {
    if (!isExpiringSoon(connection.expiresAt)) {
      return { ok: true, accessToken: connection.accessToken };
    }
    return refreshZaloAccessToken();
  }

  const manual = getManualZaloTokens();
  if (manual.accessToken) {
    return { ok: true, accessToken: manual.accessToken };
  }

  return {
    ok: false,
    error: {
      errorCode: "not_connected",
      errorMessage: "Chưa kết nối Zalo OA — hãy chạy OAuth hoặc đặt ZALO_ACCESS_TOKEN để test.",
    },
  };
}
