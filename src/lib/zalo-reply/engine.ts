// ============================================================
// PHASE 04.5 — one bounded reply tick (cron / internal endpoint):
//   1. recover   expire stale drafts; a 'sending' lease that ran out → delivery_unknown
//   2. scan      new stored messages per connection (cursor, lease) → router
//                decisions (UNIQUE message_id: a replayed scan changes nothing)
//   3. process   claimed inbound questions → pipeline → drafts (≤ maxPerTick)
// Nothing here sends: sending is the worker's job (claim endpoint).
// Safe to run concurrently (leases + SKIP LOCKED + unique keys). The abort
// signal stops it between steps.
// ============================================================
import { processInbound, type PipelineDeps } from "./pipeline.ts";
import { routeMessage } from "./router.ts";
import type { InboundDecision } from "./store.ts";

export interface EngineDeps extends PipelineDeps {
  workerId: string;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface TickStats {
  expired: number;
  unknown: number;
  connections: number;
  scanned: number;
  queued: number;
  skipped: number;
  drafts: number;
  autoQueued: number;
  processSkipped: number;
  retries: number;
  errors: number;
}

export async function runReplyTick(deps: EngineDeps): Promise<{ status: "disabled" | "ok" | "partial" | "error"; stats: TickStats }> {
  const stats: TickStats = { expired: 0, unknown: 0, connections: 0, scanned: 0, queued: 0, skipped: 0, drafts: 0, autoQueued: 0, processSkipped: 0, retries: 0, errors: 0 };
  if (!deps.config.enabled) return { status: "disabled", stats };
  const now = () => deps.now?.() ?? new Date();
  const aborted = () => deps.signal?.aborted === true;
  const log = deps.log ?? (() => {});

  try {
    const r = await deps.store.recover();
    stats.expired = r.expired;
    stats.unknown = r.unknown;
  } catch {
    stats.errors++;
  }

  // ---- scan
  let claims: Awaited<ReturnType<typeof deps.store.scanClaim>> = [];
  try {
    claims = await deps.store.scanClaim(deps.workerId, 120, 0, 10);
  } catch {
    stats.errors++;
  }
  for (const c of claims) {
    if (aborted()) {
      await deps.store.scanRelease(c.connectionId, deps.workerId).catch(() => {});
      continue;
    }
    stats.connections++;
    try {
      const settings = await deps.store.settings(c.connectionId);
      let cursor = { at: c.cursorAt, id: c.cursorId };
      for (let batch = 0; batch < 3; batch++) {
        const rows = await deps.store.scanMessages(c.connectionId, cursor.at, cursor.id, new Date(now().getTime() - deps.config.scanLagMs), deps.config.scanBatch);
        const decisions: InboundDecision[] = [];
        for (const m of rows) {
          const d = routeMessage(m, c.zaloAccountId, settings);
          if (d.record) decisions.push({ messageId: m.id, trigger: d.trigger, decision: d.decision, reason: d.reason });
        }
        const last = rows.at(-1);
        const done = rows.length < deps.config.scanBatch || batch === 2 || aborted();
        const res = await deps.store.scanCommit(c.connectionId, deps.workerId, last ? { at: last.ingestedAt, id: last.id } : null, rows.length, decisions, done);
        if (!res.ok) {
          stats.errors++;
          break;
        }
        stats.scanned += rows.length;
        stats.queued += res.queued;
        stats.skipped += res.skipped;
        if (done || !last) break;
        cursor = { at: last.ingestedAt, id: last.id };
      }
    } catch {
      stats.errors++;
      await deps.store.scanRelease(c.connectionId, deps.workerId).catch(() => {});
    }
  }

  // ---- process
  if (!aborted()) {
    let inbound: Awaited<ReturnType<typeof deps.store.claimInbound>> = [];
    try {
      inbound = await deps.store.claimInbound(deps.workerId, deps.config.leaseSeconds, deps.config.maxPerTick);
    } catch {
      stats.errors++;
    }
    for (const row of inbound) {
      if (aborted()) break; // unprocessed rows are re-claimed after their lease
      const out = await processInbound(deps, row, deps.workerId);
      if (out.kind === "draft") {
        stats.drafts++;
        if (out.auto) stats.autoQueued++;
      } else if (out.kind === "skip") stats.processSkipped++;
      else if (out.kind === "retry") stats.retries++;
      else stats.errors++;
    }
  }

  log("tick", { ...stats });
  return { status: stats.errors > 0 ? (stats.drafts + stats.scanned > 0 ? "partial" : "error") : "ok", stats };
}
