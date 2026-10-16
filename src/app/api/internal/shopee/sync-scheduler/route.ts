// PHASE SHOPEE-PERF-1/2 — /api/internal/shopee/sync-scheduler
//
// THE production entry point: Supabase pg_cron calls it every minute
// (migration 00050, docs/shopee-sync-operations.md §10). One tick:
//   1. authenticate (Bearer SHOPEE_SYNC_INTERNAL_SECRET / SYNC_WORKER_SECRET / CRON_SECRET)
//   2. heartbeat + recover stale running jobs
//   3. per active shop: enqueue the order / product / escrow job whose
//      interval passed (idempotent — one active job per shop + type)
//   4. prune old finished jobs, heartbeat success
//   5. respond, THEN run ≤ SHOPEE_SYNC_SCHEDULER_WORKER_TRIGGERS bounded worker
//      bursts in after() — each claims one job at a time, slices it within
//      the remaining budget and leaves what is left as "pending" for the next
//      minute's tick. That is how the queue drains with nobody clicking.
// The scheduler itself never syncs. Safe to run twice (at-least-once cron).
import { after, NextResponse } from "next/server";

import { isAuthorizedInternalRequest } from "@/lib/cron/auth";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { runShopeeWorkerBursts } from "@/lib/channels/shopee/server";
import { runShopeeSchedulerTick } from "@/lib/channels/shopee/sync-service";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// Tick (~1 s) + worker bursts (SHOPEE_SYNC_WORKER_BUDGET_MS, default 45 s) + margin.
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedInternalRequest(request.headers.get("authorization"), process.env)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const { mode, problem } = getShopeeProviderMode();
  if (problem) return NextResponse.json({ ok: false, error: "provider_mode_invalid", message: problem }, { status: 500 });
  const config = getSyncConfig();

  try {
    const tick = await runShopeeSchedulerTick(createAdminClient(), { config, providerMode: mode });
    console.info(
      JSON.stringify({
        source: "sync-scheduler",
        event: "SYNC_SCHEDULER_RUN",
        region: process.env.VERCEL_REGION ?? "local",
        recovered: tick.recovered,
        enqueued: tick.enqueued.map((e) => e.syncType),
        alreadyQueued: tick.alreadyQueued.length,
        notDue: tick.notDue,
        skippedShops: tick.skippedShops,
        pruned: tick.pruned,
        workDue: tick.workDue,
        durationMs: tick.durationMs,
        configWarnings: config.warnings,
      }),
    );
    if (tick.workDue) {
      const timeBudgetMs = config.workerTimeBudgetMs - (Date.now() - started);
      if (timeBudgetMs >= config.sliceTimeBudgetMs) {
        after(() => runShopeeWorkerBursts({ bursts: config.schedulerWorkerTriggers, timeBudgetMs, source: "scheduler" }).then(() => undefined));
      }
    }
    return NextResponse.json({ ok: true, ...tick, configWarnings: config.warnings });
  } catch (err) {
    console.error(JSON.stringify({ source: "sync-scheduler", event: "SYNC_SCHEDULER_FAILED", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return NextResponse.json({ ok: false, error: "scheduler_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
