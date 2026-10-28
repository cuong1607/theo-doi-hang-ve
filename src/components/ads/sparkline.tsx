// SHOPEE-ADS-UI-1: tiny decorative sparkline (aria-hidden — the card's
// number + delta carry the meaning). Pure SVG, server-renderable.
import { useId } from "react";
import { cn } from "cn";

export function Sparkline({ values, color, className, area = true }: { values: number[]; color: string; className?: string; area?: boolean }) {
  const id = useId();
  if (values.length < 2 || values.every((v) => v === 0)) return <div className={cn("h-8", className)} aria-hidden="true" />;
  const W = 100;
  const H = 32;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 3 - ((v - min) / span) * (H - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("h-8 w-full overflow-visible", className)} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${id}-g)`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
