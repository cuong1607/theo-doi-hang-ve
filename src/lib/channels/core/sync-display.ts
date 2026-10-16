// ============================================================
// PHASE SHOPEE-PERF-2: one operational state per shop + sync type (pure).
//
// What the sync matrix shows, derived from the durable state
// (channel_sync_states.last_success_at) and the jobs:
//   syncing     a job is running, or is between slices (pending, started)
//   retrying    a job waits for its backoff
//   queued      a job waits for its first slice
//   synced      the last job succeeded (or nothing ran since a success)
//   failed      the last job failed
//   never       nothing has succeeded and nothing is queued
// ============================================================

export type SyncDisplayState = "never" | "queued" | "syncing" | "retrying" | "synced" | "failed";

export const SYNC_DISPLAY_LABELS: Record<SyncDisplayState, string> = {
  never: "Chưa đồng bộ",
  queued: "Đang chờ",
  syncing: "Đang đồng bộ",
  retrying: "Đang thử lại",
  synced: "Đã đồng bộ",
  failed: "Đồng bộ thất bại",
};

interface JobLike {
  status: string;
  startedAt: string | null;
}

export function syncDisplayState(input: { lastSuccessAt: string | null; latestJob: JobLike | null; activeJobs: readonly JobLike[] }): SyncDisplayState {
  const active = input.activeJobs;
  if (active.some((j) => j.status === "running")) return "syncing";
  if (active.some((j) => j.status === "pending" && j.startedAt)) return "syncing";
  if (active.some((j) => j.status === "retry")) return "retrying";
  if (active.some((j) => j.status === "pending")) return "queued";
  const latest = input.latestJob;
  if (latest?.status === "failed") return "failed";
  if (latest?.status === "success" || input.lastSuccessAt) return "synced";
  return "never";
}

/** "Đơn hàng được cập nhật gần nhất lúc …" — per data page. */
export const FRESHNESS_SUBJECT: Record<string, string> = {
  order: "Đơn hàng",
  product: "Sản phẩm",
  escrow: "Tài chính",
};
