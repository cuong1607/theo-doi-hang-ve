"use client";

// SHOPEE-ADS-3A.1 "Hôm nay theo giờ": today's shop-level Ads activity per hour,
// 00h → the current hour (hours that have not happened are not drawn). The
// current hour is partial and marked "Đang diễn ra" (dashed band + dashed last
// segment). An hour Shopee did not return is a GAP (the line breaks), never a 0.
// Default view: Chi tiêu (line) + Doanh số Broad (area); other views one at a
// time. Every ratio comes from summed primitives (ratio-of-sums); CPC = chi
// tiêu / lượt nhấp. Observational only — no action is ever suggested.
// Dependency-free SVG, same visual language as AdsTrendChart.
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "cn";

import { adsDeltaPercent, formatAdsPercent, formatAxis, formatDelta, formatInt, formatRoas, formatVndFull } from "@/lib/channels/shopee/ads/metrics";
import type { AdsHourlyReconciliationStatus, AdsIntradayData, AdsIntradayHour, AdsMetricValues } from "@/lib/channels/shopee/ads/view-models";

import { AdsSegmented } from "./ads-segmented";
import { AdsEmptyState } from "./ads-states";

type Mode = "money" | "orders" | "clicks" | "roas";
type SeriesKey = "spend" | "revenue" | "directRevenue" | "orders" | "directOrders" | "clicks" | "roas";

const MODES: Array<{ value: Mode; label: string }> = [
  { value: "money", label: "Chi tiêu & Doanh số" },
  { value: "orders", label: "Đơn Broad / Direct" },
  { value: "clicks", label: "Lượt nhấp" },
  { value: "roas", label: "ROAS Broad" },
];

interface SeriesDef {
  key: SeriesKey;
  label: string;
  color: string;
  kind: "area" | "line" | "bar";
  fmt: (v: number | null) => string;
}

const SERIES: Record<SeriesKey, SeriesDef> = {
  revenue: { key: "revenue", label: "Doanh số Broad", color: "var(--metric-revenue)", kind: "area", fmt: formatVndFull },
  directRevenue: { key: "directRevenue", label: "Doanh số Direct", color: "var(--ads-accent)", kind: "line", fmt: formatVndFull },
  spend: { key: "spend", label: "Chi tiêu", color: "var(--metric-spend)", kind: "line", fmt: formatVndFull },
  orders: { key: "orders", label: "Đơn Broad", color: "var(--metric-orders)", kind: "bar", fmt: formatInt },
  directOrders: { key: "directOrders", label: "Đơn Direct", color: "var(--ads-accent)", kind: "line", fmt: formatInt },
  clicks: { key: "clicks", label: "Lượt nhấp", color: "var(--metric-clicks)", kind: "bar", fmt: formatInt },
  roas: { key: "roas", label: "ROAS Broad", color: "var(--metric-roas)", kind: "area", fmt: formatRoas },
};

const MODE_SERIES: Record<Mode, SeriesKey[]> = { money: ["revenue", "spend", "directRevenue"], orders: ["orders", "directOrders"], clicks: ["clicks"], roas: ["roas"] };
/** Off until the viewer turns it on (the default chart stays two series). */
const DEFAULT_HIDDEN: SeriesKey[] = ["directRevenue"];
const PAD = { l: 52, r: 12, t: 22, b: 26 };

const RECON: Record<AdsHourlyReconciliationStatus, { text: string; cls: string }> = {
  MATCH: { text: "khớp số liệu ngày", cls: "text-success-text" },
  ROUNDING_DIFFERENCE: { text: "khớp số liệu ngày (chi tiêu lệch vài đồng do làm tròn)", cls: "text-success-text" },
  MISMATCH: { text: "lệch so với số liệu ngày — cần kiểm tra", cls: "text-danger-text" },
  INSUFFICIENT_DATA: { text: "chưa đủ dữ liệu để đối chiếu", cls: "text-warning-text" },
  IN_PROGRESS: { text: "đang cập nhật", cls: "text-muted-foreground" },
};

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Smooth path; a null point breaks the line (gap, not 0). */
function segments(pts: Array<[number, number] | null>): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  for (const p of pts) {
    if (p) cur.push(p);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function smooth(pts: Array<[number, number]>): string {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  return d;
}

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "chưa có";
  const m = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
  return m < 1 ? "vừa xong" : m < 60 ? `${m} phút trước` : `${Math.floor(m / 60)} giờ ${m % 60} phút trước`;
}

const value = (h: AdsIntradayHour, k: SeriesKey, cumulative: boolean): number | null => {
  if (!h.metrics) return null;
  if (cumulative && k === "spend") return h.cumSpend;
  if (cumulative && k === "revenue") return h.cumRevenue;
  return (h.metrics[k] ?? null) as number | null;
};

function Comparison({ data }: { data: NonNullable<AdsIntradayData["sameHourYesterday"]> }) {
  const items: Array<{ label: string; key: keyof AdsMetricValues; fmt: (v: number | null) => string }> = [
    { label: "Chi tiêu", key: "spend", fmt: formatVndFull },
    { label: "Doanh số Broad", key: "revenue", fmt: formatVndFull },
    { label: "Đơn Broad", key: "orders", fmt: formatInt },
    { label: "ROAS Broad", key: "roas", fmt: formatRoas },
  ];
  return (
    <div className="rounded-lg border border-ads-border bg-ads-surface px-3 py-2 text-xs" data-slot="ads-intraday-compare">
      <p className="mb-1 text-muted-foreground">
        00h–{String(data.throughHour).padStart(2, "0")}h59 hôm nay so với cùng khung giờ hôm qua <span className="text-ads-muted">(chỉ giờ đã kết thúc)</span>
      </p>
      <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-4">
        {items.map((it) => {
          const t = data.today[it.key] as number | null;
          const y = data.yesterday[it.key] as number | null;
          const d = adsDeltaPercent(t, y);
          return (
            <li key={it.key} className="tabular-nums">
              <span className="text-muted-foreground">{it.label}:</span> <span className="font-medium">{it.fmt(t)}</span>{" "}
              {/* neutral: hourly traffic naturally varies — no good / bad colouring */}
              <span className="text-ads-muted">({d === null ? "—" : formatDelta(d)} vs {it.fmt(y)})</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AdsIntradayChart({ data, serverNow }: { data: AdsIntradayData; serverNow: string }) {
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [mode, setMode] = useState<Mode>("money");
  const [hidden, setHidden] = useState<SeriesKey[]>(DEFAULT_HIDDEN);
  const [cumulative, setCumulative] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const nowMs = Date.parse(serverNow);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const freshness = (
    <p className="text-xs text-muted-foreground" data-slot="ads-intraday-freshness" data-stale={data.freshness.stale ? "true" : "false"}>
      Cập nhật theo giờ {ago(data.freshness.lastSyncedAt, nowMs)}
      {data.freshness.stale && data.freshness.lastSyncedAt ? <span className="text-warning-text"> · chưa mới (mục tiêu ≤ {data.freshness.targetMinutes} phút)</span> : null}
    </p>
  );

  if (data.status !== "ok") {
    const copy = {
      disabled: { title: "Chưa bật dữ liệu theo giờ cho shop đã chọn.", description: "Quản trị viên bật “Theo giờ” cho từng shop trong mục Nguồn dữ liệu & kết nối." },
      empty: { title: "Chưa có dữ liệu theo giờ cho hôm nay.", description: "Dữ liệu theo giờ được đồng bộ nền cùng nhịp 15 phút — thử lại sau ít phút." },
      unavailable: { title: "Chưa đọc được dữ liệu theo giờ.", description: "Số liệu tổng quan theo ngày phía trên không bị ảnh hưởng." },
    }[data.status];
    return (
      <div data-slot="ads-intraday" data-status={data.status} className="space-y-2">
        <AdsEmptyState compact title={copy.title} description={copy.description} />
        {data.status === "empty" ? freshness : null}
      </div>
    );
  }

  const points = data.hours;
  const H = width < 640 ? 220 : 260;
  const W = width;
  const keys = MODE_SERIES[mode].filter((k) => !hidden.includes(k));
  const shown = keys.map((k) => SERIES[k]);
  const canCumulate = mode === "money";
  const cum = canCumulate && cumulative;
  const all = points.flatMap((p) => keys.map((k) => value(p, k, cum) ?? 0));
  const max = niceMax(Math.max(...all, 0) * 1.08);
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const band = innerW / Math.max(1, points.length);
  const cx = (i: number) => PAD.l + band * i + band / 2;
  const y = (v: number) => PAD.t + innerH - (Math.max(0, v) / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(points.length / (W < 640 ? 6 : 12)));
  const cur = points.length - 1;
  const ap = active !== null ? points[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(cx(active), 110), W - 110) : 0;
  const t = data.totals;

  const indexFromX = (clientX: number) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return null;
    return Math.min(points.length - 1, Math.max(0, Math.floor((clientX - rect.left - PAD.l) / band)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setActive(null);
    const at = active ?? cur;
    const to = ({ ArrowRight: Math.min(cur, at + (active === null ? 0 : 1)), ArrowLeft: Math.max(0, at - (active === null ? 0 : 1)), Home: 0, End: cur } as Record<string, number>)[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setActive(to);
  };

  return (
    <figure className="space-y-3" data-slot="ads-intraday" data-status="ok" data-mode={mode} data-current-hour={data.currentHour} data-hours={points.length}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <p className="tabular-nums" data-slot="ads-intraday-totals">
          <span className="text-muted-foreground">Đến {String(data.currentHour).padStart(2, "0")}h:</span> Chi tiêu <strong className="font-semibold">{formatVndFull(t.spend)}</strong> · Doanh số Broad{" "}
          <strong className="font-semibold">{formatVndFull(t.revenue)}</strong> · ROAS Broad <strong className="font-semibold">{formatRoas(t.roas)}</strong>
        </p>
        {freshness}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          <AdsSegmented
            options={MODES}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setHidden(DEFAULT_HIDDEN);
              setActive(null);
            }}
            label="Chỉ số theo giờ"
            size="sm"
            className="w-[34rem]"
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
                data-series={k}
                onClick={() => setHidden((h) => (on ? (keys.length > 1 ? [...h, k] : h) : h.filter((x) => x !== k)))}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-[opacity,background-color] duration-(--ads-dur-fast) focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default",
                  on ? "border-ads-border bg-card" : "border-dashed opacity-55",
                )}
              >
                <span aria-hidden="true" className={cn("inline-block h-2 w-3", s.kind === "line" ? "h-0.5 rounded-full" : "rounded-sm")} style={{ background: s.color }} />
                {s.label}
              </button>
            );
          })}
          {canCumulate && (
            <button
              type="button"
              aria-pressed={cumulative}
              data-action="cumulative"
              onClick={() => setCumulative((c) => !c)}
              className={cn("inline-flex items-center rounded-full border px-2.5 py-1 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", cumulative ? "border-ads-primary/40 bg-ads-primary/10 text-ads-primary-text" : "border-ads-border bg-card")}
            >
              Lũy kế
            </button>
          )}
        </div>
      </div>

      <div
        ref={wrap}
        tabIndex={0}
        role="group"
        aria-label="Biểu đồ hôm nay theo giờ. Dùng phím mũi tên để xem từng giờ."
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="relative rounded-xl focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        style={{ height: H }}
      >
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} className="block touch-pan-y select-none" role="img" aria-labelledby={`${id}-t`} onPointerMove={(e) => setActive(indexFromX(e.clientX))} onPointerLeave={() => setActive(null)}>
          <title id={`${id}-t`}>Hôm nay theo giờ, 00h đến {String(data.currentHour).padStart(2, "0")}h</title>
          <defs>
            {shown
              .filter((s) => s.kind === "area")
              .map((s) => (
                <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" style={{ stopColor: s.color, stopOpacity: 0.3 }} />
                  <stop offset="100%" style={{ stopColor: s.color, stopOpacity: 0 }} />
                </linearGradient>
              ))}
          </defs>
          {ticks.map((tk, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(tk)} y2={y(tk)} className="stroke-ads-border" strokeWidth={i === 0 ? 1.2 : 0.8} strokeDasharray={i === 0 ? undefined : "2 5"} />
              <text x={PAD.l - 8} y={y(tk) + 3.5} textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                {mode === "roas" ? `${formatAxis(tk)}x` : formatAxis(tk)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            // the current hour is always labelled; a regular label too close to it is dropped (no overlap)
            (i % labelEvery === 0 && (labelEvery === 1 || cur - i >= Math.ceil(labelEvery / 2))) || i === cur ? (
              <text key={p.hour} x={cx(i)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                {p.label}
              </text>
            ) : null,
          )}
          {/* current hour: dashed band + badge — still running, not a completed hour */}
          <g data-slot="ads-intraday-current">
            <rect x={PAD.l + band * cur + 1} y={PAD.t} width={Math.max(2, band - 2)} height={innerH} rx={4} strokeDasharray="4 3" strokeWidth={1} className="fill-ads-primary/5 stroke-ads-primary/50" />
            <text x={Math.min(cx(cur), W - PAD.r - 34)} y={PAD.t - 8} textAnchor="middle" className="text-[10px] font-medium" style={{ fill: "var(--ads-primary-text)" }}>
              Đang diễn ra
            </text>
          </g>
          {active !== null && active !== cur && <rect x={PAD.l + band * active} y={PAD.t} width={band} height={innerH} className="fill-ads-primary/6" />}
          {shown.map((s) => {
            if (s.kind === "bar") {
              const bw = Math.max(2, Math.min(22, band * 0.6));
              return (
                <g key={s.key}>
                  {points.map((p, i) => {
                    const v = value(p, s.key, cum);
                    if (v === null) return null;
                    return <rect key={p.hour} x={cx(i) - bw / 2} y={y(v)} width={bw} height={Math.max(0, PAD.t + innerH - y(v))} rx={Math.min(5, bw / 3)} style={{ fill: s.color, opacity: p.state === "current" ? 0.45 : active === null || active === i ? 0.9 : 0.5 }} />;
                  })}
                </g>
              );
            }
            const pts = points.map((p, i) => {
              const v = value(p, s.key, cum);
              return v === null ? null : ([cx(i), y(v)] as [number, number]);
            });
            // completed hours solid; the segment into the running hour dashed
            const doneSegs = segments(pts.slice(0, cur));
            const lastDone = pts.slice(0, cur).reverse().find(Boolean) ?? null;
            const curPt = pts[cur];
            return (
              <g key={s.key}>
                {doneSegs.map((seg, si) => (
                  <g key={si}>
                    {s.kind === "area" && seg.length > 1 && <path d={`${smooth(seg)} L${seg.at(-1)![0]},${PAD.t + innerH} L${seg[0][0]},${PAD.t + innerH} Z`} fill={`url(#${id}-${s.key})`} />}
                    {seg.length > 1 ? <path d={smooth(seg)} fill="none" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: s.color }} /> : <circle cx={seg[0][0]} cy={seg[0][1]} r={2.6} style={{ fill: s.color }} />}
                  </g>
                ))}
                {curPt && lastDone && lastDone === pts[cur - 1] && <path d={smooth([lastDone, curPt])} fill="none" strokeWidth={2} strokeDasharray="4 4" strokeLinecap="round" style={{ stroke: s.color }} />}
                {curPt && <circle cx={curPt[0]} cy={curPt[1]} r={3.2} strokeWidth={1.6} strokeDasharray="2 2" style={{ fill: "var(--card)", stroke: s.color }} />}
              </g>
            );
          })}
          {active !== null && (
            <line x1={cx(active)} x2={cx(active)} y1={PAD.t} y2={PAD.t + innerH} strokeDasharray="3 3" className="stroke-muted-foreground/50" pointerEvents="none" />
          )}
        </svg>

        {ap && (
          <div role="presentation" data-slot="ads-intraday-tooltip" className="animate-ads-pop pointer-events-none absolute top-1 z-10 min-w-52 -translate-x-1/2 rounded-xl border border-ads-border bg-popover/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm" style={{ left: tipLeft }}>
            <p className="mb-1 flex items-center justify-between gap-3 font-medium text-foreground">
              {ap.label}–{String(ap.hour).padStart(2, "0")}h59
              {ap.state === "current" ? <span className="rounded-full bg-ads-primary/12 px-1.5 py-0.5 text-[10px] text-ads-primary-text">Đang diễn ra</span> : null}
            </p>
            {!ap.metrics ? (
              <p className="text-muted-foreground">Shopee chưa trả số liệu cho giờ này.</p>
            ) : (
              <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
                {(
                  [
                    ["Chi tiêu", formatVndFull(ap.metrics.spend)],
                    ["Lượt hiển thị", formatInt(ap.metrics.impressions)],
                    ["Lượt nhấp", formatInt(ap.metrics.clicks)],
                    ["Đơn Broad", formatInt(ap.metrics.orders)],
                    ["Đơn Direct", formatInt(ap.metrics.directOrders)],
                    ["Doanh số Broad", formatVndFull(ap.metrics.revenue)],
                    ["Doanh số Direct", formatVndFull(ap.metrics.directRevenue)],
                    ["ROAS Broad", formatRoas(ap.metrics.roas)],
                    ["ROAS Direct", formatRoas(ap.metrics.directRoas)],
                    ["CPC", formatVndFull(ap.metrics.cpc)],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-medium text-foreground">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {ap.metrics && data.shops.enabled > 1 && ap.shops < data.shops.enabled ? <p className="mt-1 text-warning-text">Mới có {ap.shops}/{data.shops.enabled} shop cho giờ này.</p> : null}
          </div>
        )}
      </div>

      {data.sameHourYesterday ? <Comparison data={data.sameHourYesterday} /> : null}

      {data.peaks.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs" data-slot="ads-intraday-peaks" aria-label="Khung giờ nổi bật (chỉ để quan sát)">
          {data.peaks.map((p) => (
            <li key={p.key} className="rounded-full border border-ads-border bg-card px-2.5 py-1">
              <span className="text-muted-foreground">{p.label}:</span>{" "}
              <span className="font-medium tabular-nums">
                {String(p.hour).padStart(2, "0")}h ({p.key === "roas" ? formatRoas(p.value) : formatVndFull(p.value)})
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-ads-muted">
        Giờ {String(data.currentHour).padStart(2, "0")}h đang diễn ra nên số liệu chưa đủ; các giờ sau chưa diễn ra nên không hiển thị. Tổng quan phía trên vẫn lấy từ số liệu ngày của Shopee. CTR hôm nay {formatAdsPercent(data.totals.ctr)} (lượt nhấp / lượt hiển thị); CPC = chi tiêu / lượt nhấp.
        {data.reconciliation ? (
          <span data-slot="ads-intraday-recon" data-recon={data.reconciliation.status}>
            {" "}
            Đối chiếu hôm qua: <span className={RECON[data.reconciliation.status].cls}>{RECON[data.reconciliation.status].text}</span>.
          </span>
        ) : null}
      </p>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Xem số liệu theo giờ dạng bảng</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-ads-border">
          <table className="w-full text-left tabular-nums" data-slot="ads-intraday-table">
            <thead className="sticky top-0 bg-ads-surface-strong">
              <tr className="text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">Giờ</th>
                <th className="px-2 py-1.5 text-right font-medium">Chi tiêu</th>
                <th className="px-2 py-1.5 text-right font-medium">Hiển thị</th>
                <th className="px-2 py-1.5 text-right font-medium">Nhấp</th>
                <th className="px-2 py-1.5 text-right font-medium">Đơn Broad</th>
                <th className="px-2 py-1.5 text-right font-medium">Đơn Direct</th>
                <th className="px-2 py-1.5 text-right font-medium">Doanh số Broad</th>
                <th className="px-2 py-1.5 text-right font-medium">Doanh số Direct</th>
                <th className="px-2 py-1.5 text-right font-medium">ROAS Broad</th>
                <th className="px-2 py-1.5 text-right font-medium">CPC</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.hour} className="border-t border-ads-border" data-hour={p.hour} data-state={p.state} data-spend={p.metrics?.spend ?? ""} data-cpc={p.metrics?.cpc ?? ""}>
                  <td className="px-2 py-1">
                    {p.label}
                    {p.state === "current" ? <span className="ml-1 text-ads-primary-text">· đang diễn ra</span> : null}
                  </td>
                  {p.metrics ? (
                    <>
                      <td className="px-2 py-1 text-right">{formatVndFull(p.metrics.spend)}</td>
                      <td className="px-2 py-1 text-right">{formatInt(p.metrics.impressions)}</td>
                      <td className="px-2 py-1 text-right">{formatInt(p.metrics.clicks)}</td>
                      <td className="px-2 py-1 text-right">{formatInt(p.metrics.orders)}</td>
                      <td className="px-2 py-1 text-right">{formatInt(p.metrics.directOrders)}</td>
                      <td className="px-2 py-1 text-right">{formatVndFull(p.metrics.revenue)}</td>
                      <td className="px-2 py-1 text-right">{formatVndFull(p.metrics.directRevenue)}</td>
                      <td className="px-2 py-1 text-right">{formatRoas(p.metrics.roas)}</td>
                      <td className="px-2 py-1 text-right">{formatVndFull(p.metrics.cpc)}</td>
                    </>
                  ) : (
                    <td colSpan={9} className="px-2 py-1 text-muted-foreground">
                      Chưa có số liệu
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
