// ============================================================
// PHASE SHOPEE-PERF-1: the sync worker (channel-agnostic).
//
// runOne():   claim ONE job → run ONE bounded slice → re-queue / finish /
//             retry / fail. Never processes the whole queue in one call.
// runBurst(): recover stale jobs, then runOne() repeatedly until the
//             invocation's time budget is spent or nothing is claimable.
//
// Per job: one channel_sync_logs summary row (created on the first slice,
// finished when the job ends) and the channel_sync_states checkpoint
// (last_success_at advanced only on a clean incremental/full run).
// Shops are isolated: a failing job only affects itself; the claim never
// runs two jobs of the same shop + sync type, and at most
// config.globalWorkers jobs run at once across all shops.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { ExecutionBudget, type JobFailure } from "./retry-policy.ts";
import type { SyncConfig } from "./sync-config.ts";
import { claimNextSyncJob, JobLease, LeaseLostError, recoverStaleSyncJobs, RUNNABLE_SYNC_TYPES, type SyncJobRow } from "./sync-jobs.ts";
import { finishSyncLog, saveSyncState, startSyncLog } from "./sync-log.ts";
import { JobProgress } from "./sync-progress.ts";
import type { ContinuationReason, RemainingWork, SliceOutcome, SyncJobRunner } from "./sync-runner.ts";

export interface RunnerHandle {
  runner: SyncJobRunner;
  /** Live provider-call counters of this slice (ApiCallMeter). */
  meter: { calls: Record<string, number>; rateLimitHits: number };
}

export type RunnerFactory = (job: SyncJobRow, budget: ExecutionBudget) => RunnerHandle | Promise<RunnerHandle>;

export interface SliceReport {
  jobId: string;
  shopId: string;
  syncType: string;
  mode: string;
  /** Job status after this slice. */
  status: "pending" | "success" | "retry" | "failed" | "cancelled" | "lease_lost";
  logStatus?: string;
  apiCalls: number;
  durationMs: number;
  errorCode?: string;
  /** status "pending": why the slice stopped (SHOPEE-PERF-2). */
  continuationReason?: ContinuationReason;
  remainingWork?: RemainingWork;
}

export interface BurstReport {
  recovered: number;
  slices: SliceReport[];
  stoppedBy: "empty" | "time";
}

export type WorkerLogger = (event: Record<string, unknown>) => void;

const defaultLogger: WorkerLogger = (event) => console.info(JSON.stringify({ source: "sync-worker", ...event }));

export class SyncWorker {
  private readonly db: SupabaseClient;
  private readonly config: SyncConfig;
  private readonly workerId: string;
  private readonly createRunner: RunnerFactory;
  private readonly classifyError: (err: unknown) => JobFailure;
  private readonly now: () => Date;
  private readonly clock: () => number;
  private readonly random?: () => number;
  private readonly log: WorkerLogger;
  private readonly region: string;

  constructor(deps: {
    db: SupabaseClient;
    config: SyncConfig;
    workerId: string;
    createRunner: RunnerFactory;
    classifyError: (err: unknown) => JobFailure;
    now?: () => Date;
    clock?: () => number;
    random?: () => number;
    logger?: WorkerLogger;
    /** Where this worker runs (VERCEL_REGION) — tagged on every slice for the region benchmark. */
    region?: string;
  }) {
    this.region = deps.region ?? "local";
    this.db = deps.db;
    this.config = deps.config;
    this.workerId = deps.workerId;
    this.createRunner = deps.createRunner;
    this.classifyError = deps.classifyError;
    this.now = deps.now ?? (() => new Date());
    this.clock = deps.clock ?? Date.now;
    this.random = deps.random;
    this.log = deps.logger ?? defaultLogger;
  }

  async runBurst(options: { timeBudgetMs?: number } = {}): Promise<BurstReport> {
    const started = this.clock();
    const budgetMs = options.timeBudgetMs ?? this.config.workerTimeBudgetMs;
    const recovered = (await recoverStaleSyncJobs(this.db, this.config.staleJobMinutes)).length;
    const slices: SliceReport[] = [];
    for (;;) {
      const left = budgetMs - (this.clock() - started);
      // Start a slice only when a FULL slice budget still fits: a slice's last
      // step may run past its own deadline, and the platform kills the whole
      // invocation at maxDuration (60 s) — leave the rest to the next one.
      if (left < this.config.sliceTimeBudgetMs) return { recovered, slices, stoppedBy: "time" };
      const report = await this.runOne(left);
      if (!report) return { recovered, slices, stoppedBy: "empty" };
      slices.push(report);
    }
  }

  /** Claims one job and runs one slice of it. Null when nothing is claimable. */
  async runOne(timeLeftMs: number = this.config.sliceTimeBudgetMs): Promise<SliceReport | null> {
    const job = await claimNextSyncJob(this.db, this.workerId, {
      maxRunning: this.config.globalWorkers,
      syncTypes: RUNNABLE_SYNC_TYPES,
      shopIds: this.config.shopAllowlist,
    });
    if (!job) return null;
    const started = this.clock();
    const lease = new JobLease(this.db, job, this.workerId, this.now);
    const budget = new ExecutionBudget({ timeMs: Math.min(this.config.sliceTimeBudgetMs, timeLeftMs), maxApiCalls: this.config.maxSliceApiCalls, clock: this.clock });
    const progress = new JobProgress<unknown>(job, this.clock);
    progress.attachDbLatency(lease.dbLatency);
    progress.markRegion(this.region);
    const base = { jobId: job.id, shopId: job.shop_id, syncType: job.sync_type, mode: job.mode };
    const report = (status: SliceReport["status"], extra: Partial<SliceReport> = {}): SliceReport => {
      const r: SliceReport = { ...base, status, apiCalls: Object.values(progress.apiCalls()).reduce((a, b) => a + b, 0) - this.baseCalls(job), durationMs: this.clock() - started, ...extra };
      this.log({ event: "SYNC_JOB_SLICE", ...r, attempt: job.attempt_count });
      return r;
    };

    let outcome: SliceOutcome;
    try {
      if (!progress.meta.logId) {
        progress.meta.logId = await startSyncLog(this.db, job.shop_id, job.sync_type, this.now().toISOString(), { jobId: job.id, syncMode: job.mode }, job.id);
      }
      const handle = await this.createRunner(job, budget);
      progress.attachMeter(handle.meter);
      outcome = await handle.runner.runSlice({ job, lease, budget, progress, config: this.config, now: this.now });
    } catch (err) {
      if (err instanceof LeaseLostError) return report("lease_lost");
      const failure = this.classifyError(err);
      try {
        const status = await lease.fail(failure, progress.toPatch(), this.random);
        if (status === "failed") await this.closeJob(job, progress, "failed", { code: failure.code, message: failure.message }, null);
        return report(status, { errorCode: failure.code });
      } catch (writeErr) {
        if (writeErr instanceof LeaseLostError) return report("lease_lost");
        throw writeErr;
      }
    }

    try {
      if (outcome.kind === "more") {
        // Normal continuation: back to pending (due now), never success / retry / failed.
        progress.meta.continuationReason = outcome.reason ?? "batch_limit";
        progress.meta.remainingWork = outcome.remaining ?? null;
        await lease.continueLater(progress.toPatch());
        return report("pending", { continuationReason: outcome.reason ?? "batch_limit", remainingWork: outcome.remaining });
      }
      delete progress.meta.continuationReason;
      delete progress.meta.remainingWork;
      if (outcome.kind === "cancelled") {
        await lease.cancelled(progress.toPatch(), job.cancelled_by);
        await this.closeJob(job, progress, "cancelled", { code: "cancelled", message: "Đã hủy theo yêu cầu." }, null);
        return report("cancelled");
      }
      const error = outcome.errorCode ? { code: outcome.errorCode, message: outcome.errorMessage ?? "" } : null;
      if (outcome.logStatus === "failed") {
        // Deterministic failure (e.g. every window unreadable) — retrying the same input will not help.
        await lease.fail({ kind: "fatal", code: error?.code ?? "sync_failed", message: error?.message ?? "Đồng bộ thất bại." }, progress.toPatch());
        await this.closeJob(job, progress, "failed", error, outcome);
        return report("failed", { logStatus: "failed", errorCode: error?.code });
      }
      await lease.succeed(progress.toPatch());
      await this.closeJob(job, progress, outcome.logStatus, error, outcome);
      return report("success", { logStatus: outcome.logStatus });
    } catch (err) {
      if (err instanceof LeaseLostError) return report("lease_lost");
      throw err;
    }
  }

  private baseCalls(job: SyncJobRow): number {
    const calls = (job.metadata?.apiCalls as Record<string, number> | undefined) ?? {};
    return Object.values(calls).reduce((a, b) => a + b, 0);
  }

  /** Job ended: finish its log summary and update the shop's sync state. */
  private async closeJob(
    job: SyncJobRow,
    progress: JobProgress<unknown>,
    logStatus: "success" | "partial" | "failed" | "cancelled",
    error: { code: string; message: string } | null,
    outcome: Extract<SliceOutcome, { kind: "done" }> | null,
  ) {
    const completedIso = this.now().toISOString();
    const logId = progress.meta.logId as string | undefined;
    if (logId) {
      await finishSyncLog(this.db, logId, {
        status: logStatus,
        completedAt: completedIso,
        counts: progress.counters,
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null,
        metadata: { jobId: job.id, syncMode: job.mode, windowFrom: outcome?.windowFrom ?? job.window_from, windowTo: outcome?.windowTo ?? job.window_to, ...progress.summary() },
      });
    }
    if (logStatus === "cancelled") return;
    const advance = logStatus === "success" && outcome?.advanceCheckpoint === true && outcome.windowTo;
    await saveSyncState(this.db, job.shop_id, job.sync_type, {
      ...(outcome ? { last_window_from: outcome.windowFrom, last_window_to: outcome.windowTo } : {}),
      ...(advance ? { last_success_at: outcome!.windowTo, last_error_code: null, last_error_message: null } : {}),
      ...(logStatus !== "success" ? { last_failure_at: completedIso, last_error_code: error?.code ?? null, last_error_message: error?.message ?? null } : {}),
      metadata: { lastJobId: job.id, lastJobStatus: logStatus, lastJobFinishedAt: completedIso },
    });
  }
}
