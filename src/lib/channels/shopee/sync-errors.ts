// ============================================================
// Shared error helpers for the Shopee sync services and job runners.
//
//   errorInfo                normalized { code, message } for logs / failures
//   isJobLevelProviderError  a provider failure that concerns the whole job
//                            (retry later / stop), not one record
//   toJobFailure             → retry-policy JobFailure (retryable | fatal)
// ============================================================
import type { ErrorCategory, JobFailure } from "../core/retry-policy.ts";
import { ShopeeConfigError } from "./config.ts";
import { ShopeeApiError } from "./errors.ts";
import { ShopeePayloadError } from "./product-adapter.ts";

export function errorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof ShopeeApiError) return { code: err.errorCode, message: `${err.message}${err.requestId ? ` (request_id: ${err.requestId})` : ""}` };
  if (err instanceof ShopeePayloadError) return { code: "provider_parse_error", message: err.message };
  if (err instanceof Error) return { code: "sync_error", message: err.message.slice(0, 300) };
  return { code: "sync_error", message: "Lỗi không xác định." };
}

/** The job can never run as configured (unknown shop, wrong data source, unsupported type) — failed without retry. */
export class JobRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JobRefusedError";
    this.code = code;
  }
}

/** Retryable (rate limit / transient) or auth / signature → the job, not a record, is affected. */
export function isJobLevelProviderError(err: unknown): err is ShopeeApiError {
  return err instanceof ShopeeApiError && (err.retryable || err.category === "auth" || err.category === "signature");
}

/**
 * Retry only what can succeed later: timeout, network, 5xx, provider busy,
 * documented rate limit. Never blindly retried: invalid signature, revoked /
 * expired authorization, malformed request, missing config. A bug or a DB
 * hiccup ("sync_error") is retried — bounded by max_attempts.
 */
export function toJobFailure(err: unknown): JobFailure {
  const { code, message } = errorInfo(err);
  const category = errorCategoryOf(err);
  if (err instanceof ShopeeApiError) {
    if (err.retryable) return { kind: "retryable", code, message, retryAfterSeconds: err.retryAfterSeconds, rateLimited: err.category === "rate_limit", category };
    return { kind: "fatal", code, message, category };
  }
  if (err instanceof JobRefusedError) return { kind: "fatal", code: err.code, message: err.message, category };
  if (err instanceof ShopeeConfigError) return { kind: "fatal", code: "config_error", message: err.message, category };
  if (err instanceof ShopeePayloadError) return { kind: "fatal", code, message, category };
  return { kind: "retryable", code, message, category };
}

const DB_PATTERN = /không (đọc|ghi|lưu|cập nhật|tạo)|database|postgres|PGRST|relation |permission denied|connection|fetch failed/i;

/** SHOPEE-9A: the operational category of any sync error (health page / logs). */
export function errorCategoryOf(err: unknown): ErrorCategory {
  if (err instanceof ShopeeApiError) {
    if (err.errorCode === "timeout") return "TIMEOUT";
    if (err.errorCode === "network_error") return "NETWORK";
    switch (err.category) {
      case "auth":
        return "AUTH";
      case "signature":
        return "CONFIG";
      case "rate_limit":
        return "RATE_LIMIT";
      case "transient":
        return "PROVIDER_TEMPORARY";
      case "invalid_request":
        return "PROVIDER_INVALID_REQUEST";
      case "invalid_response":
        return "DATA_MAPPING";
      default:
        return "UNKNOWN";
    }
  }
  if (err instanceof ShopeePayloadError) return "DATA_MAPPING";
  if (err instanceof ShopeeConfigError) return "CONFIG";
  if (err instanceof JobRefusedError) return "CONFIG";
  if (err instanceof Error && DB_PATTERN.test(err.message)) return "DATABASE";
  return "UNKNOWN";
}

/** Categories that say the SHOP / provider is in trouble (count toward the circuit breaker). */
export const PROVIDER_FAILURE_CATEGORIES: readonly ErrorCategory[] = ["AUTH", "RATE_LIMIT", "PROVIDER_TEMPORARY", "PROVIDER_INVALID_REQUEST", "NETWORK", "TIMEOUT"];
