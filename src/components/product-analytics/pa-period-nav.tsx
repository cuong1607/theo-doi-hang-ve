"use client";

// PRODUCT-ANALYTICS-3: period switcher — the Ads segmented control. Changing
// the period keeps shop / filters / sort, resets the page and the custom range.
// Plain navigation (server-rendered page, DB only — never a Shopee call).
import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "cn";

import { PRODUCT_PERIOD_LABELS, type ProductPeriodPreset } from "@/lib/product-analytics/periods";
import { AdsSegmented } from "@/components/ads/ads-segmented";

const PRESETS = ["today", "yesterday", "7d", "30d"] as const;

export function PaPeriodNav({ preset, className }: { preset: ProductPeriodPreset; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const value = (PRESETS as readonly string[]).includes(preset) ? (preset as (typeof PRESETS)[number]) : "7d";
  return (
    <div className={cn("flex items-center gap-2", className)} data-pending={pending ? "true" : undefined}>
      <AdsSegmented
        label="Khoảng thời gian"
        size="sm"
        className={cn("w-full min-w-0 sm:w-[22rem]", pending && "opacity-70", preset === "custom" && "[&_[aria-hidden=true]]:opacity-0")}
        options={PRESETS.map((p) => ({ value: p, label: PRODUCT_PERIOD_LABELS[p] }))}
        value={value}
        onChange={(p) => {
          const next = new URLSearchParams(params.toString());
          next.set("period", p);
          next.delete("from");
          next.delete("to");
          next.delete("page");
          start(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
        }}
      />
    </div>
  );
}
