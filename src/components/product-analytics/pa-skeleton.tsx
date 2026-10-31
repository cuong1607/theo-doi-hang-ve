// PRODUCT-ANALYTICS-3: route skeletons — Ads tinted shimmer, shaped like the
// real page (hero, KPI grid, health chips, attention cards, list) so nothing
// jumps when data arrives. Reduced motion: the shimmer stops (globals.css).
import { AdsSkeletonBlock } from "@/components/ads/ads-states";

export function PaListSkeleton() {
  return (
    <div data-ads-root className="space-y-5" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Đang tải phân tích sản phẩm…</span>
      <div className="ads-gradient-hero rounded-2xl border border-ads-border p-5 sm:p-6">
        <div className="flex items-start gap-3.5">
          <AdsSkeletonBlock className="size-11 rounded-xl" />
          <div className="flex-1 space-y-2">
            <AdsSkeletonBlock className="h-7 w-56" />
            <AdsSkeletonBlock className="h-4 w-[min(30rem,70vw)]" />
          </div>
          <AdsSkeletonBlock className="hidden h-9 w-80 rounded-full lg:block" />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <AdsSkeletonBlock className="h-7 w-64 rounded-full" />
          <AdsSkeletonBlock className="h-7 w-32 rounded-full" />
          <AdsSkeletonBlock className="h-7 w-48 rounded-full" />
        </div>
        <AdsSkeletonBlock className="mt-5 h-5 w-40" />
      </div>
      <AdsSkeletonBlock className="h-14 w-full rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdsSkeletonBlock className="h-44 rounded-2xl sm:col-span-2 lg:row-span-2 lg:h-auto" />
        {Array.from({ length: 4 }).map((_, i) => (
          <AdsSkeletonBlock key={i} className="h-[7.5rem] rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <AdsSkeletonBlock key={i} className="h-16 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <AdsSkeletonBlock key={i} className="h-56 rounded-xl" />
        ))}
      </div>
      <AdsSkeletonBlock className="h-[28rem] rounded-2xl" />
    </div>
  );
}

export function PaDetailSkeleton() {
  return (
    <div data-ads-root className="space-y-5" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Đang tải sản phẩm…</span>
      <AdsSkeletonBlock className="h-5 w-40" />
      <div className="ads-gradient-hero rounded-2xl border border-ads-border p-5 sm:p-6">
        <div className="flex items-start gap-3.5">
          <AdsSkeletonBlock className="size-14 rounded-md" />
          <div className="flex-1 space-y-2">
            <AdsSkeletonBlock className="h-7 w-[min(32rem,70vw)]" />
            <AdsSkeletonBlock className="h-6 w-64 rounded-full" />
          </div>
        </div>
        <AdsSkeletonBlock className="mt-6 h-7 w-72 rounded-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <AdsSkeletonBlock key={i} className="h-[7.5rem] rounded-xl" />
        ))}
      </div>
      <AdsSkeletonBlock className="h-56 rounded-2xl" />
      <AdsSkeletonBlock className="h-80 rounded-2xl" />
    </div>
  );
}
