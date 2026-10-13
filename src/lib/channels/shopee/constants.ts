// ============================================================
// PHASE SHOPEE-1: every Shopee tuning value in one place (no magic numbers
// scattered across files).
// ============================================================

export const SHOPEE_PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";

export const SHOPEE_PATHS = {
  authPartner: "/api/v2/shop/auth_partner",
  tokenGet: "/api/v2/auth/token/get",
  accessTokenGet: "/api/v2/auth/access_token/get",
  shopInfo: "/api/v2/shop/get_shop_info",
} as const;

/** Refresh this long BEFORE access-token expiry (Shopee access tokens live ~4h). */
export const TOKEN_REFRESH_BUFFER_SECONDS = 10 * 60;

/** Health badge turns "expiring_soon" inside this window. */
export const TOKEN_EXPIRING_SOON_SECONDS = 30 * 60;

/** Per-request network timeout. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Retries for retryable failures of idempotent (read) calls — never unbounded. */
export const MAX_READ_RETRIES = 2;
export const RETRY_BASE_DELAY_MS = 500;
/** Upper bound for honouring a provider Retry-After header. */
export const MAX_RETRY_DELAY_MS = 10_000;

/** Max in-flight Shopee requests per client instance (no unbounded fan-out). */
export const MAX_CONCURRENT_REQUESTS = 4;

/**
 * Refresh lease (migration 00039). Must comfortably exceed one refresh call
 * (REQUEST_TIMEOUT_MS, refresh is never retried) so a lease cannot lapse
 * while its holder is still refreshing.
 */
export const REFRESH_LEASE_SECONDS = 60;
export const REFRESH_WAIT_POLL_MS = 300;
export const REFRESH_WAIT_MAX_MS = 15_000;

/** OAuth-in-flight state cookie (anti-CSRF). */
export const AUTH_STATE_COOKIE = "shopee_auth_state";
export const AUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
