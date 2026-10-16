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
/** Latency samples kept per api (enough for a p50, small enough for jsonb on every checkpoint). */
export const MAX_LATENCY_SAMPLES = 40;

export type JobFailureRecord = { externalId: string | null; reason: string };
type StatValue = number | Record<string, number>;

/**
 * SHOPEE-PERF-2 region benchmark: wall-clock latency of one kind of call
 * (a Shopee api name, or "db_checkpoint" = one channel_sync_jobs write).
 */
export interface LatencyStats {
  n: number;
  totalMs: number;
  maxMs: number;
  /** First MAX_LATENCY_SAMPLES samples (for a median). */
  samples: number[];
}

export const emptyLatency = (): LatencyStats => ({ n: 0, totalMs: 0, maxMs: 0, samples: [] });

export function recordLatency(stats: LatencyStats, ms: number) {
  const v = Math.max(0, Math.round(ms));
  stats.n++;
  stats.totalMs += v;
  stats.maxMs = Math.max(stats.maxMs, v);
  if (stats.samples.length < MAX_LATENCY_SAMPLES) stats.samples.push(v);
}

function mergeLatency(a: LatencyStats | undefined, b: LatencyStats): LatencyStats {
  const base = a ?? emptyLatency();
  return {
    n: base.n + b.n,
    totalMs: base.totalMs + b.totalMs,
    maxMs: Math.max(base.maxMs, b.maxMs),
    samples: [...base.samples, ...b.samples].slice(0, MAX_LATENCY_SAMPLES),
  };
}

export function medianMs(stats: LatencyStats | undefined): number | null {
  if (!stats || stats.samples.length === 0) return null;
  const s = [...stats.samples].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

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
  private readonly baseLatency: Record<string, LatencyStats>;
  private liveApiCalls: () => { calls: Record<string, number>; rateLimitHits: number; latency?: Record<string, LatencyStats> } = () => ({ calls: {}, rateLimitHits: 0 });
  private liveDbLatency: LatencyStats | null = null;
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
    this.baseLatency = { ...((m.latencyMs as Record<string, LatencyStats> | undefined) ?? {}) };
    this.counters = { fetched: job.records_fetched, created: job.records_created, updated: job.records_updated, failed: job.records_failed };
    for (const key of ["checkpoint", "stats", "failures", "failedIds", "failedWithoutId", "apiCalls", "rateLimitHits", "durationMs", "latencyMs"]) delete m[key];
    m.slices = Number(m.slices ?? 0) + 1;
    this.meta = m;
  }

  /** Live provider counters of this slice (an ApiCallMeter). */
  attachMeter(meter: { calls: Record<string, number>; rateLimitHits: number; latency?: Record<string, LatencyStats> }) {
    this.liveApiCalls = () => ({ calls: meter.calls, rateLimitHits: meter.rateLimitHits, latency: meter.latency });
  }

  /** Live latency of this slice's job writes (JobLease) — the Supabase round-trip measure. */
  attachDbLatency(stats: LatencyStats) {
    this.liveDbLatency = stats;
  }

  /** Where this slice runs (VERCEL_REGION / "local"): slices per region. */
  markRegion(region: string) {
    const regions = { ...((this.meta.regions as Record<string, number> | undefined) ?? {}) };
    regions[region] = (regions[region] ?? 0) + 1;
    this.meta.regions = regions;
  }

  latency(): Record<string, LatencyStats> {
    const merged: Record<string, LatencyStats> = { ...this.baseLatency };
    for (const [k, v] of Object.entries(this.liveApiCalls().latency ?? {})) merged[k] = mergeLatency(merged[k], v);
    if (this.liveDbLatency && this.liveDbLatency.n > 0) merged.db_checkpoint = mergeLatency(merged.db_checkpoint, this.liveDbLatency);
    return merged;
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
        latencyMs: this.latency(),
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
