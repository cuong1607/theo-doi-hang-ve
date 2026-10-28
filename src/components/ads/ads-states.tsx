// SHOPEE-ADS-UI-1 section states: tinted-shimmer skeletons (calm, low
// contrast, not grey-only) and a friendly empty state with a CTA. Server-
// renderable (icons can be passed in); the error card is ads-error-state.tsx.
import { SearchX, Sparkles, type LucideIcon } from "lucide-react";
import { cn } from "cn";

export function AdsSkeletonBlock({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("ads-shimmer rounded-lg", className)} />;
}

/** Whole dashboard placeholder — same grid as the real page (no jump on arrival). */
export function AdsDashboardSkeleton() {
  return (
    <div data-ads-root className="space-y-5" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Đang tải dữ liệu quảng cáo…</span>
      <div className="ads-gradient-hero rounded-2xl border border-ads-border p-5 sm:p-6">
        <div className="flex items-start gap-3.5">
          <AdsSkeletonBlock className="size-11 rounded-xl" />
          <div className="flex-1 space-y-2">
            <AdsSkeletonBlock className="h-7 w-56" />
            <AdsSkeletonBlock className="h-4 w-[min(26rem,70vw)]" />
            <AdsSkeletonBlock className="h-6 w-40 rounded-full" />
          </div>
        </div>
        <AdsSkeletonBlock className="mt-6 h-5 w-72" />
      </div>
      <AdsSkeletonBlock className="h-10 w-full max-w-2xl rounded-full" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdsSkeletonBlock className="h-44 rounded-2xl sm:col-span-2 lg:row-span-2 lg:h-auto" />
        {Array.from({ length: 8 }).map((_, i) => (
          <AdsSkeletonBlock key={i} className="h-[7.5rem] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-3">
        <AdsSkeletonBlock className="h-80 rounded-2xl xl:col-span-2" />
        <AdsSkeletonBlock className="h-80 rounded-2xl" />
      </div>
      <AdsSkeletonBlock className="h-96 rounded-2xl" />
    </div>
  );
}

export function AdsEmptyState({
  title = "Chưa có dữ liệu quảng cáo trong khoảng thời gian này.",
  description,
  icon,
  action,
  compact = false,
  variant = "no-data",
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  action?: React.ReactNode;
  compact?: boolean;
  variant?: "no-data" | "no-results";
}) {
  const Icon = icon ?? (variant === "no-results" ? SearchX : Sparkles);
  return (
    <div data-slot="ads-empty-state" data-variant={variant} className={cn("animate-ads-pop flex h-full flex-col items-center justify-center gap-2 px-4 text-center", compact ? "py-8" : "py-14")}>
      <div className="relative mb-1">
        <span aria-hidden="true" className="absolute inset-0 -m-2 rounded-full bg-ads-primary/10 blur-md" />
        <div className="relative flex size-12 items-center justify-center rounded-2xl border border-ads-border bg-ads-surface-strong">
          <Icon aria-hidden="true" className="size-5 text-ads-primary" />
        </div>
      </div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
