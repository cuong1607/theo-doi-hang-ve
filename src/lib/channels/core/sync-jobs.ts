// ============================================================
// PHASE SHOPEE-PERF-1: channel_sync_jobs queue service (channel-agnostic).
//
//   enqueueSyncJob      idempotent (DB partial unique index + RPC)
//   claimNextSyncJob    atomic claim (RPC: advisory lock + SKIP LOCKED)
//   recoverStaleSyncJobs  running jobs with an expired lease → retry
//   JobLease            what a worker may do with the job it claimed:
//                       checkpoint (= heartbeat), continue, succeed, fail.
//                       Every write is guarded by lock_owner + status so a
//                       worker whose job was recovered can never overwrite it.
//
// Takes the DB client as a parameter (service-role on the server, injected
// in tests); no "server-only" marker so integration tests can drive it.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { decideFailure, type JobFailure } from "./retry-policy.ts";
import { emptyLatency, recordLatency, type LatencyStats } from "./sync-progress.ts";

export const SYNC_TYPES = ["product", "order", "escrow", "income", "return", "payout"] as const;
export type SyncType = (typeof SYNC_TYPES)[number];
/** Sync types the worker can run today (the others are reserved for SHOPEE-5+). */
export const RUNNABLE_SYNC_TYPES = ["product", "order", "escrow", "return", "income", "payout"] as const satisfies readonly SyncType[];
export type RunnableSyncType = (typeof RUNNABLE_SYNC_TYPES)[number];

export const SYNC_MODES = ["incremental", "backfill", "repair", "manual"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export type SyncJobStatus = "pending" | "running" | "retry" | "success" | "failed" | "cancelled";
export const ACTIVE_JOB_STATUSES: readonly SyncJobStatus[] = ["pending", "running", "retry"];

export interface SyncJobRow {
  id: string;
  shop_id: string;
  sync_type: SyncType;
  mode: SyncMode;
  status: SyncJobStatus;
  priority: number;
  window_from: string | null;
  window_to: string | null;
  cursor: string | null;
  offset_value: number | null;
  batch_size: number | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  locked_at: string | null;
  lock_owner: string | null;
  records_fetched: number;
  records_created: number;
  records_updated: number;
  records_failed: number;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  cancel_requested: boolean;
  cancelled_at: string | null;
  cancelled_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export class SyncJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SyncJobError";
    this.code = code;
  }
}

/** The worker's lease was taken away (recovered as stale / cancelled) — stop touching the job. */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Mất quyền xử lý job ${jobId} (đã bị thu hồi).`);
    this.name = "LeaseLostError";
  }
}

export interface EnqueueInput {
  shopId: string;
  syncType: SyncType;
  mode: SyncMode;
  priority: number;
  windowFrom?: Date | null;
  windowTo?: Date | null;
  metadata?: Record<string, unknown> | null;
  createdBy?: string | null;
  maxAttempts?: number;
}

export interface EnqueueResult {
  jobId: string;
  created: boolean;
  status: SyncJobStatus;
}

/**
 * Idempotent: an active job of the same shop + type + lane (backfill | live)
 * is returned instead of creating a duplicate. Validates the shop first.
 */
export async function enqueueSyncJob(db: SupabaseClient, input: EnqueueInput): Promise<EnqueueResult> {
  if (!SYNC_TYPES.includes(input.syncType)) throw new SyncJobError("bad_sync_type", "Loại đồng bộ không hợp lệ.");
  if (!SYNC_MODES.includes(input.mode)) throw new SyncJobError("bad_mode", "Chế độ đồng bộ không hợp lệ.");
  if (input.windowFrom && input.windowTo && input.windowTo < input.windowFrom) throw new SyncJobError("bad_range", "Khoảng thời gian không hợp lệ.");

  const { data: shop, error: shopError } = await db.from("shops").select("id, is_active").eq("id", input.shopId).maybeSingle<{ id: string; is_active: boolean }>();
  if (shopError) throw new Error(`Không đọc được shop: ${shopError.message}`);
  if (!shop) throw new SyncJobError("shop_not_found", "Không tìm thấy shop.");
  if (!shop.is_active) throw new SyncJobError("shop_inactive", "Shop đang tạm ngưng.");

  const { data, error } = await db
    .rpc("enqueue_sync_job", {
      p_shop_id: input.shopId,
      p_sync_type: input.syncType,
      p_mode: input.mode,
      p_priority: input.priority,
      p_window_from: input.windowFrom?.toISOString() ?? null,
      p_window_to: input.windowTo?.toISOString() ?? null,
      p_metadata: input.metadata ?? null,
      p_created_by: input.createdBy ?? null,
      p_max_attempts: input.maxAttempts ?? 3,
    })
    .single<{ job_id: string; created: boolean; status: SyncJobStatus }>();
  if (error || !data) throw new Error(`Không tạo được job đồng bộ: ${error?.message ?? "unknown"}`);
  return { jobId: data.job_id, created: data.created, status: data.status };
}

export async function claimNextSyncJob(
  db: SupabaseClient,
  workerId: string,
  options: { maxRunning: number; syncTypes?: readonly string[]; shopIds?: readonly string[] | null },
): Promise<SyncJobRow | null> {
  const { data, error } = await db.rpc("claim_next_sync_job", {
    p_worker_id: workerId,
    p_max_running: options.maxRunning,
    p_sync_types: options.syncTypes ? [...options.syncTypes] : null,
    p_shop_ids: options.shopIds ? [...options.shopIds] : null,
  });
  if (error) throw new Error(`Không nhận được job: ${error.message}`);
  const rows = (data ?? []) as SyncJobRow[];
  return rows[0] ?? null;
}

export async function recoverStaleSyncJobs(db: SupabaseClient, staleMinutes: number): Promise<Array<{ jobId: string; status: SyncJobStatus }>> {
  const { data, error } = await db.rpc("recover_stale_sync_jobs", { p_stale_seconds: staleMinutes * 60 });
  if (error) throw new Error(`Không thu hồi được job treo: ${error.message}`);
  return ((data ?? []) as Array<{ job_id: string; new_status: SyncJobStatus }>).map((r) => ({ jobId: r.job_id, status: r.new_status }));
}

export interface JobCounters {
  fetched: number;
  created: number;
  updated: number;
  failed: number;
}

export interface CheckpointPatch {
  cursor?: string | null;
  offsetValue?: number | null;
  windowFrom?: string | null;
  windowTo?: string | null;
  counters?: JobCounters;
  metadata?: Record<string, unknown>;
}

function patchColumns(patch: CheckpointPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.cursor !== undefined) row.cursor = patch.cursor;
  if (patch.offsetValue !== undefined) row.offset_value = patch.offsetValue;
  if (patch.windowFrom !== undefined) row.window_from = patch.windowFrom;
  if (patch.windowTo !== undefined) row.window_to = patch.windowTo;
  if (patch.counters) {
    row.records_fetched = patch.counters.fetched;
    row.records_created = patch.counters.created;
    row.records_updated = patch.counters.updated;
    row.records_failed = patch.counters.failed;
  }
  if (patch.metadata !== undefined) row.metadata = patch.metadata;
  return row;
}

/**
 * The claimed job, as seen by the worker that owns it. All writes require
 * status = running AND lock_owner = this worker.
 */
export class JobLease {
  readonly job: SyncJobRow;
  private readonly db: SupabaseClient;
  private readonly workerId: string;
  private readonly now: () => Date;

  constructor(db: SupabaseClient, job: SyncJobRow, workerId: string, now: () => Date = () => new Date()) {
    this.db = db;
    this.job = job;
    this.workerId = workerId;
    this.now = now;
  }

  /** SHOPEE-PERF-2: round-trip time of every job write (one Supabase request each). */
  readonly dbLatency: LatencyStats = emptyLatency();

  private async write(columns: Record<string, unknown>): Promise<{ cancel_requested: boolean }> {
    const started = Date.now();
    const { data, error } = await this.db
      .from("channel_sync_jobs")
      .update(columns)
      .eq("id", this.job.id)
      .eq("status", "running")
      .eq("lock_owner", this.workerId)
      .select("cancel_requested");
    recordLatency(this.dbLatency, Date.now() - started);
    if (error) throw new Error(`Không cập nhật được job: ${error.message}`);
    const row = (data ?? [])[0] as { cancel_requested: boolean } | undefined;
    if (!row) throw new LeaseLostError(this.job.id);
    return row;
  }

  /**
   * Persist progress (and renew the lease). Returns whether an admin asked
   * to cancel — the runner stops at this safe point.
   */
  async checkpoint(patch: CheckpointPatch): Promise<{ cancelRequested: boolean }> {
    const row = await this.write({ ...patchColumns(patch), locked_at: this.now().toISOString() });
    return { cancelRequested: row.cancel_requested };
  }

  /** Slice done, more work remains → back to pending (due now). Progress resets the attempt counter. */
  async continueLater(patch: CheckpointPatch) {
    await this.write({
      ...patchColumns(patch),
      status: "pending",
      attempt_count: 0,
      next_attempt_at: this.now().toISOString(),
      lock_owner: null,
      locked_at: null,
    });
  }

  async succeed(patch: CheckpointPatch) {
    const nowIso = this.now().toISOString();
    await this.write({ ...patchColumns(patch), status: "success", finished_at: nowIso, lock_owner: null, locked_at: null, next_attempt_at: null, error_code: null, error_message: null });
  }

  async cancelled(patch: CheckpointPatch, cancelledBy: string | null) {
    const nowIso = this.now().toISOString();
    await this.write({ ...patchColumns(patch), status: "cancelled", finished_at: nowIso, cancelled_at: nowIso, ...(cancelledBy ? { cancelled_by: cancelledBy } : {}), lock_owner: null, locked_at: null });
  }

  /** Retryable → retry with backoff (until max_attempts); fatal → failed. Returns the new status. */
  async fail(failure: JobFailure, patch: CheckpointPatch, random?: () => number): Promise<"retry" | "failed"> {
    const decision = decideFailure(failure, this.job.attempt_count, this.job.max_attempts, this.now(), random);
    await this.write({
      ...patchColumns(patch),
      status: decision.status,
      next_attempt_at: decision.nextAttemptAt?.toISOString() ?? null,
      finished_at: decision.status === "failed" ? this.now().toISOString() : null,
      error_code: failure.code.slice(0, 100),
      error_message: failure.message.slice(0, 500),
      lock_owner: null,
      locked_at: null,
    });
    return decision.status;
  }
}

/**
 * Pending / retry → cancelled immediately. Running → cancel_requested (the
 * worker stops at its next checkpoint). Finished jobs are left alone.
 */
export async function cancelSyncJob(db: SupabaseClient, jobId: string, userId: string | null): Promise<"cancelled" | "requested" | "not_active"> {
  const nowIso = new Date().toISOString();
  const { data: immediate, error } = await db
    .from("channel_sync_jobs")
    .update({ status: "cancelled", cancelled_at: nowIso, cancelled_by: userId, finished_at: nowIso, next_attempt_at: null })
    .eq("id", jobId)
    .in("status", ["pending", "retry"])
    .select("id");
  if (error) throw new Error(`Không hủy được job: ${error.message}`);
  if ((immediate ?? []).length > 0) {
    // A job paused between slices already has a "running" summary log.
    const { error: logError } = await db
      .from("channel_sync_logs")
      .update({ status: "cancelled", completed_at: nowIso, error_code: "cancelled", error_message: "Đã hủy theo yêu cầu." })
      .eq("job_id", jobId)
      .eq("status", "running");
    if (logError) throw new Error(`Không cập nhật được sync log: ${logError.message}`);
    return "cancelled";
  }
  const { data: running, error: runError } = await db
    .from("channel_sync_jobs")
    .update({ cancel_requested: true, cancelled_by: userId })
    .eq("id", jobId)
    .eq("status", "running")
    .select("id");
  if (runError) throw new Error(`Không hủy được job: ${runError.message}`);
  return (running ?? []).length > 0 ? "requested" : "not_active";
}

/**
 * Dead letter → "Thử lại": a failed / cancelled job is reset to pending with
 * its checkpoint kept (a backfill resumes where it stopped). Refused when
 * the same lane already has an active job.
 */
export async function retrySyncJob(db: SupabaseClient, jobId: string): Promise<"queued" | "lane_busy" | "not_retryable"> {
  const { data: current, error: readError } = await db.from("channel_sync_jobs").select("status, metadata").eq("id", jobId).maybeSingle<{ status: SyncJobStatus; metadata: Record<string, unknown> | null }>();
  if (readError) throw new Error(`Không đọc được job: ${readError.message}`);
  if (!current || (current.status !== "failed" && current.status !== "cancelled")) return "not_retryable";
  // The finished run keeps its own log row; the retried run gets a new one.
  const { logId: _previousLog, ...metadata } = current.metadata ?? {};
  const { data, error } = await db
    .from("channel_sync_jobs")
    .update({
      metadata: { ...metadata, retriedFromLogId: _previousLog ?? null },
      status: "pending",
      attempt_count: 0,
      next_attempt_at: null,
      finished_at: null,
      error_code: null,
      error_message: null,
      cancel_requested: false,
      cancelled_at: null,
      cancelled_by: null,
      lock_owner: null,
      locked_at: null,
    })
    .eq("id", jobId)
    .in("status", ["failed", "cancelled"])
    .select("id");
  if (error) {
    if (error.code === "23505") return "lane_busy";
    throw new Error(`Không thử lại được job: ${error.message}`);
  }
  return (data ?? []).length > 0 ? "queued" : "not_retryable";
}
