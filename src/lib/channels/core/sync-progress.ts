// ============================================================
// PHASE SHOPEE-PERF-1: in-memory progress of one job, persisted into
// channel_sync_jobs (records_* columns + metadata) at every checkpoint.
//
// metadata layout (never secrets / payloads):
//   checkpoint   runner-specific resume point (cursor, offset, pending ids)
//   scope        bounded repair scope ({ orderSns } / { itemIds })
//   stats        counters (pages, detailsFetched, detailsSkippedUnchanged,
//                refreshReasons{}, …) — accumulated across slices
//   apiCalls     { get_order_list: n, get_order_detail: n, … }
//   rateLimitHits, slices, durationMs, logId, recoveries
//   failures     first MAX_FAILURES record-level failures (id + reason)
// ============================================================
import type { CheckpointPatch, JobCounters, SyncJobRow } from "./sync-jobs.ts";

export const MAX_FAILURES_KEPT = 50;
const MAX_FAILED_IDS_KEPT = 500;

export type JobFailureRecord = { externalId: string | null; reason: string };
type StatValue = number | Record<string, number>;

export class JobProgress<C> {
  checkpoint: C | null;
  readonly counters: JobCounters;
  readonly stats: Record<string, StatValue>;
  readonly failures: JobFailureRecord[];
  private failedIds: Set<string>;
  private failedWithoutId: number;
  private readonly baseApiCalls: Record<string, number>;
  private readonly baseRateLimitHits: number;
  private readonly baseDurationMs: number;
  private liveApiCalls: () => { calls: Record<string, number>; rateLimitHits: number } = () => ({ calls: {}, rateLimitHits: 0 });
  private readonly sliceStartedAt: number;
  private readonly clock: () => number;
  /** Untouched metadata keys (scope, logId, recoveries, …) carried over. */
  readonly meta: Record<string, unknown>;

  constructor(job: Pick<SyncJobRow, "metadata" | "records_fetched" | "records_created" | "records_updated" | "records_failed">, clock: () => number = Date.now) {
    const m = { ...(job.metadata ?? {}) } as Record<string, unknown>;
    this.clock = clock;
    this.sliceStartedAt = clock();
    this.checkpoint = (m.checkpoint as C | undefined) ?? null;
    this.stats = { ...((m.stats as Record<string, StatValue> | undefined) ?? {}) };
    this.failures = [...((m.failures as JobFailureRecord[] | undefined) ?? [])];
    this.failedIds = new Set((m.failedIds as string[] | undefined) ?? []);
    this.failedWithoutId = Number(m.failedWithoutId ?? 0);
    this.baseApiCalls = { ...((m.apiCalls as Record<string, number> | undefined) ?? {}) };
    this.baseRateLimitHits = Number(m.rateLimitHits ?? 0);
    this.baseDurationMs = Number(m.durationMs ?? 0);
    this.counters = { fetched: job.records_fetched, created: job.records_created, updated: job.records_updated, failed: job.records_failed };
    for (const key of ["checkpoint", "stats", "failures", "failedIds", "failedWithoutId", "apiCalls", "rateLimitHits", "durationMs"]) delete m[key];
    m.slices = Number(m.slices ?? 0) + 1;
    this.meta = m;
  }

  /** Live provider counters of this slice (an ApiCallMeter). */
  attachMeter(meter: { calls: Record<string, number>; rateLimitHits: number }) {
    this.liveApiCalls = () => ({ calls: meter.calls, rateLimitHits: meter.rateLimitHits });
  }

  incr(key: string, n = 1) {
    if (n === 0) return;
    this.stats[key] = (typeof this.stats[key] === "number" ? (this.stats[key] as number) : 0) + n;
  }

  incrIn(key: string, sub: string, n = 1) {
    if (n === 0) return;
    const map = typeof this.stats[key] === "object" ? (this.stats[key] as Record<string, number>) : {};
    map[sub] = (map[sub] ?? 0) + n;
    this.stats[key] = map;
  }

  stat(key: string): number {
    return typeof this.stats[key] === "number" ? (this.stats[key] as number) : 0;
  }

  addFailure(failure: JobFailureRecord) {
    if (this.failures.length < MAX_FAILURES_KEPT) this.failures.push(failure);
    if (failure.externalId) {
      if (this.failedIds.size < MAX_FAILED_IDS_KEPT) this.failedIds.add(failure.externalId);
      else if (!this.failedIds.has(failure.externalId)) this.failedWithoutId++;
    } else {
      this.failedWithoutId++;
    }
    this.counters.failed = this.failedIds.size + this.failedWithoutId;
  }

  get failureCount(): number {
    return this.failedIds.size + this.failedWithoutId;
  }

  apiCalls(): Record<string, number> {
    const merged = { ...this.baseApiCalls };
    for (const [k, v] of Object.entries(this.liveApiCalls().calls)) merged[k] = (merged[k] ?? 0) + v;
    return merged;
  }

  toPatch(extra: Omit<CheckpointPatch, "counters" | "metadata"> = {}): CheckpointPatch {
    return {
      ...extra,
      counters: { ...this.counters },
      metadata: {
        ...this.meta,
        checkpoint: this.checkpoint,
        stats: this.stats,
        failures: this.failures,
        failedIds: [...this.failedIds],
        failedWithoutId: this.failedWithoutId,
        apiCalls: this.apiCalls(),
        rateLimitHits: this.baseRateLimitHits + this.liveApiCalls().rateLimitHits,
        durationMs: this.baseDurationMs + (this.clock() - this.sliceStartedAt),
      },
    };
  }

  /** Summary metadata for the channel_sync_logs row (no checkpoint / id lists). */
  summary(): Record<string, unknown> {
    const summary = { ...this.toPatch().metadata! };
    for (const key of ["checkpoint", "failedIds", "failedWithoutId"]) delete summary[key];
    return summary;
  }
}
