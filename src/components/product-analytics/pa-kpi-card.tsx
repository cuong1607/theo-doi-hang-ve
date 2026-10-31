"use client";

// PRODUCT-ANALYTICS-3: KPI cards in the Shopee Ads card language (ads-card,
// metric colour identity, animated value, semantic delta chip, info tooltip).
// Product-specific rules: sales values honour coverage ("—" = no data,
// "≥" = lower bound) and a Δ% is shown only when SQL said the comparison is
// valid — otherwise the card says why there is no comparison.
import { ArrowDownRight, ArrowUpRight, Info, Minus } from "lucide-react";
import { cn } from "cn";

import { formatMetric, type AdsMetricKey } from "@/lib/channels/shopee/ads/metrics";
import { formatPct, type SalesAvailability } from "@/lib/product-analytics/display";
import { deltaTone } from "@/lib/product-analytics/signals";
import type { PaDelta } from "@/lib/product-analytics/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { AnimatedNumber } from "@/components/ads/animated-number";
import { DELTA_CLASS, DELTA_LABEL, METRIC_STYLE } from "@/components/ads/metric-style";

export interface PaKpiProps {
  label: string;
  /** visual identity + number format (Ads metric keys: revenue = VND compact, orders = integer, roas = x) */
  look: AdsMetricKey;
  /** polarity key for the delta tone (sales_gmv, orders, ads_spend, ads_broad_roas …) */
  metric: string;
  delta: PaDelta;
  /** sales cards only */
  availability?: SalesAvailability;
  comparable: boolean;
  /** why there is no comparison (shown instead of the chip) */
  unavailableText?: string;
  tooltip: string;
  delay?: number;
  className?: string;
}

export function PaInfoTip({ label, text, className, light = false }: { label: string; text: string; className?: string; light?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Giải thích: ${label}`}
            className={cn(
              "-m-1 rounded-full p-1 transition-colors duration-(--ads-dur-fast) focus-visible:ring-2 focus-visible:outline-none",
              light ? "text-white/80 hover:text-white focus-visible:ring-white/60" : "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50",
              className,
            )}
          />
        }
      >
        <Info aria-hidden="true" className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

export function PaDeltaChip({ metric, pct, light = false, className }: { metric: string; pct: number | null; light?: boolean; className?: string }) {
  const tone = deltaTone(metric, pct);
  const Icon = pct === null || Math.abs(pct) < 0.5 ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", className)} data-delta-tone={tone}>
      <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium tabular-nums", light ? "bg-white text-ads-secondary-text" : DELTA_CLASS[tone])}>
        <Icon aria-hidden="true" className="size-3" />
        {formatPct(pct)}
      </span>
      <span className={light ? "text-white/85" : "text-muted-foreground"}>
        vs kỳ trước{DELTA_LABEL[tone] && <span className="sr-only"> ({DELTA_LABEL[tone]})</span>}
      </span>
    </span>
  );
}

/** Why no Δ% is shown — the real reason (comparison invalid vs. a zero / empty previous period). */
export function noDeltaText(comparable: boolean, delta: PaDelta, unavailableText?: string): string {
  if (!comparable) return unavailableText ?? "Chưa so sánh được";
  if (!delta.current && !delta.previous) return "Chưa có số liệu ở cả hai kỳ";
  if (delta.previous === 0) return "Kỳ trước = 0 — không tính %";
  return "Chưa so sánh được";
}

function Value({ look, value, availability, className }: { look: AdsMetricKey; value: number | null; availability?: SalesAvailability; className?: string }) {
  if (availability === "no_data" || value === null) return <span className={cn(className, "text-muted-foreground")} title="Chưa có dữ liệu — không phải 0">—</span>;
  if (availability === "lower_bound")
    return (
      <span className={className} title="Chưa đủ dữ liệu: đây là mức tối thiểu">
        <span className="text-muted-foreground">≥ </span>
        {formatMetric(look, value)}
      </span>
    );
  return <AnimatedNumber metric={look} value={value} className={className} />;
}

export function PaKpiCard({ label, look, metric, delta, availability, comparable, unavailableText, tooltip, delay = 0, className }: PaKpiProps) {
  const s = METRIC_STYLE[look];
  const Icon = s.icon;
  return (
    <div
      data-slot="pa-kpi"
      data-metric={metric}
      data-comparable={comparable ? "true" : "false"}
      style={{ "--ads-delay": `${delay}ms` } as React.CSSProperties}
      className={cn("ads-card animate-ads-rise flex min-w-0 flex-col gap-2 rounded-xl border border-ads-border bg-card p-3.5 focus-within:ring-2", s.ring, className)}
    >
      <div className="flex items-center gap-2">
        <span data-ads-icon className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg transition-transform duration-(--ads-dur-fast)", s.soft)}>
          <Icon aria-hidden="true" className={cn("size-3.5", s.solid)} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">{label}</span>
        <PaInfoTip label={label} text={tooltip} />
      </div>
      <Value look={look} value={delta.current} availability={availability} className={cn("text-xl font-semibold tracking-tight tabular-nums", s.text)} />
      {comparable && delta.pct !== null ? <PaDeltaChip metric={metric} pct={delta.pct} /> : <span className="text-xs text-muted-foreground">{noDeltaText(comparable, delta, unavailableText)}</span>}
    </div>
  );
}

/** The one dominant KPI (sales GMV): brand gradient, large value — same shape as AdsHeroMetric. */
export function PaHeroKpi({ label, delta, availability, comparable, unavailableText, tooltip, footer, className }: Omit<PaKpiProps, "look" | "metric" | "delay"> & { footer?: React.ReactNode }) {
  return (
    <div
      data-slot="pa-hero-kpi"
      data-comparable={comparable ? "true" : "false"}
      className={cn("ads-card animate-ads-rise ads-gradient-primary relative isolate flex min-h-44 flex-col justify-between gap-4 overflow-hidden rounded-2xl p-5 text-white shadow-lg shadow-ads-secondary/20", className)}
    >
      <div aria-hidden="true" className="animate-ads-glow absolute -top-16 -right-10 -z-10 size-48 rounded-full bg-white/15 blur-2xl" />
      <div aria-hidden="true" className="animate-ads-glow absolute -bottom-20 left-1/3 -z-10 size-40 rounded-full bg-white/10 blur-2xl [animation-delay:150ms]" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-white/85">
            {label}
            <PaInfoTip label={label} text={tooltip} light />
          </p>
          {availability === "no_data" || delta.current === null ? (
            <span className="mt-1 block text-4xl font-semibold tracking-tight">—</span>
          ) : (
            <span className="mt-1 flex items-baseline gap-1 text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
              {availability === "lower_bound" && <span className="text-2xl text-white/80">≥</span>}
              <AnimatedNumber metric="revenue" value={delta.current} />
            </span>
          )}
        </div>
        <span className="rounded-full bg-white/18 px-2.5 py-1 text-xs font-medium whitespace-nowrap backdrop-blur-sm">Từ đơn hàng</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        {comparable && delta.pct !== null ? <PaDeltaChip metric="sales_gmv" pct={delta.pct} light /> : <span className="text-white/85">{noDeltaText(comparable, delta, unavailableText)}</span>}
        {footer}
      </div>
    </div>
  );
}
