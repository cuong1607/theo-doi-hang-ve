// ============================================================
// PHASE SHOPEE-PERF-1: contract between the worker and a sync-type runner.
//
// A runner executes ONE bounded slice of a job: it resumes from the job's
// checkpoint, checks the budget before every provider page / detail batch,
// persists progress through the lease after every step, and returns:
//   more       budget used up, work remains (worker re-queues the job)
//   done       nothing left — the worker writes the log + sync state
//   cancelled  an admin asked to cancel (seen at a checkpoint)
// A thrown error is job-level: the worker retries (retryable) or fails it.
// ============================================================
import type { SyncConfig } from "./sync-config.ts";
import type { JobLease, SyncJobRow } from "./sync-jobs.ts";
import type { JobProgress } from "./sync-progress.ts";
import type { ExecutionBudget } from "./retry-policy.ts";

export interface SliceInput<C = unknown> {
  job: SyncJobRow;
  lease: JobLease;
  budget: ExecutionBudget;
  progress: JobProgress<C>;
  config: SyncConfig;
  now: () => Date;
}

export type SliceOutcome =
  | { kind: "more" }
  | { kind: "cancelled" }
  | {
      kind: "done";
      logStatus: "success" | "partial" | "failed";
      /** Advance channel_sync_states.last_success_at to windowTo. */
      advanceCheckpoint: boolean;
      windowFrom: string | null;
      windowTo: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    };

export interface SyncJobRunner {
  runSlice(input: SliceInput): Promise<SliceOutcome>;
}

/** First record failure as the log's error (or a fatal one). */
export function firstFailureSummary(failures: Array<{ reason: string }>, failureCount: number): { code: string; message: string } | null {
  if (failureCount === 0 || failures.length === 0) return null;
  return { code: "partial_failure", message: `${failureCount} lỗi; đầu tiên: ${failures[0].reason}`.slice(0, 500) };
}
