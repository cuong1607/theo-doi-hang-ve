// Sync status display (server components). Reads only what
// getSyncStatuses() / getSyncHealth() loaded from the database — never the
// provider. UIUX-1: one StatusBadge per state, honest progress
// (SyncProgress), job age, last success / last error.
import { Callout } from "@/components/patterns/callout";
import { LastUpdated } from "@/components/patterns/last-updated";
import { StatusBadge } from "@/components/patterns/status-badge";
import { SyncProgress } from "@/components/patterns/sync-progress";
import { FRESHNESS_SUBJECT, SYNC_DISPLAY_LABELS, syncDisplayState } from "@/lib/channels/core/sync-display";
import type { SyncHealthView, SyncJobView, SyncStatusView } from "@/lib/channels/core/sync-status-queries";
import { formatAge, formatDateTime } from "@/lib/ui/format";
import { JOB_STATUS_TONE, SYNC_STATE_TONE, toneOf } from "@/lib/ui/status";

export const JOB_STATUS_LABELS: Record<string, string> = {
  pending: "Đang chờ",
  running: "Đang chạy",
  retry: "Chờ thử lại",
  success: "Thành công",
  failed: "Thất bại",
  cancelled: "Đã hủy",
};

export const SYNC_MODE_LABELS: Record<string, string> = {
  incremental: "Tự động",
  manual: "Thủ công",
  backfill: "Backfill",
  repair: "Sửa lỗi",
};

export const SYNC_TYPE_LABELS: Record<string, string> = {
  order: "Đơn hàng",
  product: "Sản phẩm",
  escrow: "Tài chính",
  return: "Trả hàng",
};

const PROGRESS_UNIT: Record<string, string> = { order: "đơn", product: "sản phẩm", escrow: "đơn", return: "yêu cầu" };

export function JobStatusBadge({ job }: { job: Pick<SyncJobView, "status" | "cancelRequested"> }) {
  return (
    <StatusBadge tone={toneOf(JOB_STATUS_TONE, job.status)} spinning={job.status === "running"}>
      {JOB_STATUS_LABELS[job.status] ?? job.status}
      {job.cancelRequested && job.status === "running" ? " · đang hủy" : ""}
    </StatusBadge>
  );
}

/** Any job of these statuses is in flight (drives AutoRefresh). */
export function hasActiveSync(statuses: Map<string, SyncStatusView>): boolean {
  for (const s of statuses.values()) if (s.activeJobs.some((j) => j.status === "running" || (j.status === "pending" && j.startedAt))) return true;
  return false;
}

/**
 * Data pages: "Đơn hàng cập nhật lần cuối: …" per shop (last SUCCESSFUL
 * sync, never "now"), "Đang cập nhật…" while a job runs, a warning chip
 * when the scheduler looks stopped.
 */
export function FreshnessSummary({
  shops,
  statuses,
  syncType,
  schedulerStale = false,
}: {
  shops: Array<{ id: string; shopName: string }>;
  statuses: Map<string, SyncStatusView>;
  syncType: "order" | "product" | "escrow" | "return";
  schedulerStale?: boolean;
}) {
  if (shops.length === 0) return null;
  return (
    <>
      {shops.map((shop) => {
        const status = statuses.get(`${shop.id}|${syncType}`);
        const state = status ? syncDisplayState(status) : "never";
        const subject = shops.length > 1 ? `${FRESHNESS_SUBJECT[syncType]} (${shop.shopName})` : FRESHNESS_SUBJECT[syncType];
        return <LastUpdated key={shop.id} subject={subject} at={status?.lastSuccessAt ?? null} syncing={state === "syncing"} stale={schedulerStale} />;
      })}
    </>
  );
}

/** Progress of the job a cell shows, in the words of its sync type. */
function JobProgressLine({ syncType, job, active }: { syncType: string; job: SyncJobView; active: boolean }) {
  if (syncType === "escrow") {
    if (job.eligible === null && job.processed === 0) return null;
    return <SyncProgress processed={job.processed} total={job.eligible} label={PROGRESS_UNIT.escrow} active={active} />;
  }
  if (!active) return null;
  // Order / product discovery cannot know its total: indeterminate + count.
  return <SyncProgress processed={job.recordsFetched} total={null} label={PROGRESS_UNIT[syncType]} active />;
}

/**
 * One cell of the sync matrix: state badge, progress + job age while
 * running, last success, last run, last error (details for admins only).
 */
export function SyncStatusCell({ status, canSeeErrors, now = new Date(), action }: { status: SyncStatusView | undefined; canSeeErrors: boolean; now?: Date; action?: React.ReactNode }) {
  if (!status) return null;
  const state = syncDisplayState(status);
  const active = status.activeJobs.find((j) => j.status === "running") ?? status.activeJobs.find((j) => j.status === "pending" && j.startedAt) ?? status.activeJobs[0] ?? null;
  const latest = status.latestJob;
  const running = state === "syncing";
  const showError = status.lastErrorCode && status.lastFailureAt && (!status.lastSuccessAt || status.lastFailureAt > status.lastSuccessAt);
  return (
    <div className="min-w-48 space-y-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge tone={SYNC_STATE_TONE[state]} spinning={running}>
          {SYNC_DISPLAY_LABELS[state]}
        </StatusBadge>
        {active && <span className="text-xs text-muted-foreground">{SYNC_MODE_LABELS[active.mode] ?? active.mode}</span>}
      </div>
      {active && (
        <div className="space-y-1">
          <JobProgressLine syncType={status.syncType} job={active} active={running} />
          <p className="text-xs text-muted-foreground">
            {active.startedAt ? `Đã chạy ${formatAge(active.startedAt, now)}` : `Xếp hàng ${formatAge(active.createdAt, now)}`}
            {active.slices > 0 ? ` · ${active.slices} lượt` : ""}
            {active.status === "retry" && active.nextAttemptAt ? ` · thử lại lúc ${formatDateTime(active.nextAttemptAt)}` : ""}
          </p>
        </div>
      )}
      {!active && latest && status.syncType === "escrow" && <JobProgressLine syncType="escrow" job={latest} active={false} />}
      <p className="text-xs text-muted-foreground">
        Thành công gần nhất: <span className="font-medium text-foreground tabular-nums">{status.lastSuccessAt ? formatDateTime(status.lastSuccessAt) : "chưa có"}</span>
      </p>
      {latest && !active && (
        <p className="text-xs text-muted-foreground">
          Lần chạy gần nhất: {formatDateTime(latest.finishedAt ?? latest.startedAt ?? latest.createdAt)} · {JOB_STATUS_LABELS[latest.status] ?? latest.status}
          {latest.recordsFailed ? <span className="text-warning-text"> · {latest.recordsFailed} bản ghi lỗi</span> : null}
        </p>
      )}
      {showError && (
        <p className="text-xs text-danger-text">
          Lỗi gần nhất ({formatDateTime(status.lastFailureAt)}): {status.lastErrorCode}
          {canSeeErrors && status.lastErrorMessage ? <span className="block break-words text-muted-foreground">{status.lastErrorMessage}</span> : null}
        </p>
      )}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

/**
 * Admin warning when the cron stopped: without the scheduler nothing syncs
 * and the queue silently stands still.
 */
export function SchedulerWarning({ health }: { health: SyncHealthView }) {
  if (!health.schedulerStale) return null;
  const last = health.scheduler?.last_run_at;
  return (
    <Callout tone="warning" title="Scheduler đồng bộ Shopee có thể đang không hoạt động.">
      {last ? `Lần chạy gần nhất ${formatDateTime(last)}` : "Chưa từng chạy"} (ngưỡng {health.warnAfterMinutes} phút). Dữ liệu sẽ không tự cập nhật cho tới khi lịch chạy
      (pg_cron) hoạt động lại — xem docs/shopee-sync-operations.md mục 10.
    </Callout>
  );
}
