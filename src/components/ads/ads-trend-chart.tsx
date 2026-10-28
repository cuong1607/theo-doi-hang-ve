"use client";

// SHOPEE-ADS-UI-1 performance trend: dependency-free SVG (no chart lib in
// the bundle). Default view = Chi tiêu vs Doanh thu (same VND axis);
// Đơn hàng / ROAS / Clicks are separate views — never more than two series
// at once. Revenue = filled area, spend = line (style differs, not only
// colour). Hover / ←→ keys move a crosshair + tooltip; first mount reveals
// left→right once, later data changes only crossfade. Text summary +
// "Xem số liệu dạng bảng" for screen readers.
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "cn";

import { ADS_TARGETS, formatAxis, formatInt, formatRoas, formatVndFull } from "@/lib/channels/shopee/ads/metrics";
import type { AdsTrendPoint } from "@/lib/channels/shopee/ads/view-models";

import { AdsSegmented } from "./ads-segmented";
import { AdsEmptyState } from "./ads-states";

type Mode = "money" | "orders" | "roas" | "clicks";
type SeriesKey = "spend" | "revenue" | "orders" | "roas" | "clicks";

const MODES: Array<{ value: Mode; label: string }> = [
  { value: "money", label: "Chi tiêu & Doanh thu" },
  { value: "orders", label: "Đơn hàng" },
  { value: "roas", label: "ROAS" },
  { value: "clicks", label: "Clicks" },
];

interface SeriesDef {
  key: SeriesKey;
  label: string;
  color: string;
  kind: "area" | "line" | "bar";
  fmt: (v: number | null) => string;
}

const SERIES: Record<SeriesKey, SeriesDef> = {
  revenue: { key: "revenue", label: "Doanh thu", color: "var(--metric-revenue)", kind: "area", fmt: formatVndFull },
  spend: { key: "spend", label: "Chi tiêu", color: "var(--metric-spend)", kind: "line", fmt: formatVndFull },
  orders: { key: "orders", label: "Đơn hàng", color: "var(--metric-orders)", kind: "bar", fmt: formatInt },
  roas: { key: "roas", label: "ROAS", color: "var(--metric-roas)", kind: "area", fmt: formatRoas },
  clicks: { key: "clicks", label: "Clicks", color: "var(--metric-clicks)", kind: "bar", fmt: formatInt },
};

const MODE_SERIES: Record<Mode, SeriesKey[]> = { money: ["revenue", "spend"], orders: ["orders"], roas: ["roas"], clicks: ["clicks"] };
const PAD = { l: 52, r: 12, t: 16, b: 26 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Smooth path with horizontal tangents (no overshoot below 0). */
function smoothPath(pts: Array<[number, number]>): string {
  if (!pts.length) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  return d;
}

export function AdsTrendChart({ points, granularity }: { points: AdsTrendPoint[]; granularity: "hour" | "day" | "week" }) {
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [mode, setMode] = useState<Mode>("money");
  const [hidden, setHidden] = useState<SeriesKey[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = width < 640 ? 220 : 280;
  const W = width;
  const keys = MODE_SERIES[mode].filter((k) => !hidden.includes(k));
  const shown = keys.map((k) => SERIES[k]);
  const val = (p: AdsTrendPoint, k: SeriesKey) => (p[k] ?? null) as number | null;
  const all = points.flatMap((p) => keys.map((k) => val(p, k) ?? 0));
  const hasData = points.length > 0 && points.some((p) => p.spend > 0 || p.revenue > 0 || p.clicks > 0);
  const max = niceMax(Math.max(...all, mode === "roas" ? ADS_TARGETS.roas : 0) * 1.08);
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const band = innerW / Math.max(1, points.length);
  const cx = (i: number) => PAD.l + band * i + band / 2;
  const y = (v: number) => PAD.t + innerH - (Math.max(0, v) / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(points.length / (W < 640 ? 5 : 9)));
  const dataKey = `${mode}|${hidden.join(",")}|${points.length}|${points[0]?.key ?? ""}|${points.at(-1)?.key ?? ""}`;

  const summary = hasData
    ? shown
        .map((s) => {
          const vals = points.map((p) => val(p, s.key)).filter((v): v is number => v !== null);
          return vals.length ? `${s.label}: cao nhất ${s.fmt(Math.max(...vals))}, thấp nhất ${s.fmt(Math.min(...vals))}` : `${s.label}: chưa có dữ liệu`;
        })
        .join("; ")
    : "Chưa có dữ liệu trong khoảng thời gian này.";

  const indexFromX = (clientX: number) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return null;
    const i = Math.floor((clientX - rect.left - PAD.l) / band);
    return Math.min(points.length - 1, Math.max(0, i));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!points.length) return;
    if (e.key === "Escape") return setActive(null);
    const last = points.length - 1;
    const cur = active ?? last;
    const step = active === null ? 0 : 1;
    const to = ({ ArrowRight: Math.min(last, cur + step), ArrowLeft: Math.max(0, cur - step), Home: 0, End: last } as Record<string, number>)[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setActive(to);
  };

  const ap = active !== null ? points[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(cx(active), 90), W - 90) : 0;

  return (
    <figure className="space-y-3" data-slot="ads-trend-chart" data-mode={mode}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
        <AdsSegmented
          options={MODES}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setHidden([]);
            setActive(null);
          }}
          label="Chỉ số trên biểu đồ"
          size="sm"
          className="w-[36rem]"
        />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Chú thích">
          {MODE_SERIES[mode].map((k) => {
            const s = SERIES[k];
            const on = !hidden.includes(k);
            const canToggle = MODE_SERIES[mode].length > 1;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                disabled={!canToggle}
                onClick={() => setHidden((h) => (on ? (keys.length > 1 ? [...h, k] : h) : h.filter((x) => x !== k)))}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-[opacity,background-color] duration-(--ads-dur-fast) focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default",
                  on ? "border-ads-border bg-card" : "border-dashed opacity-55",
                )}
              >
                <svg width="16" height="10" aria-hidden="true">
                  {s.kind === "bar" ? (
                    <rect x="3" y="1" width="10" height="8" rx="2" style={{ fill: s.color }} />
                  ) : s.kind === "area" ? (
                    <>
                      <rect x="0" y="4" width="16" height="6" rx="1" style={{ fill: s.color, opacity: 0.25 }} />
                      <line x1="0" y1="4" x2="16" y2="4" strokeWidth="2.5" style={{ stroke: s.color }} />
                    </>
                  ) : (
                    <>
                      <line x1="0" y1="5" x2="16" y2="5" strokeWidth="2.5" style={{ stroke: s.color }} />
                      <circle cx="8" cy="5" r="2.6" style={{ fill: "var(--card)", stroke: s.color }} strokeWidth="1.6" />
                    </>
                  )}
                </svg>
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={wrap}
        tabIndex={hasData ? 0 : -1}
        role="group"
        aria-label={`Biểu đồ xu hướng ${granularity === "hour" ? "theo giờ" : granularity === "week" ? "theo tuần" : "theo ngày"}. Dùng phím mũi tên để xem từng mốc.`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="relative rounded-xl focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        style={{ height: H }}
      >
        {!hasData ? (
          <AdsEmptyState compact title="Chưa có dữ liệu quảng cáo trong khoảng thời gian này." description="Thử chọn khoảng thời gian dài hơn hoặc bỏ bớt bộ lọc." />
        ) : (
          <>
            <svg
              width="100%"
              height={H}
              viewBox={`0 0 ${W} ${H}`}
              className="block touch-pan-y select-none"
              role="img"
              aria-labelledby={`${id}-t ${id}-d`}
              onPointerMove={(e) => setActive(indexFromX(e.clientX))}
              onPointerLeave={() => setActive(null)}
            >
              <title id={`${id}-t`}>Xu hướng hiệu quả quảng cáo</title>
              <desc id={`${id}-d`}>{summary}</desc>
              <defs>
                {shown
                  .filter((s) => s.kind === "area")
                  .map((s) => (
                    <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" style={{ stopColor: s.color, stopOpacity: 0.32 }} />
                      <stop offset="100%" style={{ stopColor: s.color, stopOpacity: 0 }} />
                    </linearGradient>
                  ))}
              </defs>
              {ticks.map((t, i) => (
                <g key={i}>
                  <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-ads-border" strokeWidth={i === 0 ? 1.2 : 0.8} strokeDasharray={i === 0 ? undefined : "2 5"} />
                  <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                    {mode === "roas" ? `${formatAxis(t)}x` : formatAxis(t)}
                  </text>
                </g>
              ))}
              {points.map((p, i) =>
                i % labelEvery === 0 || i === points.length - 1 ? (
                  <text key={p.key} x={cx(i)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                    {p.label}
                  </text>
                ) : null,
              )}
              {mode === "roas" && (
                <g>
                  <line x1={PAD.l} x2={W - PAD.r} y1={y(ADS_TARGETS.roas)} y2={y(ADS_TARGETS.roas)} strokeDasharray="6 4" strokeWidth={1.2} style={{ stroke: "var(--ads-primary)" }} />
                  <text x={W - PAD.r} y={y(ADS_TARGETS.roas) - 5} textAnchor="end" className="text-[10px] font-medium" style={{ fill: "var(--ads-primary-text)" }}>
                    Mục tiêu {formatRoas(ADS_TARGETS.roas)}
                  </text>
                </g>
              )}
              {active !== null && <rect x={PAD.l + band * active} y={PAD.t} width={band} height={innerH} className="fill-ads-primary/6" />}

              <g key={dataKey} className={entered ? "animate-ads-fade-in" : "animate-ads-reveal"} onAnimationEnd={() => setEntered(true)}>
                {shown.map((s) => {
                  if (s.kind === "bar") {
                    const bw = Math.max(2, Math.min(28, band * 0.62));
                    return (
                      <g key={s.key}>
                        {points.map((p, i) => {
                          const v = val(p, s.key) ?? 0;
                          return <rect key={p.key} x={cx(i) - bw / 2} y={y(v)} width={bw} height={Math.max(0, PAD.t + innerH - y(v))} rx={Math.min(6, bw / 3)} style={{ fill: s.color, opacity: active === null || active === i ? 0.9 : 0.45 }} className="transition-opacity duration-(--ads-dur-fast)" />;
                        })}
                      </g>
                    );
                  }
                  const pts = points.map((p, i) => [cx(i), y(val(p, s.key) ?? 0)] as [number, number]);
                  const line = smoothPath(pts);
                  return (
                    <g key={s.key}>
                      {s.kind === "area" && <path d={`${line} L${pts.at(-1)![0]},${PAD.t + innerH} L${pts[0][0]},${PAD.t + innerH} Z`} fill={`url(#${id}-${s.key})`} />}
                      <path d={line} fill="none" strokeWidth={s.kind === "area" ? 2.4 : 2.2} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: s.color }} />
                      {s.kind === "line" && points.length <= 31 && pts.map(([x0, y0], i) => <circle key={i} cx={x0} cy={y0} r={2.6} strokeWidth={1.6} style={{ fill: "var(--card)", stroke: s.color }} />)}
                    </g>
                  );
                })}
              </g>

              {active !== null && (
                <g pointerEvents="none">
                  <line x1={cx(active)} x2={cx(active)} y1={PAD.t} y2={PAD.t + innerH} strokeDasharray="3 3" className="stroke-muted-foreground/50" />
                  {shown
                    .filter((s) => s.kind !== "bar")
                    .map((s) => (
                      <circle key={s.key} cx={cx(active)} cy={y(val(points[active], s.key) ?? 0)} r={4.5} strokeWidth={2.2} style={{ fill: "var(--card)", stroke: s.color }} />
                    ))}
                </g>
              )}
            </svg>

            {ap && (
              <div
                role="presentation"
                className="animate-ads-pop pointer-events-none absolute top-1 z-10 min-w-40 -translate-x-1/2 rounded-xl border border-ads-border bg-popover/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm transition-[left] duration-(--ads-dur-fast) ease-ads"
                style={{ left: tipLeft }}
              >
                <p className="mb-1 font-medium text-foreground">{ap.label}</p>
                {shown.map((s) => (
                  <p key={s.key} className="flex items-center justify-between gap-4 tabular-nums">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span aria-hidden="true" className="size-2 rounded-full" style={{ background: s.color }} />
                      {s.label}
                    </span>
                    <span className="font-medium text-foreground">{s.fmt(val(ap, s.key))}</span>
                  </p>
                ))}
                {mode === "money" && (
                  <p className="mt-1 flex justify-between gap-4 border-t border-ads-border pt-1 text-muted-foreground tabular-nums">
                    ROAS <span className="font-medium text-foreground">{formatRoas(ap.roas)}</span>
                  </p>
                )}
              </div>
            )}
            <p className="sr-only" aria-live="polite">
              {ap ? `${ap.label}: ${shown.map((s) => `${s.label} ${s.fmt(val(ap, s.key))}`).join(", ")}` : ""}
            </p>
          </>
        )}
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
      {hasData && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Xem số liệu dạng bảng</summary>
          <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-ads-border">
            <table className="w-full text-left tabular-nums">
              <thead className="sticky top-0 bg-ads-surface-strong">
                <tr className="text-muted-foreground">
                  <th className="px-2 py-1.5 font-medium">Mốc</th>
                  <th className="px-2 py-1.5 text-right font-medium">Chi tiêu</th>
                  <th className="px-2 py-1.5 text-right font-medium">Doanh thu</th>
                  <th className="px-2 py-1.5 text-right font-medium">Đơn</th>
                  <th className="px-2 py-1.5 text-right font-medium">Clicks</th>
                  <th className="px-2 py-1.5 text-right font-medium">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.key} className="border-t border-ads-border">
                    <td className="px-2 py-1">{p.label}</td>
                    <td className="px-2 py-1 text-right">{formatVndFull(p.spend)}</td>
                    <td className="px-2 py-1 text-right">{formatVndFull(p.revenue)}</td>
                    <td className="px-2 py-1 text-right">{formatInt(p.orders)}</td>
                    <td className="px-2 py-1 text-right">{formatInt(p.clicks)}</td>
                    <td className="px-2 py-1 text-right">{formatRoas(p.roas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}
