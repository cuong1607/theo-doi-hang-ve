// ============================================================
// ZALO PERSONAL Phase 02 — request handling for the worker endpoints.
// Pure + injected (store, secret decryption, clock): the whole auth →
// replay → rate-limit → validation → ingest path is unit-testable.
//
// Order (cheap and unauthenticated checks first, nothing written before the
// signature is proven):
//   flag → size → headers → timestamp window → worker lookup → HMAC
//   (constant time) → worker / connection status → nonce + rate limit
//   (database, atomic) → JSON + zod → connection binding → ingest (database).
// Unknown worker and bad signature return the SAME 401 body (no worker
// enumeration); the precise reason is only in the server log.
// Never logged: secrets, signatures, bodies, message text.
// ============================================================
import type { ZodType } from "zod";

import type { ZaloPersonalIngestConfig } from "./config.ts";
import { describeIssues, heartbeatSchema, ingestBatchSchema, type EventResult, type Heartbeat, type IngestEvent } from "./contracts.ts";
import { HEADER, NONCE_PATTERN, signatureMatches, WORKER_KEY_PATTERN } from "./signing.ts";

/** "outbound" = Phase 04.5 claim / result of approved replies (same HMAC + replay + rate limit). */
export type Endpoint = "events" | "heartbeat" | "outbound";

export interface WorkerRecord {
  id: string;
  workerKey: string;
  status: "active" | "revoked";
  connectionKey: string;
  connectionStatus: "active" | "disabled";
  secretEncrypted: string;
}

export type StoreError = "worker_revoked" | "connection_disabled" | "account_not_bound" | "account_mismatch" | "account_in_use" | "invalid_payload";

export interface ZaloPersonalStore {
  findWorker(workerKey: string): Promise<WorkerRecord | null>;
  registerRequest(workerId: string, nonce: string, endpoint: Endpoint, maxPerWindow: number, windowSeconds: number): Promise<"ok" | "nonce_reused" | "rate_limited">;
  ingest(workerId: string, accountId: string, events: IngestEvent[]): Promise<{ ok: true; results: EventResult[] } | { ok: false; error: StoreError }>;
  heartbeat(workerId: string, accountId: string | null, state: Omit<Heartbeat, "v" | "connectionKey" | "accountId">): Promise<{ ok: true; serverTime: string } | { ok: false; error: StoreError }>;
}

export interface IngestDeps {
  store: ZaloPersonalStore;
  config: ZaloPersonalIngestConfig;
  /** Decrypts the stored worker secret (bound to the worker id) to HMAC key bytes. */
  secretKey(worker: WorkerRecord): Buffer;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface WorkerRequest {
  method: string;
  path: string;
  header(name: string): string | null;
  rawBody: string;
}

export interface Outcome {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Outcome => ({ status, body: { ok: false, error, ...extra }, headers });
const UNAUTHORIZED = () => fail(401, "unauthorized");

const STORE_ERROR_STATUS: Record<StoreError, number> = {
  worker_revoked: 403,
  connection_disabled: 403,
  account_mismatch: 409,
  account_in_use: 409,
  account_not_bound: 409,
  invalid_payload: 400,
};

/**
 * Everything up to (and including) replay protection + rate limiting, shared by
 * every worker endpoint: flag → size → headers → timestamp → worker → HMAC →
 * status → nonce / rate limit. Nothing is written before the signature is proven.
 */
export async function authenticateWorkerRequest(endpoint: Endpoint, req: WorkerRequest, deps: IngestDeps): Promise<{ ok: true; worker: WorkerRecord } | { ok: false; outcome: Outcome }> {
  const log = deps.log ?? ((event, fields) => console.info(JSON.stringify({ source: "zalo-personal-ingest", event, endpoint, ...fields })));
  const now = (deps.now ?? (() => new Date()))();
  const { config } = deps;
  const no = (outcome: Outcome) => ({ ok: false as const, outcome });

  if (!config.enabled) return no(fail(503, "not_enabled"));
  if (Buffer.byteLength(req.rawBody, "utf8") > config.maxBodyBytes) return no(fail(413, "payload_too_large"));
  const workerKey = req.header(HEADER.worker)?.trim() ?? "";
  const timestamp = req.header(HEADER.timestamp)?.trim() ?? "";
  const nonce = req.header(HEADER.nonce)?.trim() ?? "";
  const signature = req.header(HEADER.signature)?.trim() ?? "";
  if (!WORKER_KEY_PATTERN.test(workerKey) || !/^[0-9]{13}$/.test(timestamp) || !NONCE_PATTERN.test(nonce) || !signature) {
    log("rejected", { reason: "missing_or_malformed_auth_headers" });
    return no(UNAUTHORIZED());
  }
  if (Math.abs(now.getTime() - Number(timestamp)) > config.maxSkewMs) {
    log("rejected", { reason: "timestamp_out_of_window", workerKey });
    return no(fail(401, "timestamp_out_of_window", { serverTime: now.toISOString() }));
  }
  const worker = await deps.store.findWorker(workerKey);
  if (!worker) {
    log("rejected", { reason: "unknown_worker", workerKey });
    return no(UNAUTHORIZED());
  }
  let key: Buffer;
  try {
    key = deps.secretKey(worker);
  } catch {
    log("error", { reason: "secret_unavailable", workerKey });
    return no(fail(500, "server_error"));
  }
  if (!signatureMatches(key, { method: req.method, path: req.path, workerKey, timestamp, nonce, rawBody: req.rawBody }, signature)) {
    log("rejected", { reason: "bad_signature", workerKey });
    return no(UNAUTHORIZED());
  }
  if (worker.status !== "active") return no(fail(403, "worker_revoked"));
  if (worker.connectionStatus !== "active") return no(fail(403, "connection_disabled"));
  const reg = await deps.store.registerRequest(worker.id, nonce, endpoint, config.rateLimitPerMinute, 60);
  if (reg === "nonce_reused") {
    log("rejected", { reason: "nonce_reused", workerKey });
    return no(fail(409, "nonce_reused"));
  }
  if (reg === "rate_limited") {
    log("rejected", { reason: "rate_limited", workerKey });
    return no(fail(429, "rate_limited", {}, { "Retry-After": "30" }));
  }
  return { ok: true, worker };
}

export async function handleWorkerRequest(endpoint: Endpoint, req: WorkerRequest, deps: IngestDeps): Promise<Outcome> {
  const log = deps.log ?? ((event, fields) => console.info(JSON.stringify({ source: "zalo-personal-ingest", event, endpoint, ...fields })));
  const auth = await authenticateWorkerRequest(endpoint, req, deps);
  if (!auth.ok) return auth.outcome;
  const worker = auth.worker;
  const workerKey = worker.workerKey;

  // payload
  let json: unknown;
  try {
    json = JSON.parse(req.rawBody);
  } catch {
    return fail(400, "invalid_payload", { issues: ["(root): invalid_json"] });
  }
  const schema: ZodType = endpoint === "events" ? ingestBatchSchema : heartbeatSchema;
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    log("rejected", { reason: "invalid_payload", workerKey });
    return fail(400, "invalid_payload", { issues: describeIssues(parsed.error) });
  }
  const payload = parsed.data as { connectionKey: string };
  if (payload.connectionKey !== worker.connectionKey) {
    log("rejected", { reason: "connection_mismatch", workerKey });
    return fail(403, "connection_mismatch");
  }

  if (endpoint === "heartbeat") {
    const hb = parsed.data as Heartbeat;
    const state = {
      workerVersion: hb.workerVersion,
      workerStartedAt: hb.workerStartedAt,
      sessionState: hb.sessionState,
      listenerState: hb.listenerState,
      lastMessageReceivedAt: hb.lastMessageReceivedAt,
      lastDeliveryOkAt: hb.lastDeliveryOkAt,
      outboxDepth: hb.outboxDepth,
      deadLetterCount: hb.deadLetterCount,
      outboxFullDrops: hb.outboxFullDrops,
      lastErrorCategory: hb.lastErrorCategory,
    };
    const res = await deps.store.heartbeat(worker.id, hb.accountId, state);
    if (!res.ok) {
      log("rejected", { reason: res.error, workerKey });
      return fail(STORE_ERROR_STATUS[res.error], res.error);
    }
    return { status: 200, body: { ok: true, serverTime: res.serverTime } };
  }

  const batch = parsed.data as { accountId: string; events: IngestEvent[] };
  const res = await deps.store.ingest(worker.id, batch.accountId, batch.events);
  if (!res.ok) {
    log("rejected", { reason: res.error, workerKey });
    return fail(STORE_ERROR_STATUS[res.error], res.error);
  }
  const counts: Record<string, number> = {};
  for (const r of res.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  log("ingested", { workerKey, events: batch.events.length, ...counts });
  return { status: 200, body: { ok: true, results: res.results } };
}
