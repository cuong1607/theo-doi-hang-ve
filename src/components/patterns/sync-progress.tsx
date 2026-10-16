// UIUX-1 SyncProgress: honest progress. Known total → bar + "120 / 350";
// unknown total → indeterminate bar + processed count (no fake percent).
import { cn } from "cn";

import { progressPercent } from "@/lib/ui/progress";

export function SyncProgress({
  processed,
  total,
  label,
  active = true,
  className,
}: {
  processed: number;
  /** null / undefined when the job cannot know its total yet. */
  total?: number | null;
  /** e.g. "đơn", "sản phẩm" — shown after the count. */
  label?: string;
  /** false → static bar (finished / waiting), no animation. */
  active?: boolean;
  className?: string;
}) {
  const pct = progressPercent(processed, total);
  const unit = label ? ` ${label}` : "";
  const text = pct === null ? `${processed.toLocaleString("vi-VN")}${unit} đã xử lý` : `${processed.toLocaleString("vi-VN")} / ${total!.toLocaleString("vi-VN")}${unit}`;
  return (
    <div className={cn("w-full max-w-56 space-y-1", className)}>
      <div
        role="progressbar"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={pct === null ? undefined : 100}
        aria-valuenow={pct === null ? undefined : pct}
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        {pct === null ? (
          <div className={cn("absolute inset-y-0 left-0 w-2/5 rounded-full bg-info/70", active ? "animate-progress-indeterminate" : "opacity-40")} />
        ) : (
          <div className={cn("h-full rounded-full transition-[width] duration-300 ease-out", pct >= 100 ? "bg-success" : "bg-info")} style={{ width: `${pct}%` }} />
        )}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">{text}</p>
    </div>
  );
}
