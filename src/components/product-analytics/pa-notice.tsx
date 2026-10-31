// PRODUCT-ANALYTICS-3: friendly data-state notice (backfill pending, stale data,
// comparison unavailable …) — the Ads insight-card tones, icon + title + words.
import type { LucideIcon } from "lucide-react";
import { cn } from "cn";

import { INSIGHT_STYLE } from "@/components/ads/metric-style";

export function PaNotice({ tone, title, icon: Icon, children, className }: { tone: "info" | "warning" | "danger" | "success"; title: string; icon: LucideIcon; children: React.ReactNode; className?: string }) {
  const s = INSIGHT_STYLE[tone];
  return (
    <div role={tone === "info" || tone === "success" ? "note" : "status"} data-slot="pa-notice" data-tone={tone} className={cn("animate-ads-fade-in flex items-start gap-3 rounded-xl border px-3.5 py-3 text-sm", s.soft, s.border, className)}>
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", s.icon)}>
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}
