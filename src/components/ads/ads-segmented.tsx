"use client";

// SHOPEE-ADS-UI-1: pill segmented control with a sliding gradient
// indicator. Equal-width segments → the indicator is a pure CSS translate
// (no measuring, no layout shift). Keyboard: radiogroup with roving focus —
// ←/→ (and Home/End) move + select, Tab leaves the group.
import { useRef } from "react";
import { cn } from "cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export function AdsSegmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  size = "md",
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const n = options.length;

  const move = (to: number) => {
    const i = (to + n) % n;
    onChange(options[i].value);
    refs.current[i]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("relative grid rounded-full border border-ads-border bg-ads-surface-strong p-1", className)}
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden="true"
        className="ads-gradient-primary pointer-events-none absolute inset-y-1 left-1 rounded-full shadow-sm shadow-ads-primary/30 transition-transform duration-(--ads-dur-normal) ease-ads"
        style={{ width: `calc((100% - 0.5rem) / ${n})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o, i) => {
        const active = i === index;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const to = ({ ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
              if (to === undefined) return;
              e.preventDefault();
              move(to);
            }}
            className={cn(
              "relative z-10 rounded-full px-3 font-medium whitespace-nowrap transition-colors duration-(--ads-dur-fast) focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
              size === "sm" ? "h-7 text-xs" : "h-8 text-sm",
              active ? "text-white" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
