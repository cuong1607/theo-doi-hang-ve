// ============================================================
// PHASE SHOPEE-1: the generic Shopee Open Platform v2 request wrapper.
//
// Every Shopee call goes through ShopeeClient.request(): fresh timestamp +
// signature per attempt, common params, timeout, safe JSON parsing,
// normalized ShopeeApiError (request_id preserved), bounded retries, a
// per-instance concurrency cap, and metadata-only logging.
//
// Retry policy: only idempotent calls (GET by default) and only retryable
// categories (transient: 5xx / network / timeout / provider busy;
// rate_limit: 429 / documented codes), at most MAX_READ_RETRIES times,
// exponential backoff with jitter, honouring Retry-After (capped). Never
// retried: signature, auth, validation errors, and every POST unless the
// caller explicitly marks it idempotent (token refresh is NOT: a retried
// refresh could reuse an already-rotated refresh token).
//
// Logs NEVER contain: partner key, signature, access/refresh token, query
// string, request/response bodies.
//
// Dependencies (fetch, clock, sleep, logger) are injectable for tests; no
// "server-only" marker so `node --test` can import it — the server wiring
// lives in ./server.ts.
// ============================================================
import {
  MAX_CONCURRENT_REQUESTS,
  MAX_READ_RETRIES,
  MAX_RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
} from "./constants.ts";
import { ShopeeApiError } from "./errors.ts";
import { signedQuery, unixSeconds } from "./signing.ts";
import type { ShopeeEnvelope } from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ShopeeLogEvent {
  event: string;
  apiPath?: string;
  method?: string;
  externalShopId?: string;
  shopId?: string;
  ok?: boolean;
  httpStatus?: number | null;
  requestId?: string | null;
  errorCode?: string;
  category?: string;
  latencyMs?: number;
  attempt?: number;
  detail?: string;
}

export type ShopeeLogger = (event: ShopeeLogEvent) => void;

export const consoleShopeeLogger: ShopeeLogger = (event) => {
  const line = JSON.stringify({ source: "shopee", ...event });
  if (event.ok === false) console.warn(line);
  else console.info(line);
};

export interface ShopeeClientDeps {
  partnerId: number;
  partnerKey: string;
  apiBaseUrl: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: ShopeeLogger;
  timeoutMs?: number;
  maxRetries?: number;
  maxConcurrent?: number;
}

export interface ShopeeRequestOptions {
  path: string;
  method: "GET" | "POST";
  /** Shop-level call: signs with access token + Shopee shop id. Omit for public endpoints. */
  shop?: { externalShopId: string; accessToken: string };
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Defaults to true for GET, false for POST. Only idempotent calls are retried. */
  idempotent?: boolean;
  /** Internal shops.id, for log correlation only. */
  logShopId?: string;
}

export interface ShopeeResult<T> {
  data: T;
  requestId: string | null;
  latencyMs: number;
  attempts: number;
}

/** Minimal FIFO semaphore: caps concurrent in-flight requests. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

function parseRetryAfter(header: string | null, now: Date): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now.getTime()) / 1000));
}

export class ShopeeClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: ShopeeLogger;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly semaphore: Semaphore;

  private readonly deps: ShopeeClientDeps;

  constructor(deps: ShopeeClientDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    this.log = deps.logger ?? consoleShopeeLogger;
    this.timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxRetries = deps.maxRetries ?? MAX_READ_RETRIES;
    this.semaphore = new Semaphore(deps.maxConcurrent ?? MAX_CONCURRENT_REQUESTS);
  }

  get partnerId(): number {
    return this.deps.partnerId;
  }

  /** Builds a signed absolute URL (used for the browser redirect to auth_partner too). */
  signedUrl(path: string, query: ShopeeRequestOptions["query"] = {}, shop?: ShopeeRequestOptions["shop"]): string {
    const url = new URL(`${this.deps.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const signed = signedQuery({
      partnerId: this.deps.partnerId,
      partnerKey: this.deps.partnerKey,
      path,
      timestamp: unixSeconds(this.now()),
      scope: shop ? { kind: "shop", accessToken: shop.accessToken, shopId: shop.externalShopId } : { kind: "public" },
    });
    // Signed params always win over caller-supplied keys of the same name.
    for (const [key, value] of Object.entries(signed)) url.searchParams.set(key, value);
    return url.toString();
  }

  async request<T extends ShopeeEnvelope>(options: ShopeeRequestOptions): Promise<ShopeeResult<T>> {
    const idempotent = options.idempotent ?? options.method === "GET";
    const maxAttempts = idempotent ? this.maxRetries + 1 : 1;
    const started = Date.now();

    for (let attempt = 1; ; attempt++) {
      try {
        const { data, requestId } = await this.semaphore.run(() => this.attempt<T>(options, attempt));
        return { data, requestId, latencyMs: Date.now() - started, attempts: attempt };
      } catch (err) {
        const error =
          err instanceof ShopeeApiError
            ? err
            : new ShopeeApiError({ apiPath: options.path, errorCode: "unexpected_error", message: "Lỗi không xác định khi gọi Shopee." });
        if (!error.retryable || attempt >= maxAttempts) throw error;
        const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (1 + this.random() * 0.25);
        const delay = Math.min(error.retryAfterSeconds != null ? error.retryAfterSeconds * 1000 : backoff, MAX_RETRY_DELAY_MS);
        await this.sleep(delay);
      }
    }
  }

  /** Defense in depth: strip any secret we sent if the provider echoes it back in a message. */
  private redact(text: string, options: ShopeeRequestOptions): string {
    const secrets = [this.deps.partnerKey, options.shop?.accessToken];
    if (options.body && typeof options.body === "object") {
      for (const [key, value] of Object.entries(options.body)) {
        if (/token|code/i.test(key) && typeof value === "string") secrets.push(value);
      }
    }
    return secrets.reduce<string>((acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc), text);
  }

  private async attempt<T extends ShopeeEnvelope>(
    options: ShopeeRequestOptions,
    attempt: number,
  ): Promise<{ data: T; requestId: string | null }> {
    const url = this.signedUrl(options.path, options.query, options.shop);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    const logBase = {
      event: "shopee_api_call",
      apiPath: options.path,
      method: options.method,
      externalShopId: options.shop?.externalShopId,
      shopId: options.logShopId,
      attempt,
    };

    const fail = (error: ShopeeApiError): never => {
      error.message = this.redact(error.message, options);
      this.log({
        ...logBase,
        ok: false,
        httpStatus: error.httpStatus,
        requestId: error.requestId,
        errorCode: error.errorCode,
        category: error.category,
        latencyMs: Date.now() - started,
      });
      throw error;
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method,
        headers: options.method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: options.method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return fail(
        new ShopeeApiError({
          apiPath: options.path,
          errorCode: aborted ? "timeout" : "network_error",
          message: aborted ? `Shopee không phản hồi trong ${this.timeoutMs}ms.` : "Không kết nối được tới Shopee.",
        }),
      );
    } finally {
      clearTimeout(timer);
    }

    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), this.now());
    let data: T;
    try {
      data = (await response.json()) as T;
    } catch {
      return fail(
        new ShopeeApiError({
          apiPath: options.path,
          errorCode: "invalid_response",
          message: `Shopee trả về dữ liệu không phải JSON (HTTP ${response.status}).`,
          httpStatus: response.status,
          retryAfterSeconds,
        }),
      );
    }

    const requestId = typeof data?.request_id === "string" && data.request_id ? data.request_id : null;
    const errorCode = typeof data?.error === "string" ? data.error : "";
    if (errorCode || !response.ok) {
      return fail(
        new ShopeeApiError({
          apiPath: options.path,
          errorCode: errorCode || `http_${response.status}`,
          message: (typeof data?.message === "string" && data.message) || `Shopee trả về HTTP ${response.status}.`,
          requestId,
          httpStatus: response.status,
          retryAfterSeconds,
        }),
      );
    }

    this.log({ ...logBase, ok: true, httpStatus: response.status, requestId, latencyMs: Date.now() - started });
    return { data, requestId };
  }
}
