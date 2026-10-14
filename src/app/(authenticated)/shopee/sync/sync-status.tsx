// SHOPEE-PERF-1 reusable sync status display (server component). Reads only
// what getSyncStatuses() loaded from the database — never the provider.
import { Badge } from "@/components/ui/badge";
import type { SyncJobView, SyncStatusView } from "@/lib/channels/core/sync-status-queries";

import { fmtDate } from "../shared";

export const JOB_STATUS_LABELS: Record<string, string> = {
  pending: "Đang chờ",
  running: "Đang chạy",
  retry: "Chờ thử lại",
  success: "Thành công",
  failed: "Thất bại",
  cancelled: "Đã hủy",
};

export const JOB_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  running: "default",
  retry: "outline",
  success: "outline",
  failed: "destructive",
  cancelled: "secondary",
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
};

export function JobStatusBadge({ job }: { job: Pick<SyncJobView, "status" | "cancelRequested"> }) {
  return (
    <Badge variant={JOB_STATUS_VARIANT[job.status] ?? "secondary"}>
      {JOB_STATUS_LABELS[job.status] ?? job.status}
      {job.cancelRequested && job.status === "running" ? " · đang hủy" : ""}
    </Badge>
  );
}

/** One compact line for every reader of a data page: when each shop's data was last refreshed. */
export function FreshnessSummary({ shops, statuses, syncType }: { shops: Array<{ id: string; shopName: string }>; statuses: Map<string, SyncStatusView>; syncType: "order" | "product" }) {
  if (shops.length === 0) return null;
  return (
    <p className="text-sm text-muted-foreground">
      Dữ liệu cập nhật lần cuối:{" "}
      {shops.map((shop, i) => {
        const status = statuses.get(`${shop.id}|${syncType}`);
        const running = status?.activeJobs.some((j) => j.status === "running");
        return (
          <span key={shop.id}>
            {i > 0 ? " · " : ""}
            {shops.length > 1 ? `${shop.shopName}: ` : ""}
            <span className="font-medium text-foreground">{status?.lastSuccessAt ? fmtDate(status.lastSuccessAt) : "chưa có"}</span>
            {running ? " (đang đồng bộ)" : ""}
          </span>
        );
      })}
      . Dữ liệu không cập nhật theo thời gian thực.
    </p>
  );
}

/** "Dữ liệu cập nhật lần cuối" + the job in progress, for one shop + sync type. */
export function SyncFreshness({ status, canSeeErrors }: { status: SyncStatusView | undefined; canSeeErrors: boolean }) {
  if (!status) return null;
  const active = status.activeJobs.find((j) => j.status === "running") ?? status.activeJobs[0] ?? null;
  const latest = status.latestJob;
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>
        Dữ liệu cập nhật lần cuối: <span className="font-medium text-foreground">{status.lastSuccessAt ? fmtDate(status.lastSuccessAt) : "chưa có"}</span>
      </p>
      {active ? (
        <p className="flex flex-wrap items-center gap-2">
          <JobStatusBadge job={active} />
          <span>
            {SYNC_MODE_LABELS[active.mode] ?? active.mode}
            {active.status === "retry" && active.nextAttemptAt ? ` · thử lại lúc ${fmtDate(active.nextAttemptAt)}` : ""}
            {active.recordsFetched ? ` · đã quét ${active.recordsFetched}` : ""}
          </span>
        </p>
      ) : latest ? (
        <p className="flex flex-wrap items-center gap-2">
          Lần chạy gần nhất: <JobStatusBadge job={latest} /> {fmtDate(latest.finishedAt ?? latest.createdAt)}
          {latest.recordsFailed ? <span className="text-destructive">· {latest.recordsFailed} lỗi</span> : null}
        </p>
      ) : null}
      {status.lastErrorCode && status.lastFailureAt && (!status.lastSuccessAt || status.lastFailureAt > status.lastSuccessAt) && (
        <p className="text-destructive">
          Lỗi gần nhất ({fmtDate(status.lastFailureAt)}): {status.lastErrorCode}
          {canSeeErrors && status.lastErrorMessage ? ` — ${status.lastErrorMessage}` : ""}
        </p>
      )}
    </div>
  );
}
