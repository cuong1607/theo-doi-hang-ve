// UIUX-1 MetricCard: one KPI — label, value (tabular, large), small context.
// Only a meaningful state is coloured (loss, mismatch, missing data), never
// every number.
import type { LucideIcon } from "lucide-react";
import { cn } from "cn";

import { Card, CardContent } from "@/components/ui/card";
import { TONE_TEXT_CLASS, type Tone } from "@/lib/ui/status";

export function MetricCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon: Icon,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <Card size="sm" className={cn("gap-1", className)}>
      <CardContent className="space-y-1">
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
          {label}
        </p>
        <p className={cn("text-2xl font-semibold tracking-tight tabular-nums", TONE_TEXT_CLASS[tone])}>{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function MetricGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6", className)}>{children}</div>;
}
