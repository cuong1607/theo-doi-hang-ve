// PHASE SHOPEE-PERF-1 — /api/internal/shopee/sync-scheduler
//
// Decides what is due — it never syncs itself:
//   1. recover stale running jobs
//   2. per active Shopee shop (matching data source, usable connection):
//      enqueue an incremental order / product job when its interval passed
//      (SHOPEE_SYNC_ORDER_INTERVAL_MINUTES / _PRODUCT_INTERVAL_MINUTES)
//   3. kick the worker in the background (after the response)
// Safe to run twice (at-least-once cron): enqueue is idempotent.
// Auth: Authorization: Bearer $SYNC_WORKER_SECRET (or $CRON_SECRET).
import { after, NextResponse } from "next/server";

import { isAuthorizedInternalRequest } from "@/lib/cron/auth";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { kickShopeeSyncWorker } from "@/lib/channels/shopee/server";
import { runShopeeSyncScheduler } from "@/lib/channels/shopee/sync-service";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedInternalRequest(request.headers.get("authorization"), process.env)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { mode, problem } = getShopeeProviderMode();
  if (problem) return NextResponse.json({ ok: false, error: "provider_mode_invalid", message: problem }, { status: 500 });
  const config = getSyncConfig();

  try {
    const result = await runShopeeSyncScheduler(createAdminClient(), { config, providerMode: mode });
    console.info(
      JSON.stringify({
        source: "sync-scheduler",
        event: "SYNC_SCHEDULER_RUN",
        recovered: result.recovered,
        enqueued: result.enqueued.length,
        alreadyQueued: result.alreadyQueued.length,
        notDue: result.notDue,
        skippedShops: result.skippedShops.length,
        configWarnings: config.warnings,
      }),
    );
    const origin = new URL(request.url).origin;
    if (result.enqueued.length + result.alreadyQueued.length > 0) after(() => kickShopeeSyncWorker({ origin }).then(() => undefined));
    return NextResponse.json({ ok: true, ...result, configWarnings: config.warnings });
  } catch (err) {
    console.error(JSON.stringify({ source: "sync-scheduler", event: "SYNC_SCHEDULER_FAILED", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return NextResponse.json({ ok: false, error: "scheduler_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
