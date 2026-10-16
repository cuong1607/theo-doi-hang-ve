// ============================================================
// PHASE SHOPEE-PERF-2: scheduler / worker health (channel_sync_heartbeats).
//
// One row per background component ("shopee_sync_scheduler",
// "shopee_sync_worker"): last run, last success, last error, a small
// summary of the last result. The scheduler marks its run FIRST, so a run
// that crashes half-way still shows up as "ran, never succeeded"; a cron
// that stopped shows up as an old last_run_at → the UI warns
// (isHeartbeatStale). Never secrets or payloads in last_result.
//
// Takes the DB client as a parameter (service-role on the server, injected
// in tests).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

export const SCHEDULER_HEARTBEAT = "shopee_sync_scheduler";
export const WORKER_HEARTBEAT = "shopee_sync_worker";

export interface HeartbeatRow {
  name: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  last_result: Record<string, unknown> | null;
}

async function upsert(db: SupabaseClient, row: Partial<HeartbeatRow> & { name: string }) {
  const { error } = await db.from("channel_sync_heartbeats").upsert(row, { onConflict: "name" });
  if (error) throw new Error(`Không ghi được heartbeat ${row.name}: ${error.message}`);
}

export function markHeartbeatRun(db: SupabaseClient, name: string, at: Date = new Date()) {
  return upsert(db, { name, last_run_at: at.toISOString() });
}

export function markHeartbeatSuccess(db: SupabaseClient, name: string, result: Record<string, unknown>, at: Date = new Date()) {
  return upsert(db, { name, last_success_at: at.toISOString(), last_result: result });
}

export function markHeartbeatError(db: SupabaseClient, name: string, message: string, at: Date = new Date()) {
  return upsert(db, { name, last_error_at: at.toISOString(), last_error: message.slice(0, 500) });
}

export async function getHeartbeats(db: SupabaseClient, names: readonly string[] = [SCHEDULER_HEARTBEAT, WORKER_HEARTBEAT]): Promise<Map<string, HeartbeatRow>> {
  const { data, error } = await db
    .from("channel_sync_heartbeats")
    .select("name, last_run_at, last_success_at, last_error_at, last_error, last_result")
    .in("name", [...names]);
  if (error) throw new Error(`Không đọc được heartbeat: ${error.message}`);
  return new Map(((data ?? []) as HeartbeatRow[]).map((r) => [r.name, r]));
}

/**
 * True when the component should have run by now but has not: never ran,
 * or its last run is older than `warnAfterMinutes` (≈ 3+ cron intervals).
 */
export function isHeartbeatStale(row: Pick<HeartbeatRow, "last_run_at"> | null | undefined, now: Date, warnAfterMinutes: number): boolean {
  if (!row?.last_run_at) return true;
  return now.getTime() - new Date(row.last_run_at).getTime() > warnAfterMinutes * 60_000;
}
