// ============================================================
// PHASE 04.5 — REPLY-06: worker-facing outbound endpoints. Pure + injected.
//
//   POST /api/internal/zalo-personal/outbound/claim    → at most ONE job
//   POST /api/internal/zalo-personal/outbound/result   → delivery outcome
//
// Same authentication as ingestion (authenticateWorkerRequest: HMAC, time
// window, nonce, per-worker rate limit). A worker can only ever claim jobs of
// ITS connection, only for the Zalo account bound to it, and only after every
// gate is re-checked in zp_reply_claim_outbound. The destination thread comes
// from the stored inbound conversation — never from the model or the request.
// Never logged: reply text, thread ids, secrets.
// ============================================================
import { authenticateWorkerRequest, type IngestDeps, type Outcome, type WorkerRequest } from "../zalo-personal/ingest.ts";
import type { ReplyConfig } from "./config.ts";
import { claimBody, resultBody } from "./contracts.ts";
import type { OutboundStore } from "./store.ts";

export interface OutboundDeps {
  ingest: IngestDeps;
  config: ReplyConfig;
  store: OutboundStore;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const fail = (status: number, error: string): Outcome => ({ status, body: { ok: false, error } });
/** how long an idle worker should wait before asking again */
const IDLE_MS = 15_000;

const STORE_STATUS: Record<string, number> = { worker_revoked: 403, connection_disabled: 403, account_not_bound: 409, account_mismatch: 409, unknown_job: 404, invalid_outcome: 400 };

export async function handleOutbound(kind: "claim" | "result", req: WorkerRequest, deps: OutboundDeps): Promise<Outcome> {
  const log = deps.log ?? ((event, fields) => console.info(JSON.stringify({ source: "zalo-reply-outbound", event, kind, ...fields })));
  const auth = await authenticateWorkerRequest("outbound", req, deps.ingest);
  if (!auth.ok) return auth.outcome;
  const worker = auth.worker;

  let json: unknown;
  try {
    json = JSON.parse(req.rawBody);
  } catch {
    return fail(400, "invalid_payload");
  }

  if (kind === "claim") {
    const p = claimBody.safeParse(json);
    if (!p.success) return fail(400, "invalid_payload");
    if (p.data.connectionKey !== worker.connectionKey) return fail(403, "connection_mismatch");
    // flags are enforced by the backend: a disabled feature answers "nothing to send"
    if (!deps.config.sendEnabled) return { status: 200, body: { ok: true, job: null, reason: "send_disabled", pollAfterMs: IDLE_MS * 4 } };
    const r = await deps.store.claim(worker.id, p.data.accountId, deps.config.leaseSeconds, deps.config.globalDailyLimit, deps.config.autoReplyEnabled);
    if (!r.ok) {
      log("claim_refused", { workerKey: worker.workerKey, error: r.error });
      return fail(STORE_STATUS[r.error] ?? 500, r.error);
    }
    if (r.job) log("claimed", { workerKey: worker.workerKey });
    return { status: 200, body: { ok: true, job: r.job, reason: r.reason, pollAfterMs: r.job ? 0 : IDLE_MS } };
  }

  const p = resultBody.safeParse(json);
  if (!p.success) return fail(400, "invalid_payload");
  if (p.data.connectionKey !== worker.connectionKey) return fail(403, "connection_mismatch");
  // a result is ALWAYS accepted, even with sending switched off: it records what already happened
  const r = await deps.store.report(worker.id, p.data.draftId, p.data.claimToken, p.data.outcome, p.data.zaloMsgId, p.data.errorCategory);
  if (!r.ok) {
    log("report_refused", { workerKey: worker.workerKey, error: r.error });
    return fail(STORE_STATUS[r.error] ?? 500, r.error);
  }
  log("reported", { workerKey: worker.workerKey, outcome: p.data.outcome, status: r.status, changed: r.changed, error: p.data.errorCategory });
  return { status: 200, body: { ok: true, status: r.status, changed: r.changed } };
}
