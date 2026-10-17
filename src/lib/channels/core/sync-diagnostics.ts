// ============================================================
// PHASE LOCAL-LIVE-1 §14: why is a pending / retry job not running?
//
// Pure: mirrors the eligibility rule of claim_next_sync_job (migration
// 00045) plus the scheduler / worker heartbeats, so the UI, the scheduler
// response and the dev tools can say WHICH condition holds a job back
// instead of a bare "pending". Checked in claim order; the first match wins.
//
//   invalid_job           sync type the worker cannot run / bad window
//   shop_inactive         claim joins shops.is_active
//   shop_not_allowed      SHOPEE_SYNC_SHOP_ALLOWLIST excludes the shop
//   max_attempts          attempt_count ≥ max_attempts (should have failed)
//   waiting_next_attempt  next_attempt_at in the future (retry backoff)
//   same_lane_running     a job of the same shop + type is running (its lock)
//   global_capacity       config.globalWorkers jobs already running
//   claim_failed          the worker's last run errored (claim RPC / DB)
//   scheduler_not_running scheduler heartbeat stale → nobody calls the worker
//   worker_not_running    scheduler ticks but no worker run recently
//   ready                 claimable now — the next worker run takes it
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SyncConfig } from "./sync-config.ts";
import { getHeartbeats, isHeartbeatStale, SCHEDULER_HEARTBEAT, WORKER_HEARTBEAT, type HeartbeatRow } from "./sync-heartbeat.ts";
import { RUNNABLE_SYNC_TYPES, type SyncJobRow } from "./sync-jobs.ts";

export type PendingReason =
  | "invalid_job"
  | "shop_inactive"
  | "shop_not_allowed"
  | "max_attempts"
  | "waiting_next_attempt"
  | "same_lane_running"
  | "global_capacity"
  | "claim_failed"
  | "scheduler_not_running"
  | "worker_not_running"
  | "ready";

export const PENDING_REASON_LABELS: Record<PendingReason, string> = {
  invalid_job: "Dữ liệu job không hợp lệ (loại đồng bộ / cửa sổ thời gian)",
  shop_inactive: "Shop đang tạm ngưng",
  shop_not_allowed: "Shop không nằm trong danh sách được đồng bộ (allowlist)",
  max_attempts: "Đã hết số lần thử",
  waiting_next_attempt: "Chờ đến lượt thử lại",
  same_lane_running: "Shop đang chạy một job cùng loại",
  global_capacity: "Đã đủ số job chạy đồng thời",
  claim_failed: "Worker lỗi ở lần chạy gần nhất",
  scheduler_not_running: "Scheduler không chạy — không ai gọi worker",
  worker_not_running: "Worker chưa chạy gần đây",
  ready: "Sẵn sàng — worker kế tiếp sẽ nhận",
};

export interface PendingDiagnosticsContext {
  now: Date;
  runnableTypes: readonly string[];
  /** null = every shop. */
  shopAllowlist: readonly string[] | null;
  activeShopIds: ReadonlySet<string>;
  /** `${shopId}|${syncType}` of RUNNING jobs. */
  runningLanes: ReadonlySet<string>;
  runningCount: number;
  maxRunning: number;
  scheduler: Pick<HeartbeatRow, "last_run_at"> | null;
  worker: Pick<HeartbeatRow, "last_run_at" | "last_success_at" | "last_error_at" | "last_error"> | null;
  /** Heartbeat older than this many minutes = not running (config.schedulerWarnAfterMinutes). */
  staleAfterMinutes: number;
}

export interface PendingDiagnosis {
  reason: PendingReason;
  label: string;
  /** Extra fact for the reason (e.g. the next attempt time, the worker error). */
  detail?: string;
}

type JobFields = Pick<SyncJobRow, "shop_id" | "sync_type" | "status" | "attempt_count" | "max_attempts" | "next_attempt_at" | "window_from" | "window_to">;

const diagnosis = (reason: PendingReason, detail?: string): PendingDiagnosis => ({ reason, label: PENDING_REASON_LABELS[reason], ...(detail ? { detail } : {}) });

/** Diagnosis for a pending / retry job; null for any other status. */
export function diagnosePendingJob(job: JobFields, ctx: PendingDiagnosticsContext): PendingDiagnosis | null {
  if (job.status !== "pending" && job.status !== "retry") return null;

  if (!ctx.runnableTypes.includes(job.sync_type)) return diagnosis("invalid_job", `sync_type=${job.sync_type}`);
  if (job.window_from && job.window_to && new Date(job.window_to) < new Date(job.window_from)) return diagnosis("invalid_job", "window_to < window_from");
  if (!ctx.activeShopIds.has(job.shop_id)) return diagnosis("shop_inactive");
  if (ctx.shopAllowlist && !ctx.shopAllowlist.includes(job.shop_id)) return diagnosis("shop_not_allowed");
  if (job.attempt_count >= job.max_attempts) return diagnosis("max_attempts", `${job.attempt_count}/${job.max_attempts}`);
  if (job.next_attempt_at && new Date(job.next_attempt_at) > ctx.now) return diagnosis("waiting_next_attempt", job.next_attempt_at);
  if (ctx.runningLanes.has(`${job.shop_id}|${job.sync_type}`)) return diagnosis("same_lane_running");
  if (ctx.runningCount >= Math.max(1, ctx.maxRunning)) return diagnosis("global_capacity", `${ctx.runningCount}/${ctx.maxRunning}`);

  const w = ctx.worker;
  if (w?.last_error_at && (!w.last_success_at || w.last_error_at > w.last_success_at)) return diagnosis("claim_failed", w.last_error ?? undefined);
  if (isHeartbeatStale(ctx.scheduler, ctx.now, ctx.staleAfterMinutes)) return diagnosis("scheduler_not_running");
  const workerSeen = w?.last_success_at ?? w?.last_run_at ?? null;
  if (isHeartbeatStale(workerSeen ? { last_run_at: workerSeen } : null, ctx.now, ctx.staleAfterMinutes)) return diagnosis("worker_not_running");
  return diagnosis("ready");
}

type DiagnosticsConfig = Pick<SyncConfig, "globalWorkers" | "shopAllowlist" | "schedulerWarnAfterMinutes">;

/**
 * Everything diagnosePendingJob needs, in 3 bounded queries (running jobs,
 * active shops, heartbeats) whatever the queue size.
 */
export async function loadPendingDiagnosticsContext(db: SupabaseClient, config: DiagnosticsConfig, now: Date = new Date()): Promise<PendingDiagnosticsContext> {
  const [running, shops, beats] = await Promise.all([
    db.from("channel_sync_jobs").select("shop_id, sync_type").eq("status", "running"),
    db.from("shops").select("id").eq("is_active", true),
    getHeartbeats(db, [SCHEDULER_HEARTBEAT, WORKER_HEARTBEAT]),
  ]);
  if (running.error) throw new Error(`Không đọc được job đang chạy: ${running.error.message}`);
  if (shops.error) throw new Error(`Không đọc được shop: ${shops.error.message}`);
  const runningRows = (running.data ?? []) as Array<{ shop_id: string; sync_type: string }>;
  return {
    now,
    runnableTypes: RUNNABLE_SYNC_TYPES,
    shopAllowlist: config.shopAllowlist,
    activeShopIds: new Set(((shops.data ?? []) as Array<{ id: string }>).map((s) => s.id)),
    runningLanes: new Set(runningRows.map((r) => `${r.shop_id}|${r.sync_type}`)),
    runningCount: runningRows.length,
    maxRunning: config.globalWorkers,
    scheduler: beats.get(SCHEDULER_HEARTBEAT) ?? null,
    worker: beats.get(WORKER_HEARTBEAT) ?? null,
    staleAfterMinutes: config.schedulerWarnAfterMinutes,
  };
}

export interface QueueDiagnosis extends PendingDiagnosis {
  jobId: string;
  shopId: string;
  syncType: string;
  mode: string;
  status: string;
}

/** Diagnoses the pending / retry jobs (first 100 by priority) — scheduler response, dev tools. */
export async function diagnosePendingQueue(db: SupabaseClient, config: DiagnosticsConfig, now: Date = new Date()): Promise<QueueDiagnosis[]> {
  const [ctx, jobs] = await Promise.all([
    loadPendingDiagnosticsContext(db, config, now),
    db
      .from("channel_sync_jobs")
      .select("id, shop_id, sync_type, mode, status, attempt_count, max_attempts, next_attempt_at, window_from, window_to")
      .in("status", ["pending", "retry"])
      .order("priority")
      .limit(100),
  ]);
  if (jobs.error) throw new Error(`Không đọc được hàng đợi: ${jobs.error.message}`);
  return ((jobs.data ?? []) as Array<JobFields & { id: string; mode: string }>).map((j) => ({
    jobId: j.id,
    shopId: j.shop_id,
    syncType: j.sync_type,
    mode: j.mode,
    status: j.status,
    ...diagnosePendingJob(j, ctx)!,
  }));
}
