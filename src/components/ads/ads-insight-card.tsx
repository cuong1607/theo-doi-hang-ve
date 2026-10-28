// SHOPEE-ADS-UI-1: friendly insight card (demo insights from fixtures —
// not a recommendation engine). Icon + short title + one sentence + a
// semantic tint; the tone is also spelled out for screen readers.
import { AlertTriangle, Info, OctagonAlert, TrendingUp, type LucideIcon } from "lucide-react";
import { cn } from "cn";

import type { AdsInsight, AdsInsightTone } from "@/lib/channels/shopee/ads/view-models";

import { INSIGHT_STYLE } from "./metric-style";

const ICON: Record<AdsInsightTone, LucideIcon> = { success: TrendingUp, warning: AlertTriangle, danger: OctagonAlert, info: Info };
const TONE_LABEL: Record<AdsInsightTone, string> = { success: "Tích cực", warning: "Cần chú ý", danger: "Cảnh báo", info: "Thông tin" };

export function AdsInsightCard({ insight, delay = 0 }: { insight: AdsInsight; delay?: number }) {
  const s = INSIGHT_STYLE[insight.tone];
  const Icon = ICON[insight.tone];
  return (
    <li
      data-slot="ads-insight"
      data-tone={insight.tone}
      style={{ "--ads-delay": `${delay}ms` } as React.CSSProperties}
      className={cn("ads-card animate-ads-rise flex gap-3 rounded-xl border p-3", s.soft, s.border)}
    >
      <span data-ads-icon className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg transition-transform duration-(--ads-dur-fast)", s.icon)}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">
          <span className="sr-only">{TONE_LABEL[insight.tone]}: </span>
          {insight.title}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{insight.description}</p>
      </div>
    </li>
  );
}
