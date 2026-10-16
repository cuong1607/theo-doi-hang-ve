// PHASE SHOPEE-PERF-1/2 — /api/internal/shopee/sync-worker
//
// Processes the sync queue for ONE bounded invocation: recover stale jobs,
// then claim + run job slices until the time budget is spent or nothing is
// claimable. Each slice checkpoints, so a timeout loses at most one page.
// Production drains the queue through the scheduler (pg_cron every minute
// → after() bursts); this endpoint is for operators (run the queue now),
// an external cron, and optional self-chaining (?hop=n, off by default).
// Auth: Bearer SHOPEE_SYNC_INTERNAL_SECRET / SYNC_WORKER_SECRET / CRON_SECRET.
import { after, NextResponse } from "next/server";

import { isAuthorizedInternalRequest } from "@/lib/cron/auth";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { chainShopeeSyncWorker, runShopeeWorkerBursts } from "@/lib/channels/shopee/server";
import { hasDueSyncJobs } from "@/lib/channels/shopee/sync-service";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// Worker budget (SHOPEE_SYNC_WORKER_BUDGET_MS, default 45 s) + margin.
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedInternalRequest(request.headers.get("authorization"), process.env)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const hop = Math.max(0, Number(url.searchParams.get("hop")) || 0);
  const config = getSyncConfig();

  try {
    const reports = await runShopeeWorkerBursts({ bursts: 1, timeBudgetMs: config.workerTimeBudgetMs, source: hop > 0 ? `chain:${hop}` : "worker" });
    const report = reports[0] ?? { recovered: 0, slices: [], stoppedBy: "empty" as const };
    const more = await hasDueSyncJobs(createAdminClient());
    // Optional chaining (SHOPEE_SYNC_MAX_CHAIN_HOPS > 0) only when THIS burst was cut by its time
    // budget. An "empty" stop with due jobs means they are blocked (global cap / same shop running).
    if (more && report.stoppedBy === "time" && hop < config.maxChainHops) after(() => chainShopeeSyncWorker(url.origin, hop + 1));
    return NextResponse.json({ ok: true, hop, recovered: report.recovered, stoppedBy: report.stoppedBy, moreWork: more, slices: report.slices });
  } catch (err) {
    console.error(JSON.stringify({ source: "sync-worker", event: "SYNC_WORKER_FAILED", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return NextResponse.json({ ok: false, error: "worker_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
