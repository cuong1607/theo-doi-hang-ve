"use client";

// SHOPEE-ADS-UI-1 hero: soft coral/violet wash, two blurred shapes that
// fade in ONCE (no floating loop), title + subtitle, actions
// [Làm mới dữ liệu] [Cấu hình] [Khoảng thời gian], sync status, and the
// module sub-nav (future routes shown as "Sắp có", not built yet).
import Link from "next/link";
import { CalendarDays, ChevronDown, Megaphone, Settings } from "lucide-react";
import { cn } from "cn";

import { PERIOD_PRESETS, type PeriodPreset } from "@/lib/analytics/periods";
import { ADS_PRESET_LABELS } from "@/lib/channels/shopee/ads/filters";
import type { AdsSyncStatus as AdsSyncStatusVM } from "@/lib/channels/shopee/ads/view-models";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import { usePeriodNav } from "./ads-filter-bar";
import { AdsRefreshButton, AdsSyncStatus } from "./ads-refresh";

const SUB_NAV = [
  { label: "Tổng quan", href: "/shopee/ads", ready: true },
  { label: "Chiến dịch", href: "/shopee/ads/campaigns", ready: false },
  { label: "Báo cáo", href: "/shopee/ads/reports", ready: false },
  { label: "Cài đặt", href: "/shopee/ads/settings", ready: false },
] as const;

function AdsPeriodMenu({ preset, rangeLabel }: { preset: PeriodPreset; rangeLabel: string }) {
  const { optimistic, setPeriod } = usePeriodNav();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="rounded-full border-ads-border bg-card/80 backdrop-blur-sm" aria-label={`Khoảng thời gian: ${rangeLabel}`} />}>
        <CalendarDays aria-hidden="true" className="text-ads-primary" />
        <span className="tabular-nums">{rangeLabel}</span>
        <ChevronDown aria-hidden="true" className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup value={optimistic ?? preset} onValueChange={(v) => setPeriod(v as PeriodPreset)}>
          {PERIOD_PRESETS.map((p) => (
            <DropdownMenuRadioItem key={p} value={p}>
              {ADS_PRESET_LABELS[p]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AdsPageHeader({
  preset,
  rangeLabel,
  canManage,
  sync,
  serverNow,
}: {
  preset: PeriodPreset;
  rangeLabel: string;
  canManage: boolean;
  sync: AdsSyncStatusVM;
  serverNow: string;
}) {
  return (
    <header data-slot="ads-hero" className="ads-gradient-hero animate-ads-rise relative isolate overflow-hidden rounded-2xl border border-ads-border px-5 pt-5 pb-0 sm:px-6">
      <div aria-hidden="true" className="animate-ads-glow absolute -top-24 -left-16 -z-10 size-64 rounded-full bg-ads-primary/20 blur-3xl" />
      <div aria-hidden="true" className="animate-ads-glow absolute -top-20 right-0 -z-10 size-56 rounded-full bg-ads-secondary/15 blur-3xl [animation-delay:120ms]" />
      <div aria-hidden="true" className="animate-ads-glow absolute -bottom-24 left-1/2 -z-10 size-48 rounded-full bg-ads-accent/12 blur-3xl [animation-delay:220ms]" />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="ads-gradient-primary flex size-11 shrink-0 items-center justify-center rounded-xl text-white shadow-md shadow-ads-primary/30">
            <Megaphone aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">Quảng cáo Shopee</h2>
            <p className="text-sm text-muted-foreground">Theo dõi chi phí, doanh thu và hiệu quả quảng cáo.</p>
            <AdsSyncStatus sync={sync} serverNow={serverNow} className="pt-1.5" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AdsPeriodMenu preset={preset} rangeLabel={rangeLabel} />
          {/* Internal connection settings only — never edits Shopee campaigns (read-only policy). */}
          {canManage && (
            <Link href="/settings/shopee" title="Cấu hình kết nối Shopee (nội bộ) — quảng cáo chỉ đọc" className={cn(buttonVariants({ variant: "outline" }), "rounded-full border-ads-border bg-card/80 backdrop-blur-sm transition-[transform,background-color] duration-(--ads-dur-fast) hover:-translate-y-px active:scale-[0.97]")}>
              <Settings aria-hidden="true" /> Cấu hình
            </Link>
          )}
          <AdsRefreshButton className="rounded-full" />
        </div>
      </div>

      <nav aria-label="Mục Quảng cáo Shopee" className="-mx-1 mt-5 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
        {SUB_NAV.map((item) =>
          item.ready ? (
            <Link
              key={item.href}
              href={item.href}
              aria-current="page"
              className="relative px-3 pt-1 pb-3 text-sm font-medium whitespace-nowrap text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {item.label}
              <span aria-hidden="true" className="ads-gradient-primary absolute inset-x-2 bottom-0 h-[3px] rounded-full" />
            </Link>
          ) : (
            <span key={item.href} aria-disabled="true" title="Sắp có" className="inline-flex items-center gap-1.5 px-3 pt-1 pb-3 text-sm whitespace-nowrap text-muted-foreground/80">
              {item.label}
              <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4">Sắp có</span>
            </span>
          ),
        )}
      </nav>
    </header>
  );
}
