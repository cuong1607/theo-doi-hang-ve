// PRODUCT-ANALYTICS-3: health / signal / priority / data-quality badges.
// Same visual language as Shopee Ads (semantic soft tokens, rounded pills).
// Colour is never the only signal: every badge has an icon AND words, and the
// tone follows business meaning (CPC down = good, spend = neutral), never the sign.
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, CircleHelp, Eye, Flag, Minus, TrendingDown, Info } from "lucide-react";
import { cn } from "cn";

import { DELTA_CLASS, DELTA_LABEL } from "@/components/ads/metric-style";
import {
  CONFIDENCE_TEXT,
  DATA_QUALITY_TEXT,
  describeSignal,
  HEALTH_TEXT,
  PRIORITY_TEXT,
  priorityExplain,
  signalTone,
  type AttentionPriority,
  type DataQualitySignalType,
  type HealthLabel,
  type ProductSignal,
  type SignalConfidence,
} from "@/lib/product-analytics/signals";

export const HEALTH_STYLE: Record<HealthLabel, { cls: string; dot: string; icon: typeof CheckCircle2 }> = {
  GOOD: { cls: "bg-success-soft text-success-text border-success/25", dot: "bg-success", icon: CheckCircle2 },
  STABLE: { cls: "bg-info-soft text-info-text border-info/25", dot: "bg-info", icon: Minus },
  WATCH: { cls: "bg-warning-soft text-warning-text border-warning/30", dot: "bg-warning", icon: Eye },
  WEAK: { cls: "bg-danger-soft text-danger-text border-destructive/25", dot: "bg-destructive", icon: TrendingDown },
  INSUFFICIENT_DATA: { cls: "bg-muted text-muted-foreground border-border", dot: "bg-muted-foreground/60", icon: CircleHelp },
};

export function HealthBadge({ label, size = "sm", className }: { label: HealthLabel; size?: "sm" | "md"; className?: string }) {
  const s = HEALTH_STYLE[label];
  const Icon = s.icon;
  return (
    <span data-slot="pa-health" data-health={label} className={cn("inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap", size === "md" ? "h-7 px-2.5 text-sm" : "h-6 px-2 text-xs", s.cls, className)}>
      <Icon aria-hidden="true" className={size === "md" ? "size-3.5" : "size-3"} />
      {HEALTH_TEXT[label]}
    </span>
  );
}

/** "Doanh số giảm 21%" with semantic tone; title = the evidence (previous → current). */
export function SignalChip({ signal, evidence, className }: { signal: ProductSignal; evidence?: string; className?: string }) {
  const tone = signalTone(signal);
  const Icon = signal.direction === "flat" ? Minus : signal.direction === "up" ? ArrowUpRight : ArrowDownRight;
  return (
    <span data-slot="pa-signal" data-signal={signal.type} data-tone={tone} title={evidence} className={cn("inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", DELTA_CLASS[tone], className)}>
      {signal.severity === "WARNING" ? <AlertTriangle aria-hidden="true" className="size-3 shrink-0" /> : <Icon aria-hidden="true" className="size-3 shrink-0" />}
      <span className="truncate">{describeSignal(signal)}</span>
      {DELTA_LABEL[tone] && <span className="sr-only"> ({DELTA_LABEL[tone]})</span>}
    </span>
  );
}

const PRIORITY_CLS: Record<AttentionPriority["level"], string> = {
  HIGH: "bg-danger-soft text-danger-text",
  MEDIUM: "bg-warning-soft text-warning-text",
  LOW: "bg-muted text-muted-foreground",
  NONE: "bg-muted text-muted-foreground",
};

/** Priority level in words + score; the formula is in the title — never a bare number. */
export function PriorityPill({ priority, className }: { priority: AttentionPriority; className?: string }) {
  if (priority.level === "NONE") return null;
  return (
    <span data-slot="pa-priority" data-level={priority.level} title={priorityExplain(priority)} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", PRIORITY_CLS[priority.level], className)}>
      <Flag aria-hidden="true" className="size-3" />
      {PRIORITY_TEXT[priority.level]}
      <span className="tabular-nums opacity-75">· {priority.score}</span>
    </span>
  );
}

export function DataQualityChip({ type, className }: { type: DataQualitySignalType; className?: string }) {
  return (
    <span data-slot="pa-dq" data-dq={type} className={cn("inline-flex items-center gap-1 rounded-full border border-dashed border-ads-border px-2 py-0.5 text-[11px] text-muted-foreground", className)}>
      <Info aria-hidden="true" className="size-3" />
      {DATA_QUALITY_TEXT[type]}
    </span>
  );
}

export function ConfidenceText({ confidence, className }: { confidence: SignalConfidence; className?: string }) {
  const dots = confidence === "HIGH" ? 3 : confidence === "MEDIUM" ? 2 : 1;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] text-muted-foreground", className)}>
      <span aria-hidden="true" className="inline-flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className={cn("size-1.5 rounded-full", i < dots ? "bg-ads-accent" : "bg-muted-foreground/25")} />
        ))}
      </span>
      {CONFIDENCE_TEXT[confidence]}
    </span>
  );
}
