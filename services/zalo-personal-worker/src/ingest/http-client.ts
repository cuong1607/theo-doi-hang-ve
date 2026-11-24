// ============================================================
// Signed HTTPS client to the backend ingestion endpoints.
// Every request gets a fresh nonce + timestamp + signature (so a retry of
// the same events is a NEW request; the events keep their eventKey).
// HTTPS is required except for localhost (local Supabase / next dev).
// ============================================================
import { HEADER, newNonce, sign } from "./signing.ts";

export type HttpResult =
  | { kind: "response"; status: number; body: Record<string, unknown> | null; retryAfterMs: number | null }
  | { kind: "network"; error: "timeout" | "network" };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface SignedClientOptions {
  baseUrl: string;
  workerKey: string;
  secretKey: Buffer;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export function assertSafeBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ZP_INGEST_URL không hợp lệ.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("ZP_INGEST_URL phải dùng HTTPS (chỉ localhost được dùng http).");
  if (url.username || url.password) throw new Error("ZP_INGEST_URL không được chứa thông tin đăng nhập.");
  return url;
}

export class SignedClient {
  private readonly base: URL;
  private readonly opts: SignedClientOptions;

  constructor(opts: SignedClientOptions) {
    this.base = assertSafeBaseUrl(opts.baseUrl);
    this.opts = opts;
  }

  async post(path: string, payload: unknown, signal?: AbortSignal): Promise<HttpResult> {
    const url = new URL(path, this.base);
    const rawBody = JSON.stringify(payload);
    const timestamp = String((this.opts.now ?? Date.now)());
    const nonce = newNonce();
    const signature = sign(this.opts.secretKey, { method: "POST", path: url.pathname, workerKey: this.opts.workerKey, timestamp, nonce, rawBody });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await (this.opts.fetchImpl ?? (fetch as unknown as FetchLike))(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json", [HEADER.worker]: this.opts.workerKey, [HEADER.timestamp]: timestamp, [HEADER.nonce]: nonce, [HEADER.signature]: signature },
        body: rawBody,
        signal: controller.signal,
      });
      let body: Record<string, unknown> | null = null;
      try {
        const text = await res.text();
        body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const ra = Number(res.headers.get("retry-after"));
      return { kind: "response", status: res.status, body, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null };
    } catch {
      return { kind: "network", error: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export type DeliveryClass =
  | "success"
  | "retry" // transient: 5xx, timeout, network, unknown status, not yet enabled
  | "rate_limited" // 429
  | "retry_now" // 409 nonce_reused: a fresh request fixes it
  | "not_bound" // 409 account_not_bound: wait for a heartbeat
  | "split" // 400 / 413: one event may be bad → resend one by one
  | "auth"; // 401 / 403 / account conflicts: stop until an operator fixes it

/** How the delivery loop reacts to an HTTP outcome. Pure. */
export function classifyResult(r: HttpResult): DeliveryClass {
  if (r.kind === "network") return "retry";
  const error = typeof r.body?.error === "string" ? r.body.error : null;
  if (r.status >= 200 && r.status < 300) return "success";
  if (r.status === 429) return "rate_limited";
  if (r.status === 400 || r.status === 413) return "split";
  if (r.status === 401 || r.status === 403) return "auth";
  if (r.status === 409) return error === "nonce_reused" ? "retry_now" : error === "account_not_bound" ? "not_bound" : "auth";
  return "retry";
}
