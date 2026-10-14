// PHASE SHOPEE-PERF-1 — /api/internal/shopee/sync-worker
//
// Processes the sync queue for ONE bounded invocation: recover stale jobs,
// then claim + run job slices until the time budget is spent or nothing is
// claimable. Each slice checkpoints, so a timeout loses at most one page.
// Callers: Vercel Cron (Pro), Supabase pg_cron / an external cron (Hobby),
// the scheduler, and the worker's own chaining (?hop=n). Server-only auth:
// Authorization: Bearer $SYNC_WORKER_SECRET (or $CRON_SECRET).
import { after, NextResponse } from "next/server";

import { isAuthorizedInternalRequest } from "@/lib/cron/auth";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { chainShopeeSyncWorker, getShopeeSyncWorker } from "@/lib/channels/shopee/server";
import { hasDueSyncJobs } from "@/lib/channels/shopee/sync-service";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
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
    const report = await getShopeeSyncWorker().runBurst({ timeBudgetMs: config.workerTimeBudgetMs });
    const more = await hasDueSyncJobs(createAdminClient());
    // Chain one more invocation (≤ SHOPEE_SYNC_MAX_CHAIN_HOPS) only when THIS burst was cut by its time
    // budget. An "empty" stop with due jobs means they are blocked (global worker cap / the same shop
    // running elsewhere) — another hop would claim nothing.
    if (more && report.stoppedBy === "time" && hop < config.maxChainHops) after(() => chainShopeeSyncWorker(url.origin, hop + 1));
    return NextResponse.json({
      ok: true,
      hop,
      recovered: report.recovered,
      stoppedBy: report.stoppedBy,
      moreWork: more,
      slices: report.slices,
    });
  } catch (err) {
    console.error(JSON.stringify({ source: "sync-worker", event: "SYNC_WORKER_FAILED", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return NextResponse.json({ ok: false, error: "worker_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
