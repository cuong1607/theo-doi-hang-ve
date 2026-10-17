// SHOPEE-8 KPI card: label, one primary value, optional previous-period
// delta (semantic colour + arrow + text), coverage line, tooltip. Never more
// than that — details live in the sections below.
import { ArrowDownRight, ArrowUpRight, Info, Minus } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";

import { deltaTone, formatDelta, type MetricDirection } from "@/lib/analytics/periods";
import { Card, CardContent } from "@/components/ui/card";

const TONE_TEXT = { success: "text-success-text", danger: "text-danger-text", neutral: "text-muted-foreground" } as const;

export function KpiCard({
  label,
  value,
  sub,
  delta,
  direction = "neutral",
  previousLabel,
  hint,
  valueTone,
  href,
}: {
  label: string;
  value: React.ReactNode;
  /** Coverage / status line ("124 / 180 đơn đã final"). */
  sub?: React.ReactNode;
  delta?: number | null;
  direction?: MetricDirection;
  previousLabel?: string;
  hint?: string;
  valueTone?: "danger" | "success" | "warning";
  href?: string;
}) {
  const tone = deltaTone(delta ?? null, direction);
  const Arrow = delta === null || delta === undefined || delta === 0 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const body = (
    <Card size="sm" className={cn("h-full gap-1", href && "transition-colors hover:bg-muted/40")}>
      <CardContent className="space-y-1">
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          {label}
          {hint && (
            <span title={hint} className="inline-flex">
              <Info aria-hidden="true" className="size-3.5" />
              <span className="sr-only">{hint}</span>
            </span>
          )}
        </p>
        <p className={cn("text-xl font-semibold tabular-nums", valueTone === "danger" && "text-danger-text", valueTone === "success" && "text-success-text", valueTone === "warning" && "text-warning-text")}>{value}</p>
        {delta !== undefined && (
          <p className={cn("flex items-center gap-1 text-xs", TONE_TEXT[tone])}>
            <Arrow aria-hidden="true" className="size-3.5" />
            <span className="tabular-nums">{formatDelta(delta)}</span>
            <span className="text-muted-foreground">so với {previousLabel ?? "kỳ trước"}</span>
          </p>
        )}
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
      {body}
    </Link>
  ) : (
    body
  );
}

export function KpiGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>;
}
