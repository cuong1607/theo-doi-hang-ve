"use client";

// SHOPEE-ADS-UI-1: KPI cards. Each metric has its own colour identity
// (METRIC_STYLE), but the DELTA colour is semantic (adsDeltaTone): ROAS ↑
// good, ACOS / CPC ↑ bad, spend ↑ neutral unless revenue lags. Every delta
// also carries an arrow + sign + words, so colour is never the only signal.
import { ArrowDownRight, ArrowUpRight, Info, Minus } from "lucide-react";
import { cn } from "cn";

import { ADS_METRIC_DEFS, ADS_TARGETS, adsDeltaPercent, adsDeltaTone, formatDelta, formatMetricDetailed, type AdsMetricKey } from "@/lib/channels/shopee/ads/metrics";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { AnimatedNumber } from "./animated-number";
import { acosStyle, DELTA_CLASS, DELTA_LABEL, METRIC_STYLE } from "./metric-style";
import { Sparkline } from "./sparkline";

export interface MetricCardProps {
  metric: AdsMetricKey;
  value: number | null;
  previous: number | null;
  spark?: number[];
  /** Revenue Δ% — lets the spend delta be judged in context. */
  revenueDelta?: number | null;
  className?: string;
  delay?: number;
}

export function DeltaChip({ metric, value, previous, revenueDelta, className }: { metric: AdsMetricKey; value: number | null; previous: number | null; revenueDelta?: number | null; className?: string }) {
  const delta = adsDeltaPercent(value, previous);
  const tone = adsDeltaTone(metric, delta, { revenueDelta });
  const Icon = delta === null || Math.abs(delta) < 0.5 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", className)} data-delta-tone={tone}>
      <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium tabular-nums transition-colors duration-(--ads-dur-normal)", DELTA_CLASS[tone])}>
        <Icon aria-hidden="true" className="size-3" />
        {formatDelta(delta)}
      </span>
      <span className="text-muted-foreground">
        vs kỳ trước{DELTA_LABEL[tone] && <span className="sr-only"> ({DELTA_LABEL[tone]})</span>}
      </span>
    </span>
  );
}

function MetricInfo({ metric, value }: { metric: AdsMetricKey; value: number | null }) {
  const def = ADS_METRIC_DEFS[metric];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Định nghĩa ${def.label}`}
            className="-m-1 rounded-full p-1 text-muted-foreground transition-colors duration-(--ads-dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          />
        }
      >
        <Info aria-hidden="true" className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        <span className="font-medium tabular-nums">{formatMetricDetailed(metric, value)}</span>
        {def.definition && <span className="opacity-80">{def.definition}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export function AdsMetricCard({ metric, value, previous, spark, revenueDelta, className, delay = 0 }: MetricCardProps) {
  // ACOS within target reads orange, above target red (computed here: icons cannot cross the server/client boundary).
  const s = metric === "acos" ? acosStyle(value, ADS_TARGETS.acos) : METRIC_STYLE[metric];
  const def = ADS_METRIC_DEFS[metric];
  const Icon = s.icon;
  return (
    <div
      data-slot="ads-metric-card"
      data-metric={metric}
      style={{ "--ads-delay": `${delay}ms` } as React.CSSProperties}
      className={cn("ads-card animate-ads-rise flex min-w-0 flex-col gap-2 rounded-xl border border-ads-border bg-card p-3.5 focus-within:ring-2", s.ring, className)}
    >
      <div className="flex items-center gap-2">
        <span data-ads-icon className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg transition-transform duration-(--ads-dur-fast)", s.soft)}>
          <Icon aria-hidden="true" className={cn("size-3.5", s.solid)} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">{def.label}</span>
        <MetricInfo metric={metric} value={value} />
      </div>
      <AnimatedNumber metric={metric} value={value} className={cn("text-xl font-semibold tracking-tight tabular-nums", s.text)} />
      <div className="flex items-end justify-between gap-2">
        <DeltaChip metric={metric} value={value} previous={previous} revenueDelta={revenueDelta} />
        {spark && <Sparkline values={spark} color={s.stroke} area={false} className="h-6 w-16 shrink-0" />}
      </div>
    </div>
  );
}

/** The one dominant KPI (ROAS): bigger, brand gradient, sparkline area. */
export function AdsHeroMetric({ value, previous, spark, revenue, spend, className }: { value: number | null; previous: number | null; spark: number[]; revenue: number; spend: number; className?: string }) {
  const def = ADS_METRIC_DEFS.roas;
  return (
    <div
      data-slot="ads-hero-metric"
      data-metric="roas"
      className={cn("ads-card animate-ads-rise ads-gradient-primary relative isolate flex min-h-44 flex-col justify-between gap-4 overflow-hidden rounded-2xl p-5 text-white shadow-lg shadow-ads-secondary/20", className)}
    >
      <div aria-hidden="true" className="animate-ads-glow absolute -top-16 -right-10 -z-10 size-48 rounded-full bg-white/15 blur-2xl" />
      <div aria-hidden="true" className="animate-ads-glow absolute -bottom-20 left-1/3 -z-10 size-40 rounded-full bg-white/10 blur-2xl [animation-delay:150ms]" />
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-white/85">
            ROAS
            <Tooltip>
              <TooltipTrigger render={<button type="button" aria-label="Định nghĩa ROAS" className="rounded-full p-0.5 text-white/80 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none" />}>
                <Info aria-hidden="true" className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{def.definition}</TooltipContent>
            </Tooltip>
          </p>
          <AnimatedNumber metric="roas" value={value} className="mt-1 block text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl" />
        </div>
        <span className="rounded-full bg-white/18 px-2.5 py-1 text-xs font-medium backdrop-blur-sm">Chỉ số chính</span>
      </div>
      <Sparkline values={spark} color="rgb(255 255 255 / 0.95)" className="h-14" />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <HeroDelta value={value} previous={previous} />
        <span className="text-white/85 tabular-nums">
          {formatMetricDetailed("revenue", revenue)} / {formatMetricDetailed("spend", spend)}
        </span>
      </div>
    </div>
  );
}

function HeroDelta({ value, previous }: { value: number | null; previous: number | null }) {
  const delta = adsDeltaPercent(value, previous);
  const tone = adsDeltaTone("roas", delta);
  const Icon = delta === null || Math.abs(delta) < 0.5 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1.5" data-delta-tone={tone}>
      <span className="inline-flex items-center gap-0.5 rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-ads-secondary-text tabular-nums">
        <Icon aria-hidden="true" className="size-3.5" />
        {formatDelta(delta)}
      </span>
      <span className="text-white/85">
        vs kỳ trước{DELTA_LABEL[tone] && <span className="sr-only"> ({DELTA_LABEL[tone]})</span>}
      </span>
    </span>
  );
}
