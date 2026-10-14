// ============================================================
// Shared error helpers for the Shopee sync services and job runners.
//
//   errorInfo                normalized { code, message } for logs / failures
//   isJobLevelProviderError  a provider failure that concerns the whole job
//                            (retry later / stop), not one record
//   toJobFailure             → retry-policy JobFailure (retryable | fatal)
// ============================================================
import type { JobFailure } from "../core/retry-policy.ts";
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
  if (err instanceof ShopeeApiError) {
    if (err.retryable) return { kind: "retryable", code, message, retryAfterSeconds: err.retryAfterSeconds, rateLimited: err.category === "rate_limit" };
    return { kind: "fatal", code, message };
  }
  if (err instanceof JobRefusedError) return { kind: "fatal", code: err.code, message: err.message };
  if (err instanceof ShopeeConfigError) return { kind: "fatal", code: "config_error", message: err.message };
  if (err instanceof ShopeePayloadError) return { kind: "fatal", code, message };
  return { kind: "retryable", code, message };
}
