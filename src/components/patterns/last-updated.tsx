// UIUX-1 LastUpdated: "Cập nhật lần cuối: 16/10/2026 08:32" — or
// "Đang cập nhật…" while a sync runs, plus a warning chip when the
// scheduler looks stopped. Time = last SUCCESSFUL sync (never "now").
import { AlertTriangle, Clock, Loader2 } from "lucide-react";

import { formatDateTime } from "@/lib/ui/format";

export function LastUpdated({
  subject,
  at,
  syncing = false,
  stale = false,
}: {
  /** "Đơn hàng", "Sản phẩm", "Tài chính" … (omit for the generic wording). */
  subject?: string;
  at: string | null;
  syncing?: boolean;
  /** Scheduler not running → the time will not move on its own. */
  stale?: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      {syncing ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-info" /> : <Clock aria-hidden="true" className="size-3.5" />}
      <span>
        {subject ? `${subject} cập nhật lần cuối: ` : "Cập nhật lần cuối: "}
        <span className="font-medium text-foreground tabular-nums">{at ? formatDateTime(at) : "chưa có"}</span>
        {syncing && <span className="text-info-text"> · Đang cập nhật…</span>}
      </span>
      {stale && (
        <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning-soft px-1.5 text-xs text-warning-text">
          <AlertTriangle aria-hidden="true" className="size-3" /> lịch tự động đang dừng
        </span>
      )}
    </span>
  );
}
