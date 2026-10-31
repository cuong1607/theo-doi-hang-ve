"use client";

// PRODUCT-ANALYTICS-2: daily trend of ONE product — dependency-free SVG.
// Default: Doanh số (đơn hàng) vs Chi Ads vs Broad GMV (same VND axis).
// Other views: Đơn / Số lượng / Click / ROAS Broad (one axis each).
// Lines are drawn side by side — the chart never implies one causes the other.
import { useState } from "react";
import { cn } from "cn";

import { formatAxis, formatInt, formatRoas, formatVndFull } from "@/lib/channels/shopee/ads/metrics";
import type { ProductDailyRow } from "@/lib/product-analytics/types";

type Mode = "money" | "orders" | "units" | "clicks" | "roas";
const MODES: Array<{ value: Mode; label: string }> = [
  { value: "money", label: "Doanh số & Ads" },
  { value: "orders", label: "Đơn" },
  { value: "units", label: "Số lượng" },
  { value: "clicks", label: "Click Ads" },
  { value: "roas", label: "ROAS Broad" },
];

interface Series {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
  value: (r: ProductDailyRow) => number | null;
  fmt: (v: number | null) => string;
}

const SERIES: Record<Mode, Series[]> = {
  money: [
    { key: "gmv", label: "Doanh số (đơn hàng)", color: "var(--metric-revenue, #0ea5e9)", value: (r) => r.gmv, fmt: formatVndFull },
    { key: "spend", label: "Chi Ads", color: "var(--metric-spend, #f97316)", value: (r) => r.spend, fmt: formatVndFull },
    { key: "broad", label: "Broad GMV (attribution Ads)", color: "#8b5cf6", dashed: true, value: (r) => r.broad_gmv, fmt: formatVndFull },
  ],
  orders: [{ key: "orders", label: "Đơn", color: "#0ea5e9", value: (r) => r.orders, fmt: formatInt }],
  units: [{ key: "units", label: "Số lượng", color: "#0ea5e9", value: (r) => r.units, fmt: formatInt }],
  clicks: [{ key: "clicks", label: "Click Ads", color: "#f97316", value: (r) => r.clicks, fmt: formatInt }],
  roas: [{ key: "roas", label: "ROAS Broad", color: "#8b5cf6", value: (r) => (r.spend > 0 ? r.broad_gmv / r.spend : null), fmt: formatRoas }],
};

const W = 760;
const H = 240;
const PAD = { l: 56, r: 12, t: 12, b: 28 };

export function ProductTrendChart({ rows }: { rows: ProductDailyRow[] }) {
  const [mode, setMode] = useState<Mode>("money");
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const series = SERIES[mode];
  const n = rows.length;
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => s.value(r) ?? 0)));
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const path = (s: Series) =>
    rows
      .map((r, i) => ({ v: s.value(r), i }))
      .filter((p) => p.v !== null)
      .map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v as number).toFixed(1)}`)
      .join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const step = Math.max(1, Math.ceil(n / 8));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Chế độ biểu đồ">
        {MODES.map((m) => (
          <button key={m.value} type="button" role="tab" aria-selected={mode === m.value} onClick={() => setMode(m.value)} className={cn("rounded-full border px-3 py-1 text-xs", mode === m.value ? "bg-primary text-primary-foreground" : "bg-background")}>
            {m.label}
          </button>
        ))}
        <button type="button" onClick={() => setTable((t) => !t)} className="ml-auto text-xs underline">
          {table ? "Ẩn bảng" : "Xem số liệu dạng bảng"}
        </button>
      </div>
      <div className="flex flex-wrap gap-4 text-xs">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dashed ? "4 3" : undefined} /></svg>
            {s.label}
          </span>
        ))}
      </div>
      <div className="relative w-full overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[520px]" role="img" aria-label={`Xu hướng theo ngày: ${series.map((s) => s.label).join(", ")}`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity="0.08" />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="currentColor" fillOpacity="0.6">{mode === "roas" ? t.toFixed(1) : formatAxis(t)}</text>
            </g>
          ))}
          {rows.map((r, i) =>
            i % step === 0 || i === n - 1 ? (
              <text key={r.report_date} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.6">{r.report_date.slice(5)}</text>
            ) : null,
          )}
          {series.map((s) => (
            <path key={s.key} d={path(s)} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? "5 4" : undefined} />
          ))}
          {rows.map((r, i) => (
            <rect key={r.report_date} x={x(i) - (W - PAD.l - PAD.r) / Math.max(1, n) / 2} y={PAD.t} width={(W - PAD.l - PAD.r) / Math.max(1, n)} height={H - PAD.t - PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" strokeOpacity="0.3" />}
        </svg>
        {hover !== null && rows[hover] && (
          <div className="pointer-events-none absolute right-2 top-2 rounded-md border bg-popover p-2 text-xs shadow">
            <div className="font-medium">{rows[hover].report_date}</div>
            {series.map((s) => (
              <div key={s.key}>{s.label}: {s.fmt(s.value(rows[hover]))}</div>
            ))}
          </div>
        )}
      </div>
      {table && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1">Ngày</th><th className="text-right">Doanh số</th><th className="text-right">Đơn</th><th className="text-right">SL</th><th className="text-right">Chi Ads</th><th className="text-right">Broad GMV</th><th className="text-right">Click</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.report_date} className="border-t">
                  <td className="py-1">{r.report_date}</td>
                  <td className="text-right tabular-nums">{formatVndFull(r.gmv)}</td>
                  <td className="text-right tabular-nums">{formatInt(r.orders)}</td>
                  <td className="text-right tabular-nums">{formatInt(r.units)}</td>
                  <td className="text-right tabular-nums">{formatVndFull(r.spend)}</td>
                  <td className="text-right tabular-nums">{formatVndFull(r.broad_gmv)}</td>
                  <td className="text-right tabular-nums">{formatInt(r.clicks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Các đường được đặt cạnh nhau để quan sát — biểu đồ không thể hiện quan hệ nhân quả giữa quảng cáo và doanh số.</p>
    </div>
  );
}
