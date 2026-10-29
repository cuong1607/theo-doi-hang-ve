// PHASE SHOPEE-PERF-1/2 — /api/internal/shopee/sync-scheduler
//
// THE production entry point: Supabase pg_cron calls it every minute
// (migration 00050, docs/shopee-sync-operations.md §10). One tick:
//   1. authenticate (Bearer SHOPEE_SYNC_INTERNAL_SECRET / SYNC_WORKER_SECRET / CRON_SECRET)
//   2. heartbeat + recover stale running jobs
//   3. per active shop: enqueue the order / product / escrow job whose
//      interval passed (idempotent — one active job per shop + type)
//   4. prune old finished jobs, heartbeat success
//   4b. SHOPEE-ADS-2: Ads READ jobs due for each Ads-enabled shop (HOT 15 min,
//      WARM hourly, COLD 03:00/15:00, metadata 6 h; staggered per shop) —
//      only when SHOPEE_ADS_DATA_SOURCE=real AND ADS_AUTO_SYNC_ENABLED=true
//   5. respond, THEN run ≤ SHOPEE_SYNC_SCHEDULER_WORKER_TRIGGERS bounded worker
//      bursts in after() — each claims one job at a time, slices it within
//      the remaining budget and leaves what is left as "pending" for the next
//      minute's tick. That is how the queue drains with nobody clicking.
// The scheduler itself never syncs. Safe to run twice (at-least-once cron).
import { after, NextResponse } from "next/server";

import { isAuthorizedInternalRequest } from "@/lib/cron/auth";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { diagnosePendingQueue } from "@/lib/channels/core/sync-diagnostics";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { runShopeeWorkerBursts } from "@/lib/channels/shopee/server";
import { hasDueSyncJobs, runShopeeSchedulerTick } from "@/lib/channels/shopee/sync-service";
import { runReturnNotificationTickSafe } from "@/lib/return-operations/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopeeFlags } from "@/lib/feature-flags";
import { activeAdsSyncTypes, activeSyncTypes, retiredSyncTypes } from "@/lib/channels/core/sync-domains";
import { runAdsSchedulerTick, type AdsSchedulerTickResult } from "@/lib/channels/shopee/ads/schedule";
import { getAdsSyncConfig } from "@/lib/channels/shopee/ads/sync";
import { getShopee } from "@/lib/channels/shopee/server";
import { keepShopeeTokensAlive } from "@/lib/channels/shopee/token-keepalive";

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
    const db = createAdminClient();
    // SHOPEE-ADS-0: only active domains are scheduled; retired types are cancelled (history kept)
    const flags = getShopeeFlags();
    const tick = await runShopeeSchedulerTick(db, { config, providerMode: mode, syncTypes: activeSyncTypes(flags), retiredSyncTypes: retiredSyncTypes(flags) });
    console.info(
      JSON.stringify({
        source: "sync-scheduler",
        event: "scheduler_tick",
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
    for (const e of tick.enqueued) console.info(JSON.stringify({ source: "sync-scheduler", event: "job_enqueued", jobId: e.jobId, shopId: e.shopId, syncType: e.syncType }));
    // SHOPEE-ADS-2: Ads READ scheduling (never throws; one shop never blocks the others)
    const adsTypes = activeAdsSyncTypes(flags);
    const ads = adsTypes.length > 0 ? await runAdsTick(db) : null;
    // jobs due within the stagger jitter count: the burst waits for them (SyncWorker idleWaitMs)
    if (adsTypes.length > 0 && !tick.workDue) tick.workDue = await hasDueSyncJobs(db, new Date(Date.now() + (getAdsSyncConfig().jitterSeconds + 2) * 1000), adsTypes).catch(() => false);
    // SHOPEE-6B: scheduled "hàng hoàn đã giao" notifications (pre-sync + generate); never throws
    const notifications = flags.legacyModulesEnabled ? await runReturnNotificationTickSafe(db) : null;
    // keep shop tokens alive while nothing else calls Shopee (live mode only; never throws)
    const keepalive = mode === "live" ? await runTokenKeepalive(db) : null;
    if (notifications && notifications.presyncEnqueued > 0) tick.workDue = true;
    // §14: say WHY queued jobs are held back (logged only when something is blocked).
    const pending = await diagnosePendingQueue(db, config).catch(() => []);
    const blocked = pending.filter((p) => p.reason !== "ready" && p.reason !== "scheduler_not_running" && p.reason !== "worker_not_running");
    if (blocked.length > 0) {
      console.info(JSON.stringify({ source: "sync-scheduler", event: "pending_diagnostics", blocked: blocked.slice(0, 20).map((p) => ({ jobId: p.jobId, syncType: p.syncType, reason: p.reason, detail: p.detail })) }));
    }
    let workerTriggered = false;
    if (tick.workDue) {
      const timeBudgetMs = config.workerTimeBudgetMs - (Date.now() - started);
      if (timeBudgetMs >= config.sliceTimeBudgetMs) {
        workerTriggered = true;
        console.info(JSON.stringify({ source: "sync-scheduler", event: "worker_triggered", bursts: config.schedulerWorkerTriggers, timeBudgetMs }));
        after(() => runShopeeWorkerBursts({ bursts: config.schedulerWorkerTriggers, timeBudgetMs, source: "scheduler" }).then(() => undefined));
      }
    }
    return NextResponse.json({ ok: true, ...tick, workerTriggered, ads, returnNotifications: notifications, tokenKeepalive: keepalive, flags, pending: pending.map(({ jobId, syncType, status, reason, detail }) => ({ jobId, syncType, status, reason, detail })), configWarnings: config.warnings });
  } catch (err) {
    console.error(JSON.stringify({ source: "sync-scheduler", event: "SYNC_SCHEDULER_FAILED", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return NextResponse.json({ ok: false, error: "scheduler_failed" }, { status: 500 });
  }
}

async function runAdsTick(db: ReturnType<typeof createAdminClient>): Promise<AdsSchedulerTickResult | { error: string }> {
  try {
    const r = await runAdsSchedulerTick(db, { config: getAdsSyncConfig() });
    if (r.enqueued.length > 0 || r.errors.length > 0) {
      console.info(
        JSON.stringify({
          source: "sync-scheduler",
          event: "ads_scheduler_tick",
          shops: r.shops,
          slotsClaimed: r.slotsClaimed,
          enqueued: r.enqueued.map((e) => `${e.kind}:${e.syncType}${e.created ? "" : e.coalesced ? "(coalesced)" : "(queued)"}`),
          skippedShops: r.skippedShops,
          errors: r.errors,
          durationMs: r.durationMs,
        }),
      );
    }
    return r;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
    console.error(JSON.stringify({ source: "sync-scheduler", event: "ads_scheduler_failed", message }));
    return { error: message };
  }
}

async function runTokenKeepalive(db: ReturnType<typeof createAdminClient>) {
  try {
    const r = await keepShopeeTokensAlive(db, getShopee().service, { maxIdleHours: Number(process.env.SHOPEE_TOKEN_KEEPALIVE_HOURS) || 24 });
    if (r.refreshed.length > 0 || r.failed.length > 0) console.info(JSON.stringify({ source: "sync-scheduler", event: "token_keepalive", refreshed: r.refreshed.length, failed: r.failed }));
    return r;
  } catch (err) {
    console.error(JSON.stringify({ source: "sync-scheduler", event: "token_keepalive_failed", message: err instanceof Error ? err.message.slice(0, 200) : String(err) }));
    return null;
  }
}

export const GET = handle;
export const POST = handle;
