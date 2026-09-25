// ============================================================
// PHASE ZL1: Token persistence + the getValidZaloAccessToken() helper every
// Zalo API call (currently just sendZaloTextMessage) goes through.
//
// PHASE ZL7 (production hardening) added: a cross-instance refresh lock
// (refresh_lock_at) so two concurrent serverless invocations never race
// Zalo's refresh_token grant with the same token; an in-process promise
// memo for the common case of two calls landing in the same warm
// function instance; and last_refresh_at/last_refresh_error_* columns
// that feed the new health-status UI.
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

// If a refresh_lock_at is older than this, assume the holder crashed
// mid-refresh (function timeout, cold start killed, ...) and allow another
// request to reclaim the lock rather than deadlocking forever.
const REFRESH_LOCK_STALE_SECONDS = 30;
const REFRESH_LOCK_POLL_INTERVAL_MS = 250;
const REFRESH_LOCK_MAX_WAIT_MS = 4000;

export type ZaloTokenError = { errorCode: string; errorMessage: string };

export type ZaloTokenResult = { ok: true; accessToken: string } | { ok: false; error: ZaloTokenError };

type AdminClient = ReturnType<typeof createAdminClient>;

// Upserted by oa_id — one row for the one OA in scope (see migration
// 00028). Called after a successful OAuth exchange/refresh — always clears
// any stale refresh_lock_at/last_refresh_error_* from a previous failed
// attempt, since a success supersedes it.
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
      refresh_lock_at: null,
      last_refresh_at: new Date().toISOString(),
      last_refresh_error_code: null,
      last_refresh_error_message: null,
    },
    { onConflict: "oa_id" }
  );

  if (error) {
    throw new Error(`Không thể lưu token Zalo: ${error.message}`);
  }
}

// "Valid": token not expired (or expiry unknown, e.g. a manual env token —
// same permissive convention as isExpiringSoon below). "Expired": past
// expires_at with no successful refresh since. "Refresh failed": the last
// refresh attempt errored AND we still don't have a currently-valid token
// (a past failure stops mattering once a later refresh succeeds, which
// saveZaloTokens already clears). "Not connected": no row at all.
export type ZaloTokenStatus = "valid" | "expired" | "refresh_failed" | "not_connected";
export type ZaloConnectionHealth = "connected" | "needs_reconnect" | "not_connected";

export type ZaloConnectionStatus = {
  connected: boolean;
  oaId: string | null;
  expiresAt: string | null;
  tokenStatus: ZaloTokenStatus;
  connectionHealth: ZaloConnectionHealth;
  lastRefreshAt: string | null;
  lastRefreshErrorCode: string | null;
  lastRefreshErrorMessage: string | null;
};

// Read-only status for the settings UI — never returns the decrypted
// tokens themselves, only enough to render the connection/token health
// badges (Phần 2 of the ZL7 spec).
export async function getZaloConnectionStatus(): Promise<ZaloConnectionStatus> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("zalo_connections")
    .select("oa_id, expires_at, access_token_encrypted, last_refresh_at, last_refresh_error_code, last_refresh_error_message")
    .maybeSingle();

  if (!data) {
    return {
      connected: false,
      oaId: null,
      expiresAt: null,
      tokenStatus: "not_connected",
      connectionHealth: "not_connected",
      lastRefreshAt: null,
      lastRefreshErrorCode: null,
      lastRefreshErrorMessage: null,
    };
  }

  const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
  const isExpired = expiresAt != null && expiresAt.getTime() <= Date.now();

  // Proactively try decrypting the stored access token (cheap — local
  // crypto, no network) rather than only trusting the last recorded
  // last_refresh_error_code. Without this, the badge could read stale
  // "Valid" for a token that's actually undecryptable right now (e.g.
  // ZALO_TOKEN_ENCRYPTION_KEY rotated) until the next real send attempt
  // happens to hit it — exactly the kind of stale health status ZL7 is
  // meant to eliminate.
  let decryptable = true;
  try {
    decryptToken(data.access_token_encrypted);
  } catch {
    decryptable = false;
  }

  // last_refresh_error_code is cleared by every successful
  // saveZaloTokens() (see above) — so if it's still set, the MOST RECENT
  // *refresh* attempt failed, regardless of what expires_at says.
  let tokenStatus: ZaloTokenStatus;
  if (!decryptable || data.last_refresh_error_code) {
    tokenStatus = "refresh_failed";
  } else if (isExpired) {
    tokenStatus = "expired";
  } else {
    tokenStatus = "valid";
  }

  const connectionHealth: ZaloConnectionHealth = tokenStatus === "valid" ? "connected" : "needs_reconnect";

  return {
    connected: true,
    oaId: data.oa_id,
    expiresAt: data.expires_at,
    tokenStatus,
    connectionHealth,
    lastRefreshAt: data.last_refresh_at,
    lastRefreshErrorCode: data.last_refresh_error_code ?? (!decryptable ? "decrypt_failed" : null),
    lastRefreshErrorMessage:
      data.last_refresh_error_message ??
      (!decryptable ? "Không giải mã được token đã lưu — có thể ZALO_TOKEN_ENCRYPTION_KEY đã bị đổi. Cần kết nối lại Zalo OA." : null),
  };
}

type StoredConnection = { accessToken: string; refreshToken: string | null; expiresAt: Date | null };

// ZL7 production hardening finding: decryptToken() throws on a GCM
// auth-tag mismatch (see crypto.ts) — e.g. ZALO_TOKEN_ENCRYPTION_KEY was
// rotated after a token was stored. Before this fix, that throw propagated
// all the way up through sendZaloTextMessage (which has no try/catch around
// its getValidZaloAccessToken() call) and got flattened into service.ts's
// generic "unexpected_error" catch — a real, diagnosable misconfiguration
// indistinguishable from a random crash. Now it's its own structured
// "decrypt_failed" status so the health status UI and error logs can name
// it precisely instead of hiding it.
async function getStoredConnection(): Promise<
  { status: "none" } | { status: "decrypt_failed" } | ({ status: "ok" } & StoredConnection)
> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("zalo_connections")
    .select("access_token_encrypted, refresh_token_encrypted, expires_at")
    .maybeSingle();

  if (!data) return { status: "none" };

  try {
    return {
      status: "ok",
      accessToken: decryptToken(data.access_token_encrypted),
      refreshToken: data.refresh_token_encrypted ? decryptToken(data.refresh_token_encrypted) : null,
      expiresAt: data.expires_at ? new Date(data.expires_at) : null,
    };
  } catch {
    return { status: "decrypt_failed" };
  }
}

function isExpiringSoon(expiresAt: Date | null): boolean {
  if (!expiresAt) return false; // unknown expiry (e.g. manual env token) — treat as still valid
  return expiresAt.getTime() - Date.now() <= EXPIRY_SAFETY_BUFFER_SECONDS * 1000;
}

function toTokenError(result: Extract<ZaloTokenExchangeResult, { ok: false }>): ZaloTokenError {
  return { errorCode: result.errorCode, errorMessage: result.errorMessage };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Atomic conditional UPDATE: only succeeds (returns true) if no one else
// holds the lock, or the held lock is stale (REFRESH_LOCK_STALE_SECONDS —
// the previous holder likely crashed mid-refresh). This is the actual
// mutual-exclusion primitive; everything else in this file is just
// waiting/retry policy around it.
//
// Deliberately NOT filtered by oa_id: every read in this file
// (getStoredConnection, getZaloConnectionStatus) already treats
// zalo_connections as a de-facto singleton — `.maybeSingle()` with no
// WHERE at all — because the table is scoped to "the one OA this app
// talks to". Filtering by `getZaloAppConfig().oaId` here would silently
// match zero rows whenever the configured ZALO_OA_ID env var doesn't
// exactly equal whatever oa_id the row was originally saved under (e.g.
// the env var was edited after the fact) — these functions would then
// silently no-op instead of erroring, which is worse than just matching
// "the" row the same way every other read in this file already does.
async function claimRefreshLock(supabase: AdminClient): Promise<boolean> {
  const staleBefore = new Date(Date.now() - REFRESH_LOCK_STALE_SECONDS * 1000).toISOString();
  const { data, error } = await supabase
    .from("zalo_connections")
    .update({ refresh_lock_at: new Date().toISOString() })
    .or(`refresh_lock_at.is.null,refresh_lock_at.lt.${staleBefore}`)
    .select("oa_id");

  if (error) return false;
  return (data?.length ?? 0) > 0;
}

async function releaseRefreshLock(supabase: AdminClient): Promise<void> {
  await supabase.from("zalo_connections").update({ refresh_lock_at: null }).not("oa_id", "is", null);
}

async function recordRefreshFailure(supabase: AdminClient, error: ZaloTokenError): Promise<void> {
  await supabase
    .from("zalo_connections")
    .update({
      refresh_lock_at: null,
      last_refresh_at: new Date().toISOString(),
      last_refresh_error_code: error.errorCode,
      last_refresh_error_message: error.errorMessage,
    })
    .not("oa_id", "is", null);
}

// Waits (bounded) for another instance's in-flight refresh to finish, then
// re-reads whatever token ended up stored — never performs a second
// refresh_token grant itself. Returns the fresh result if the wait ended
// with a valid token, or null if the wait timed out / the other refresh
// also failed (caller falls through to claiming the lock itself).
async function waitForOtherRefresh(): Promise<ZaloTokenResult | null> {
  const deadline = Date.now() + REFRESH_LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(REFRESH_LOCK_POLL_INTERVAL_MS);
    const connection = await getStoredConnection();
    if (connection.status === "ok" && !isExpiringSoon(connection.expiresAt)) {
      return { ok: true, accessToken: connection.accessToken };
    }
  }
  return null;
}

// In-process de-dup: if this very Node/Vercel function instance already has
// a refresh in flight (e.g. sendNotification's loop somehow triggered two
// nearly-simultaneous checks), every caller piggybacks on the SAME promise
// instead of racing each other — this covers the same-instance case for
// free, on top of the cross-instance DB lock below.
let inFlightRefresh: Promise<ZaloTokenResult> | null = null;

// PHẦN 4: refresh using the stored refresh_token, atomically replacing the
// row's tokens (upsert overwrites both columns together, never a partial
// update that could leave a fresh access_token paired with a stale
// refresh_token or vice versa).
export async function refreshZaloAccessToken(): Promise<ZaloTokenResult> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = performLockedRefresh();
  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

async function performLockedRefresh(): Promise<ZaloTokenResult> {
  const supabase = createAdminClient();

  const gotLock = await claimRefreshLock(supabase);
  if (!gotLock) {
    const fromOther = await waitForOtherRefresh();
    if (fromOther) return fromOther;
    // Either the wait timed out or the other refresh also failed — fall
    // through and try to claim it ourselves (the stale-lock check in
    // claimRefreshLock means this can't deadlock even if the other holder
    // crashed).
  }

  const connection = await getStoredConnection();
  if (connection.status === "decrypt_failed") {
    const error: ZaloTokenError = {
      errorCode: "decrypt_failed",
      errorMessage: "Không giải mã được token đã lưu — có thể ZALO_TOKEN_ENCRYPTION_KEY đã bị đổi. Cần kết nối lại Zalo OA.",
    };
    await recordRefreshFailure(supabase, error);
    return { ok: false, error };
  }
  if (connection.status === "none" || !connection.refreshToken) {
    const error: ZaloTokenError = { errorCode: "no_refresh_token", errorMessage: "Chưa có refresh token để làm mới." };
    if (gotLock) await releaseRefreshLock(supabase);
    return { ok: false, error };
  }

  const result = await refreshZaloToken({ refreshToken: connection.refreshToken });
  if (!result.ok) {
    const error = toTokenError(result);
    await recordRefreshFailure(supabase, error);
    return { ok: false, error };
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

  if (connection.status === "decrypt_failed") {
    // A distinct, actionable misconfiguration (not "never connected") —
    // never falls back to the manual test token here, since that would
    // silently mask a real "cần kết nối lại" state from the caller. Also
    // recorded to last_refresh_error_* so the health status UI surfaces it
    // even though no refresh_token grant was actually attempted.
    const error: ZaloTokenError = {
      errorCode: "decrypt_failed",
      errorMessage: "Không giải mã được token đã lưu — có thể ZALO_TOKEN_ENCRYPTION_KEY đã bị đổi. Cần kết nối lại Zalo OA.",
    };
    await recordRefreshFailure(createAdminClient(), error);
    return { ok: false, error };
  }

  if (connection.status === "ok") {
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
