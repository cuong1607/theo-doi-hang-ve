// ============================================================
// PHASE SHOPEE-1: normalized Shopee provider errors.
//
// Every failure of the Shopee client surfaces as ShopeeApiError — with
// Shopee's request_id kept (Shopee support asks for it) and a category that
// drives retry and connection-status decisions.
//
// Classification of Shopee's string error codes is BEST-EFFORT: the official
// code list could not be retrieved while building SHOPEE-1, so it keys on
// stable patterns (…auth…, …token…, …permission…, error_sign, HTTP status).
// Validate against real error payloads (docs "Real payload validation").
// Unknown codes are NEVER treated as revoked authorization.
// ============================================================

export type ShopeeErrorCategory =
  | "auth" // token invalid/expired or permission withdrawn → refresh / reconnect
  | "signature" // wrong sign / partner credentials / clock → config problem
  | "rate_limit"
  | "transient" // 5xx, provider busy, network, timeout
  | "invalid_request"
  | "invalid_response"
  | "unknown";

export class ShopeeApiError extends Error {
  readonly apiPath: string;
  readonly errorCode: string;
  readonly requestId: string | null;
  readonly httpStatus: number | null;
  readonly category: ShopeeErrorCategory;
  readonly retryable: boolean;
  /** Seconds from a Retry-After header, when the provider sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    apiPath: string;
    errorCode: string;
    message: string;
    requestId?: string | null;
    httpStatus?: number | null;
    retryAfterSeconds?: number | null;
    category?: ShopeeErrorCategory;
  }) {
    super(init.message);
    this.name = "ShopeeApiError";
    this.apiPath = init.apiPath;
    this.errorCode = init.errorCode;
    this.requestId = init.requestId ?? null;
    this.httpStatus = init.httpStatus ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.category = init.category ?? classifyShopeeError(init.errorCode, init.httpStatus ?? null);
    this.retryable = this.category === "transient" || this.category === "rate_limit";
  }

  /** Safe, serializable view (no secrets exist on this object by construction). */
  toJSON() {
    return {
      apiPath: this.apiPath,
      errorCode: this.errorCode,
      message: this.message,
      requestId: this.requestId,
      httpStatus: this.httpStatus,
      category: this.category,
      retryable: this.retryable,
    };
  }
}

const RATE_LIMIT_PATTERN = /too_many|rate_limit|frequen|throttl/i;
const TRANSIENT_PATTERN = /error_server|error_inner|system_busy|internal|timeout|unavailable|busy/i;
const AUTH_PATTERN = /(^|_)(auth|token|permission|unauthori[sz]ed|forbidden)/i;
const SIGNATURE_PATTERN = /(^|_)sign($|_)|partner/i;

export function classifyShopeeError(errorCode: string, httpStatus: number | null): ShopeeErrorCategory {
  if (errorCode === "network_error" || errorCode === "timeout") return "transient";
  if (errorCode === "invalid_response") return httpStatus != null && httpStatus >= 500 ? "transient" : "invalid_response";
  if (httpStatus === 429 || RATE_LIMIT_PATTERN.test(errorCode)) return "rate_limit";
  if (SIGNATURE_PATTERN.test(errorCode)) return "signature";
  if (AUTH_PATTERN.test(errorCode)) return "auth";
  if ((httpStatus != null && httpStatus >= 500) || TRANSIENT_PATTERN.test(errorCode)) return "transient";
  if (/param|invalid|not_found|illegal/i.test(errorCode)) return "invalid_request";
  if (httpStatus === 401 || httpStatus === 403) return "auth";
  return "unknown";
}

/** Revoked-vs-expired wording for a failed refresh classified as "auth". */
export function looksRevoked(error: ShopeeApiError): boolean {
  return /revok|cancel|unbind|deauthori[sz]|no.?permission|not.?authori[sz]/i.test(`${error.errorCode} ${error.message}`);
}
