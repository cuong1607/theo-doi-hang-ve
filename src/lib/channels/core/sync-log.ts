// ============================================================
// PHASE SHOPEE-2: channel_sync_states / channel_sync_logs helpers.
//
// One state row per (shop, sync_type) — the incremental checkpoint — and one
// log row per run. Metadata must never contain tokens/secrets: callers pass
// counts, ids and normalized error codes only.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SyncLogStatus } from "./types.ts";

export interface SyncStateRow {
  last_offset: number | null;
  last_window_from: string | null;
  last_window_to: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

export interface SyncCounts {
  fetched: number;
  created: number;
  updated: number;
  failed: number;
}

/** A run counts as "still running" only this long (crashed runs must not block forever). */
export const RUNNING_SYNC_STALE_MINUTES = 30;

export async function getSyncState(db: SupabaseClient, shopId: string, syncType: string): Promise<SyncStateRow | null> {
  const { data, error } = await db
    .from("channel_sync_states")
    .select("last_offset, last_window_from, last_window_to, last_success_at, last_failure_at, last_error_code, last_error_message")
    .eq("shop_id", shopId)
    .eq("sync_type", syncType)
    .maybeSingle<SyncStateRow>();
  if (error) throw new Error(`Không đọc được sync state: ${error.message}`);
  return data;
}

export async function saveSyncState(db: SupabaseClient, shopId: string, syncType: string, patch: Partial<SyncStateRow> & { metadata?: Record<string, unknown> }) {
  const { error } = await db.from("channel_sync_states").upsert({ shop_id: shopId, sync_type: syncType, ...patch }, { onConflict: "shop_id,sync_type" });
  if (error) throw new Error(`Không lưu được sync state: ${error.message}`);
}

export async function hasRunningSync(db: SupabaseClient, shopId: string, syncType: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - RUNNING_SYNC_STALE_MINUTES * 60_000).toISOString();
  const { count, error } = await db
    .from("channel_sync_logs")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("sync_type", syncType)
    .eq("status", "running")
    .gte("started_at", since);
  if (error) throw new Error(`Không đọc được sync log: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function startSyncLog(db: SupabaseClient, shopId: string, syncType: string, startedAt: string, metadata: Record<string, unknown>): Promise<string> {
  const { data, error } = await db
    .from("channel_sync_logs")
    .insert({ shop_id: shopId, sync_type: syncType, started_at: startedAt, status: "running", metadata })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Không tạo được sync log: ${error?.message ?? "unknown"}`);
  return data.id as string;
}

export async function finishSyncLog(
  db: SupabaseClient,
  logId: string,
  input: { status: Exclude<SyncLogStatus, "running">; completedAt: string; counts: SyncCounts; errorCode?: string | null; errorMessage?: string | null; metadata: Record<string, unknown> },
) {
  const { error } = await db
    .from("channel_sync_logs")
    .update({
      status: input.status,
      completed_at: input.completedAt,
      records_fetched: input.counts.fetched,
      records_created: input.counts.created,
      records_updated: input.counts.updated,
      records_failed: input.counts.failed,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      metadata: input.metadata,
    })
    .eq("id", logId);
  if (error) throw new Error(`Không cập nhật được sync log: ${error.message}`);
}
