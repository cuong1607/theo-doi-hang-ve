// SHOPEE-ADS-UI-1 efficiency panel: ROAS / ACOS / CTR / CPC / CR as simple
// target gauges (bar + target marker + "Đạt / Chưa đạt mục tiêu" text and
// icon) and the budget-usage progress bar. Bars fill once on mount.
// Targets are UI assumptions (ADS_TARGETS), not business rules yet.
import { CheckCircle2, CircleAlert, Minus } from "lucide-react";
import { cn } from "cn";

import { ADS_METRIC_DEFS, ADS_TARGETS, formatMetric, gaugeFill, meetsTarget, type AdsTargetKey } from "@/lib/channels/shopee/ads/metrics";

import { METRIC_STYLE } from "./metric-style";

const BAR_BG: Record<AdsTargetKey, string> = {
  roas: "bg-metric-roas",
  acos: "bg-metric-acos",
  ctr: "bg-metric-ctr",
  cpc: "bg-metric-cpc",
  conversionRate: "bg-metric-cr",
};

export function AdsProgress({ value, barClass, label, delay = 120, className }: { value: number; barClass: string; label: string; delay?: number; className?: string }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      className={cn("relative h-2 overflow-hidden rounded-full bg-muted", className)}
    >
      <div className="h-full" style={{ width: `${pct * 100}%` }}>
        <div className={cn("animate-ads-fill h-full rounded-full", barClass)} style={{ "--ads-delay": `${delay}ms` } as React.CSSProperties} />
      </div>
    </div>
  );
}

export function AdsEfficiencyCard({ metric, value, delay = 0 }: { metric: AdsTargetKey; value: number | null; delay?: number }) {
  const def = ADS_METRIC_DEFS[metric];
  const s = METRIC_STYLE[metric];
  const ok = meetsTarget(metric, value);
  const Icon = s.icon;
  const StatusIcon = ok === null ? Minus : ok ? CheckCircle2 : CircleAlert;
  return (
    <div data-slot="ads-efficiency" data-metric={metric} data-meets={ok === null ? "na" : String(ok)} className="space-y-2 rounded-xl border border-ads-border bg-ads-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Icon aria-hidden="true" className={cn("size-3.5", s.solid)} />
          {def.label}
        </span>
        <span className={cn("text-base font-semibold tabular-nums", s.text)}>{formatMetric(metric, value)}</span>
      </div>
      <div className="relative">
        <AdsProgress value={gaugeFill(metric, value)} barClass={BAR_BG[metric]} label={`${def.label} so với mục tiêu`} delay={delay} />
        <span aria-hidden="true" className="absolute top-1/2 left-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-foreground/60" />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={cn("inline-flex items-center gap-1", ok === null ? "text-muted-foreground" : ok ? "text-success-text" : "text-warning-text")}>
          <StatusIcon aria-hidden="true" className="size-3.5" />
          {ok === null ? "Chưa có dữ liệu" : ok ? "Đạt mục tiêu" : "Chưa đạt mục tiêu"}
        </span>
        <span className="text-muted-foreground tabular-nums">
          Mục tiêu tham khảo {def.direction === "down" ? "≤" : "≥"} {formatMetric(metric, ADS_TARGETS[metric])}
        </span>
      </div>
    </div>
  );
}

/** "72% ngân sách đã dùng" — spend vs the period budget of the listed campaigns. */
export function AdsBudgetUsage({ spend, budget }: { spend: number; budget: number }) {
  const ratio = budget > 0 ? spend / budget : 0;
  const pct = Math.round(ratio * 100);
  const tone = ratio >= 0.95 ? "bg-metric-acos" : ratio >= 0.8 ? "bg-metric-cpc" : "ads-gradient-primary";
  return (
    <div data-slot="ads-budget" className="space-y-2 rounded-xl border border-ads-border bg-ads-surface-strong p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">Ngân sách</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatMetric("spend", spend)} / {budget > 0 ? formatMetric("spend", budget) : "—"}
        </span>
      </div>
      <AdsProgress value={ratio} barClass={tone} label="Ngân sách đã dùng" className="h-2.5" />
      <p className="text-sm">
        <span className="font-semibold tabular-nums">{budget > 0 ? `${pct}%` : "—"}</span> <span className="text-muted-foreground">ngân sách đã dùng</span>
      </p>
    </div>
  );
}
