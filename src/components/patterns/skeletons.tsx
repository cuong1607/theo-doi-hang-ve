// UIUX-1 loading skeletons: shaped like the real layout (header, KPI row,
// filter bar, table) so nothing jumps when data arrives. Used by every
// route's loading.tsx — never a blank page or a lone "Loading...".
import { Loader2 } from "lucide-react";
import { cn } from "cn";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function PageHeaderSkeleton({ actions = 1 }: { actions?: number }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-[min(32rem,80vw)]" />
        <Skeleton className="h-4 w-48" />
      </div>
      {actions > 0 && (
        <div className="flex gap-2">
          {Array.from({ length: actions }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-32" />
          ))}
        </div>
      )}
    </div>
  );
}

export function MetricSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6", count <= 4 && "xl:grid-cols-4", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} size="sm">
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function FilterBarSkeleton({ controls = 5 }: { controls?: number }) {
  return (
    <div className="flex flex-wrap gap-2">
      {Array.from({ length: controls }).map((_, i) => (
        <Skeleton key={i} className={cn("h-8", i === 0 ? "w-56" : "w-36")} />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 8, columns = 6, className }: { rows?: number; columns?: number; className?: string }) {
  return (
    <div className={cn("w-full overflow-hidden", className)}>
      <div className="flex gap-4 rounded-md bg-muted px-3 py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1 bg-foreground/10" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b px-3 py-3.5 last:border-b-0">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className={cn("h-4 flex-1", c === 0 && "max-w-28", (r + c) % 3 === 0 && "opacity-70")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
      </CardHeader>
      <CardContent className="space-y-2.5">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={cn("h-4", i % 2 ? "w-2/3" : "w-full")} />
        ))}
      </CardContent>
    </Card>
  );
}

export function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <Card>
      <CardContent className="space-y-4">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <Skeleton className="h-9 w-32" />
      </CardContent>
    </Card>
  );
}

/** Whole list page: header, KPI row, filter bar, table. */
export function PageSkeleton({ metrics = 0, filters = true, rows = 8, columns = 6, label = "Đang tải dữ liệu…" }: { metrics?: number; filters?: boolean; rows?: number; columns?: number; label?: string }) {
  return (
    <div className="space-y-6" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <PageHeaderSkeleton />
      {metrics > 0 && <MetricSkeleton count={metrics} />}
      <Card>
        {filters && (
          <CardHeader>
            <FilterBarSkeleton />
          </CardHeader>
        )}
        <CardContent>
          <TableSkeleton rows={rows} columns={columns} />
        </CardContent>
      </Card>
    </div>
  );
}

/** Small inline "working" indicator with accessible text. */
export function InlineSpinner({ label = "Đang tải…", showLabel = false, className }: { label?: string; showLabel?: boolean; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-1.5 text-sm text-muted-foreground", className)}>
      <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      <span className={showLabel ? undefined : "sr-only"}>{label}</span>
    </span>
  );
}
