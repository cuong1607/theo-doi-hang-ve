// ============================================================
// PHASE SHOPEE-PERF-1: read queries for sync status UI (server-only,
// service-role — callers authorize with channel:view first).
//
// Bounded, fixed number of queries whatever the shop count (no N+1):
//   states         channel_sync_states for the shops
//   latest jobs    v_channel_sync_latest_jobs (DISTINCT ON shop, type)
//   active jobs    pending / running / retry (≤ 2 per shop + type by index)
// Error messages are returned; the page decides who may see them.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { getSyncConfig } from "./sync-config.ts";
import { diagnosePendingJob, loadPendingDiagnosticsContext, type PendingDiagnosis, type PendingDiagnosticsContext } from "./sync-diagnostics.ts";
import { getHeartbeats, isHeartbeatStale, SCHEDULER_HEARTBEAT, WORKER_HEARTBEAT, type HeartbeatRow } from "./sync-heartbeat.ts";
import type { SyncJobRow, SyncJobStatus } from "./sync-jobs.ts";

export interface SyncJobView {
  id: string;
  shopId: string;
  syncType: string;
  mode: string;
  status: SyncJobStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  windowFrom: string | null;
  windowTo: string | null;
  recordsFetched: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsFailed: number;
  errorCode: string | null;
  errorMessage: string | null;
  cancelRequested: boolean;
  apiCalls: number;
  apiCallsByName: Record<string, number>;
  detailsFetched: number;
  detailsSkippedUnchanged: number;
  rateLimitHits: number;
  slices: number;
  durationMs: number;
  /** SHOPEE-PERF-2 progress: list pages read, escrow eligible / processed / remaining. */
  pages: number;
  eligible: number | null;
  processed: number;
  remaining: number | null;
  /** Set while the job is between slices (normal continuation). */
  continuationReason: string | null;
}

export interface SyncStatusView {
  shopId: string;
  syncType: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  latestJob: SyncJobView | null;
  activeJobs: SyncJobView[];
}

const JOB_COLUMNS =
  "id, shop_id, sync_type, mode, status, priority, attempt_count, max_attempts, next_attempt_at, started_at, finished_at, created_at, " +
  "window_from, window_to, records_fetched, records_created, records_updated, records_failed, error_code, error_message, cancel_requested, metadata";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function toJobView(r: Pick<SyncJobRow, "id" | "shop_id" | "sync_type" | "mode" | "status" | "priority" | "attempt_count" | "max_attempts" | "next_attempt_at" | "started_at" | "finished_at" | "created_at" | "window_from" | "window_to" | "records_fetched" | "records_created" | "records_updated" | "records_failed" | "error_code" | "error_message" | "cancel_requested" | "metadata">): SyncJobView {
  const m = r.metadata ?? {};
  const calls = (m.apiCalls as Record<string, number> | undefined) ?? {};
  const stats = (m.stats as Record<string, unknown> | undefined) ?? {};
  return {
    id: r.id,
    shopId: r.shop_id,
    syncType: r.sync_type,
    mode: r.mode,
    status: r.status,
    priority: r.priority,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
    windowFrom: r.window_from,
    windowTo: r.window_to,
    recordsFetched: r.records_fetched,
    recordsCreated: r.records_created,
    recordsUpdated: r.records_updated,
    recordsFailed: r.records_failed,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    cancelRequested: r.cancel_requested,
    apiCalls: Object.values(calls).reduce((a, b) => a + num(b), 0),
    apiCallsByName: calls,
    detailsFetched: num(stats.detailsFetched),
    detailsSkippedUnchanged: num(stats.detailsSkippedUnchanged),
    rateLimitHits: num(m.rateLimitHits),
    slices: num(m.slices),
    durationMs: num(m.durationMs),
    pages: num(stats.pages),
    eligible: typeof stats.eligible === "number" ? stats.eligible : null,
    processed: num(stats.ordersChecked),
    remaining: typeof stats.remaining === "number" ? stats.remaining : null,
    continuationReason: typeof m.continuationReason === "string" ? m.continuationReason : null,
  };
}

export interface SyncHealthView {
  scheduler: HeartbeatRow | null;
  worker: HeartbeatRow | null;
  /** Scheduler never ran / last run older than config.schedulerWarnAfterMinutes. */
  schedulerStale: boolean;
  warnAfterMinutes: number;
}

/** Scheduler / worker heartbeat for the "cron stopped?" warning (one query). */
export async function getSyncHealth(now: Date = new Date()): Promise<SyncHealthView> {
  const { schedulerWarnAfterMinutes } = getSyncConfig();
  const beats = await getHeartbeats(createAdminClient());
  const scheduler = beats.get(SCHEDULER_HEARTBEAT) ?? null;
  return {
    scheduler,
    worker: beats.get(WORKER_HEARTBEAT) ?? null,
    schedulerStale: isHeartbeatStale(scheduler, now, schedulerWarnAfterMinutes),
    warnAfterMinutes: schedulerWarnAfterMinutes,
  };
}

export async function getSyncStatuses(shopIds: string[], syncTypes: readonly string[] = ["order", "product", "escrow", "return"]): Promise<Map<string, SyncStatusView>> {
  const result = new Map<string, SyncStatusView>();
  if (shopIds.length === 0) return result;
  const db = createAdminClient();
  const [states, latest, active] = await Promise.all([
    db.from("channel_sync_states").select("shop_id, sync_type, last_success_at, last_failure_at, last_error_code, last_error_message").in("shop_id", shopIds).in("sync_type", [...syncTypes]),
    db.from("v_channel_sync_latest_jobs").select(JOB_COLUMNS).in("shop_id", shopIds).in("sync_type", [...syncTypes]),
    db.from("channel_sync_jobs").select(JOB_COLUMNS).in("shop_id", shopIds).in("sync_type", [...syncTypes]).in("status", ["pending", "running", "retry"]).order("priority"),
  ]);
  for (const r of [states, latest, active]) if (r.error) throw new Error(r.error.message);

  for (const shopId of shopIds) {
    for (const syncType of syncTypes) {
      result.set(`${shopId}|${syncType}`, { shopId, syncType, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null, lastErrorMessage: null, latestJob: null, activeJobs: [] });
    }
  }
  for (const s of (states.data ?? []) as Array<{ shop_id: string; sync_type: string; last_success_at: string | null; last_failure_at: string | null; last_error_code: string | null; last_error_message: string | null }>) {
    const v = result.get(`${s.shop_id}|${s.sync_type}`);
    if (!v) continue;
    v.lastSuccessAt = s.last_success_at;
    v.lastFailureAt = s.last_failure_at;
    v.lastErrorCode = s.last_error_code;
    v.lastErrorMessage = s.last_error_message;
  }
  for (const j of (latest.data ?? []) as unknown as SyncJobRow[]) {
    const v = result.get(`${j.shop_id}|${j.sync_type}`);
    if (v) v.latestJob = toJobView(j);
  }
  for (const j of (active.data ?? []) as unknown as SyncJobRow[]) {
    result.get(`${j.shop_id}|${j.sync_type}`)?.activeJobs.push(toJobView(j));
  }
  return result;
}

export async function listRecentSyncJobs(filters: { shopId?: string; status?: string } = {}, limit = 50): Promise<SyncJobView[]> {
  let query = createAdminClient().from("channel_sync_jobs").select(JOB_COLUMNS).order("created_at", { ascending: false }).limit(limit);
  if (filters.shopId) query = query.eq("shop_id", filters.shopId);
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as SyncJobRow[]).map(toJobView);
}

/** LOCAL-LIVE-1 §14: context for "why is this job still pending?" (3 bounded queries). */
export function getPendingDiagnosticsContext(now: Date = new Date()): Promise<PendingDiagnosticsContext> {
  return loadPendingDiagnosticsContext(createAdminClient(), getSyncConfig(), now);
}

/** Diagnosis of a job VIEW (camelCase) — null unless pending / retry. */
export function diagnoseJobView(job: SyncJobView, ctx: PendingDiagnosticsContext): PendingDiagnosis | null {
  return diagnosePendingJob(
    {
      shop_id: job.shopId,
      sync_type: job.syncType as SyncJobRow["sync_type"],
      status: job.status,
      attempt_count: job.attemptCount,
      max_attempts: job.maxAttempts,
      next_attempt_at: job.nextAttemptAt,
      window_from: job.windowFrom,
      window_to: job.windowTo,
    },
    ctx,
  );
}

/** Active queue size by status (all shops). */
export async function getQueueCounts(): Promise<Record<"pending" | "running" | "retry", number>> {
  const db = createAdminClient();
  const statuses = ["pending", "running", "retry"] as const;
  const counts = await Promise.all(statuses.map((s) => db.from("channel_sync_jobs").select("id", { count: "exact", head: true }).eq("status", s)));
  const out = { pending: 0, running: 0, retry: 0 };
  statuses.forEach((s, i) => {
    if (counts[i].error) throw new Error(counts[i].error!.message);
    out[s] = counts[i].count ?? 0;
  });
  return out;
}
