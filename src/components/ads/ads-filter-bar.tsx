"use client";

// SHOPEE-ADS-UI-1 global filters. Everything lives in the URL
// (?period=&from=&to=&shop=&status=&type=) and is re-validated on the
// server. Period = always-visible pill bar (optimistic indicator, the
// dashboard stays on screen while the new data renders); shop / status /
// type reuse the shared FilterBar (collapsed behind "Bộ lọc" on mobile).
import { useOptimistic, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { cn } from "cn";

import { PERIOD_PRESETS, type PeriodPreset } from "@/lib/analytics/periods";
import { ADS_PRESET_LABELS, ADS_STATUS_OPTIONS, ADS_TYPE_OPTIONS } from "@/lib/channels/shopee/ads/filters";
import type { AdsFilters, AdsShopOption } from "@/lib/channels/shopee/ads/view-models";
import { FilterBar, FilterDate, FilterSelect, useFilterNav } from "@/components/patterns/filter-bar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { AdsSegmented } from "./ads-segmented";

const PRESET_OPTIONS = PERIOD_PRESETS.map((p) => ({ value: p, label: ADS_PRESET_LABELS[p] }));
/** Params that reset when the period changes (table paging) or are period-only. */
const PERIOD_RESET = ["page", "from", "to"];

/** URL updates for the period bar (same rules as FilterBar: replace, no scroll, transition). */
export function usePeriodNav() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const current = (params.get("period") as PeriodPreset | null) ?? null;
  const [optimistic, setOptimistic] = useOptimistic(current);
  const setPeriod = (p: PeriodPreset) => {
    const sp = new URLSearchParams(params.toString());
    for (const k of PERIOD_RESET) sp.delete(k);
    sp.set("period", p);
    startTransition(() => {
      setOptimistic(p);
      router.replace(`${pathname}?${sp}`, { scroll: false });
    });
  };
  return { optimistic, setPeriod, pending };
}

export function AdsPeriodBar({ value, className }: { value: PeriodPreset; className?: string }) {
  const { optimistic, setPeriod, pending } = usePeriodNav();
  const active = optimistic ?? value;
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <div className="-mx-1 min-w-0 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
        <AdsSegmented options={PRESET_OPTIONS} value={active} onChange={setPeriod} label="Khoảng thời gian" className="min-w-[38rem]" />
      </div>
      <span role="status" className={cn("inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-opacity duration-(--ads-dur-fast)", pending ? "opacity-100" : "opacity-0")}>
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        <span className={pending ? undefined : "sr-only"}>{pending ? "Đang cập nhật…" : ""}</span>
      </span>
    </div>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase();
}

/** Small initial-avatar (no invented brand images). */
export function ShopAvatar({ name, index, className }: { name: string; index: number; className?: string }) {
  const tones = ["bg-ads-primary/15 text-ads-primary-text", "bg-ads-secondary/15 text-ads-secondary-text", "bg-ads-accent/15 text-ads-accent-text"];
  return (
    <span aria-hidden="true" className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold", index < 0 ? "bg-muted text-muted-foreground" : tones[index % tones.length], className)}>
      {index < 0 ? "∗" : initials(name)}
    </span>
  );
}

function ShopSelect({ shops, value }: { shops: AdsShopOption[]; value: string }) {
  const { setParam } = useFilterNav();
  const items = [{ value: "all", label: "Tất cả shop" }, ...shops.map((s) => ({ value: s.id, label: s.name }))];
  return (
    <Select value={value || "all"} onValueChange={(v) => setParam("shop", String(v))} items={items}>
      <SelectTrigger className="w-full rounded-full sm:w-auto sm:min-w-40" aria-label="Shop">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((o, i) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="inline-flex items-center gap-2">
              <ShopAvatar name={o.label} index={i - 1} />
              {o.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AdsFilterBar({ filters, shops }: { filters: AdsFilters; shops: AdsShopOption[] }) {
  return (
    <div data-slot="ads-filter-bar" className="space-y-3">
      <AdsPeriodBar value={filters.preset} />
      <FilterBar filterKeys={["shop", "status", "type", "from", "to"]}>
        {filters.preset === "custom" && (
          <>
            <FilterDate paramKey="from" value={filters.from} label="Từ ngày" className="rounded-full" />
            <FilterDate paramKey="to" value={filters.to} label="Đến ngày" className="rounded-full" />
          </>
        )}
        <ShopSelect shops={shops} value={filters.shop} />
        <FilterSelect paramKey="status" value={filters.status} options={ADS_STATUS_OPTIONS} label="Trạng thái chiến dịch" className="rounded-full" />
        <FilterSelect paramKey="type" value={filters.type} options={ADS_TYPE_OPTIONS} label="Loại chiến dịch" className="rounded-full" />
      </FilterBar>
    </div>
  );
}
