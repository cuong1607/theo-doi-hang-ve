// PRODUCT-ANALYTICS-3: overview hero — same wash / glow / icon chip as the
// Shopee Ads header, so both read as one product. Shows the period, the shop
// scope, data freshness and the partial-today indicator; the sub-nav links the
// two dashboards (Products ↔ Ads).
import Link from "next/link";
import { CalendarDays, Clock, PackageSearch, Store, TriangleAlert } from "lucide-react";
import { cn } from "cn";

import { formatAge } from "@/lib/product-analytics/display";

import { PaPeriodNav } from "./pa-period-nav";
import type { ProductPeriodPreset } from "@/lib/product-analytics/periods";

export function PaPageHeader({
  title,
  subtitle,
  preset,
  rangeLabel,
  compareLabel,
  scopeLabel,
  salesAgeMinutes,
  salesStale,
  adsAgeMinutes,
  partialToday,
  hourCutoff,
  icon = true,
  children,
}: {
  title: React.ReactNode;
  subtitle: React.ReactNode;
  preset: ProductPeriodPreset;
  rangeLabel: string;
  compareLabel: string | null;
  scopeLabel: string;
  salesAgeMinutes: number | null;
  salesStale: boolean;
  adsAgeMinutes: number | null;
  partialToday: boolean;
  hourCutoff: number | null;
  icon?: boolean;
  children?: React.ReactNode;
}) {
  const chip = "inline-flex items-center gap-1.5 rounded-full border border-ads-border bg-card/70 px-2.5 py-1 text-xs backdrop-blur-sm";
  return (
    <header data-slot="pa-hero" className="ads-gradient-hero animate-ads-rise relative isolate overflow-hidden rounded-2xl border border-ads-border px-5 pt-5 pb-0 sm:px-6">
      <div aria-hidden="true" className="animate-ads-glow absolute -top-24 -left-16 -z-10 size-64 rounded-full bg-ads-primary/20 blur-3xl" />
      <div aria-hidden="true" className="animate-ads-glow absolute -top-20 right-0 -z-10 size-56 rounded-full bg-ads-accent/15 blur-3xl [animation-delay:120ms]" />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          {icon && (
            <span className="ads-gradient-primary flex size-11 shrink-0 items-center justify-center rounded-xl text-white shadow-md shadow-ads-primary/30">
              <PackageSearch aria-hidden="true" className="size-5" />
            </span>
          )}
          <div className="min-w-0 space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
            <div className="text-sm text-muted-foreground">{subtitle}</div>
          </div>
        </div>
        <PaPeriodNav preset={preset} className="lg:shrink-0" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2" data-slot="pa-hero-meta">
        <span className={chip}>
          <CalendarDays aria-hidden="true" className="size-3.5 text-ads-primary" />
          <span className="tabular-nums">{rangeLabel}</span>
          {compareLabel && <span className="text-muted-foreground">· so với {compareLabel}</span>}
        </span>
        <span className={chip}>
          <Store aria-hidden="true" className="size-3.5 text-ads-accent" />
          {scopeLabel}
        </span>
        <span className={cn(chip, salesStale && "border-warning/40 bg-warning-soft text-warning-text")} data-slot="pa-freshness" data-stale={salesStale ? "true" : "false"}>
          <Clock aria-hidden="true" className="size-3.5" />
          Đơn hàng cập nhật {formatAge(salesAgeMinutes)}
          {adsAgeMinutes !== null && <span className="text-muted-foreground">· Ads {formatAge(adsAgeMinutes)}</span>}
        </span>
        {partialToday && (
          <span className={cn(chip, "border-warning/40 bg-warning-soft text-warning-text")} data-slot="pa-partial-today" role="status">
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            Hôm nay chưa hết ngày{hourCutoff !== null ? ` · so sánh đến ${hourCutoff}:00` : ""}
          </span>
        )}
      </div>

      {children}

      <nav aria-label="Phân tích Shopee" className="-mx-1 mt-4 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
        <Link href="/shopee/product-analytics" aria-current="page" className="relative px-3 pt-1 pb-3 text-sm font-medium whitespace-nowrap text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          Sản phẩm
          <span aria-hidden="true" className="ads-gradient-primary absolute inset-x-2 bottom-0 h-[3px] rounded-full" />
        </Link>
        <Link href="/shopee/ads" className="px-3 pt-1 pb-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          Quảng cáo
        </Link>
      </nav>
    </header>
  );
}
