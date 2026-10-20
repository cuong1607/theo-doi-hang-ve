// ============================================================
// PHASE SHOPEE-PERF-1: job retry scheduling + execution budget (pure).
//
// A worker never sleeps for a long time inside a serverless request: a
// retryable failure persists next_attempt_at and returns. Backoff per
// failed attempt ≈ 1 min → 5 min → 15 min (+ up to 20 % jitter), and a
// provider Retry-After wins when it is longer.
// ============================================================

// SHOPEE-9A: 1 → 5 → 15 → 30 → 60 min (attempt_count resets whenever a slice makes progress).
const BACKOFF_SECONDS = [60, 5 * 60, 15 * 60, 30 * 60, 60 * 60] as const;
const MAX_RETRY_AFTER_SECONDS = 60 * 60;
/** A rate-limited job never comes back sooner than this (no hammering). */
const RATE_LIMIT_MIN_SECONDS = 5 * 60;

export function retryDelaySeconds(attempt: number, options: { retryAfterSeconds?: number | null; random?: () => number; rateLimited?: boolean } = {}): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_SECONDS.length) - 1;
  const base = Math.max(BACKOFF_SECONDS[index], options.rateLimited ? RATE_LIMIT_MIN_SECONDS : 0);
  const jittered = Math.round(base * (1 + (options.random ?? Math.random)() * 0.2));
  const retryAfter = options.retryAfterSeconds != null && options.retryAfterSeconds > 0 ? Math.min(options.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) : 0;
  return Math.max(jittered, retryAfter);
}

/**
 * SHOPEE-9A error categories (shown in the health page / logs). Retry is
 * decided by `kind`; the category says what to do about it.
 */
export type ErrorCategory = "AUTH" | "RATE_LIMIT" | "PROVIDER_TEMPORARY" | "PROVIDER_INVALID_REQUEST" | "NETWORK" | "TIMEOUT" | "DATABASE" | "DATA_MAPPING" | "CONFIG" | "UNKNOWN";

export const ERROR_CATEGORY_LABELS: Record<ErrorCategory, string> = {
  AUTH: "Shop cần kết nối lại Shopee",
  RATE_LIMIT: "Bị giới hạn API Shopee — sẽ tự thử lại",
  PROVIDER_TEMPORARY: "Shopee lỗi tạm thời — sẽ tự thử lại",
  PROVIDER_INVALID_REQUEST: "Shopee từ chối yêu cầu",
  NETWORK: "Lỗi mạng — sẽ tự thử lại",
  TIMEOUT: "Hết thời gian chờ — sẽ tự thử lại",
  DATABASE: "Lỗi cơ sở dữ liệu — sẽ tự thử lại",
  DATA_MAPPING: "Dữ liệu Shopee không đọc được",
  CONFIG: "Cấu hình chưa đúng",
  UNKNOWN: "Lỗi không xác định",
};

/** What a failed slice means for its job. */
export type JobFailureKind =
  | "retryable" // timeout, network, 5xx, provider busy, rate limit → retry with backoff
  | "fatal"; // auth, signature, revoked token, malformed request, config → stop, no blind retry

export interface JobFailure {
  kind: JobFailureKind;
  code: string;
  message: string;
  retryAfterSeconds?: number | null;
  rateLimited?: boolean;
  category?: ErrorCategory;
}

export interface FailureDecision {
  status: "retry" | "failed";
  nextAttemptAt: Date | null;
}

/**
 * attempt = the job's attempt_count AFTER the claim of the failing slice.
 * Fatal → failed now. Retryable → retry until max_attempts, then failed
 * (dead letter: an admin can "Thử lại").
 */
export function decideFailure(failure: JobFailure, attempt: number, maxAttempts: number, now: Date, random?: () => number): FailureDecision {
  if (failure.kind === "fatal" || attempt >= maxAttempts) return { status: "failed", nextAttemptAt: null };
  const delay = retryDelaySeconds(attempt, { retryAfterSeconds: failure.retryAfterSeconds, random, rateLimited: failure.rateLimited });
  return { status: "retry", nextAttemptAt: new Date(now.getTime() + delay * 1000) };
}

/**
 * Bounded execution for one job slice: a wall-clock deadline and a cap on
 * provider calls. Runners check `canSpend(n)` BEFORE each page / detail
 * batch and checkpoint + yield when it says no.
 */
export class ExecutionBudget {
  private readonly deadline: number;
  private readonly maxApiCalls: number;
  private readonly clock: () => number;
  private calls = 0;

  constructor(options: { timeMs: number; maxApiCalls: number; clock?: () => number }) {
    this.clock = options.clock ?? Date.now;
    this.deadline = this.clock() + options.timeMs;
    this.maxApiCalls = options.maxApiCalls;
  }

  /** Records provider calls actually made (the counter wrapper calls this). */
  spend(n = 1) {
    this.calls += n;
  }

  get apiCallsUsed(): number {
    return this.calls;
  }

  get apiCallsLeft(): number {
    return Math.max(0, this.maxApiCalls - this.calls);
  }

  /** True when `n` more calls fit in the call cap and time remains. */
  canSpend(n = 1): boolean {
    return this.calls + n <= this.maxApiCalls && this.clock() < this.deadline;
  }

  get expired(): boolean {
    return this.clock() >= this.deadline;
  }
}
