"use client";

// SHOPEE-ADS-UI-1: subtle number transition. The first render shows the
// final value (no count-up on page load); when the value CHANGES (filter /
// refresh) it counts from the old value to the new one in ~450 ms.
// Reduced motion → instant. The accessible text is always the final value.
import { useEffect, useRef, useState } from "react";

import { formatMetric, type AdsMetricKey } from "@/lib/channels/shopee/ads/metrics";

import { useReducedMotion } from "./use-reduced-motion";

const DURATION = 450;

export function AnimatedNumber({ metric, value, className }: { metric: AdsMetricKey; value: number | null; className?: string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (reduced || value === null || start === null || start === value) {
      frame.current = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(frame.current);
    }
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(p >= 1 ? value : start + (value - start) * eased);
      if (p < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, reduced]);

  return (
    <span className={className} data-value={value ?? ""}>
      <span aria-hidden="true">{formatMetric(metric, reduced ? value : shown)}</span>
      <span className="sr-only">{formatMetric(metric, value)}</span>
    </span>
  );
}
