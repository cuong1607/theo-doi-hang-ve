"use client";

// PRODUCT-ANALYTICS-3: daily trend of ONE product — dependency-free SVG in the
// Ads chart language (metric colour tokens → dark-mode safe, no raw colours).
//
//   Doanh số & Ads   Product Sales GMV · Ads Spend · Broad Ads Attribution GMV —
//                    all VND, ONE axis (same unit, honest scale); each series can
//                    be hidden so the smaller ones become readable. Broad GMV is
//                    dashed + labelled "attribution": it is not part of sales.
//   Đơn & số lượng   counts (own axis)
//   Hiệu quả Ads     Broad ROAS (ratio, own axis) — never on a VND axis
//
// Days the sales facts do not fully cover are gaps (never 0). Series are drawn
// side by side; nothing implies one causes the other. A data table is always
// available (screen readers / keyboard).
import { useId, useState } from "react";
import { cn } from "cn";

import { formatAxis, formatInt, formatRoas, formatVndFull } from "@/lib/channels/shopee/ads/metrics";
import type { ProductDailyRow } from "@/lib/product-analytics/types";
import { AdsSegmented } from "@/components/ads/ads-segmented";

type Mode = "money" | "counts" | "roas";
type Row = Omit<ProductDailyRow, "gmv" | "orders" | "units"> & { gmv: number | null; orders: number | null; units: number | null };

interface Series {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
  note?: string;
  value: (r: Row) => number | null;
  fmt: (v: number | null) => string;
}

const SERIES: Record<Mode, Series[]> = {
  money: [
    { key: "gmv", label: "Doanh số (đơn hàng)", color: "var(--metric-revenue)", value: (r) => r.gmv, fmt: formatVndFull },
    { key: "spend", label: "Chi Ads", color: "var(--metric-spend)", value: (r) => r.spend, fmt: formatVndFull },
    { key: "broad", label: "Broad GMV (attribution Ads)", color: "var(--metric-roas)", dashed: true, note: "attribution của Shopee Ads, không phải một phần của doanh số", value: (r) => r.broad_gmv, fmt: formatVndFull },
  ],
  counts: [
    { key: "orders", label: "Đơn hàng", color: "var(--metric-orders)", value: (r) => r.orders, fmt: formatInt },
    { key: "units", label: "Số lượng bán", color: "var(--metric-clicks)", dashed: true, value: (r) => r.units, fmt: formatInt },
  ],
  roas: [{ key: "roas", label: "ROAS Broad", color: "var(--metric-roas)", value: (r) => (r.spend > 0 ? r.broad_gmv / r.spend : null), fmt: formatRoas }],
};

const W = 760;
const H = 250;
const PAD = { l: 58, r: 14, t: 14, b: 30 };

export function PaTrendChart({ rows: daily, salesCoveredFrom, hasAds }: { rows: ProductDailyRow[]; salesCoveredFrom: string | null; hasAds: boolean }) {
  const rows: Row[] = daily.map((r) => (salesCoveredFrom !== null && r.report_date >= salesCoveredFrom ? r : { ...r, gmv: null, orders: null, units: null }));
  const uncovered = rows.filter((r) => r.gmv === null).length;
  const [mode, setMode] = useState<Mode>("money");
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const tableId = useId();
  const all = SERIES[mode].filter((s) => hasAds || mode === "counts" || s.key === "gmv");
  const series = all.filter((s) => !hidden[s.key]);
  const n = rows.length;
  const max = Math.max(mode === "roas" ? 1 : 1, ...rows.flatMap((r) => series.map((s) => s.value(r) ?? 0)));
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  // a gap (null) breaks the line: missing days are never drawn as 0
  const path = (s: Series) => {
    let d = "";
    let pen = false;
    rows.forEach((r, i) => {
      const v = s.value(r);
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const step = Math.max(1, Math.ceil(n / 8));
  const modes = [
    { value: "money" as const, label: "Doanh số & Ads" },
    { value: "counts" as const, label: "Đơn & SL" },
    ...(hasAds ? [{ value: "roas" as const, label: "Hiệu quả Ads" }] : []),
  ];

  return (
    <div className="space-y-3" data-slot="pa-trend">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AdsSegmented label="Chế độ biểu đồ" size="sm" options={modes} value={mode} onChange={(m) => setMode(m)} className="w-full sm:w-auto sm:min-w-80" />
        <button type="button" aria-expanded={table} aria-controls={tableId} onClick={() => setTable((t) => !t)} className="rounded text-xs font-medium text-ads-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          {table ? "Ẩn bảng số liệu" : "Xem dạng bảng"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Chọn đường hiển thị">
        {all.map((s) => {
          const off = !!hidden[s.key];
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={!off}
              onClick={() => setHidden((h) => ({ ...h, [s.key]: !off }))}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-[opacity,background-color] duration-(--ads-dur-fast) focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                off ? "border-ads-border text-muted-foreground opacity-60 line-through" : "border-ads-border bg-card",
              )}
              title={s.note}
            >
              <svg width="18" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="18" y2="3" style={{ stroke: s.color }} strokeWidth="2.5" strokeDasharray={s.dashed ? "4 3" : undefined} />
              </svg>
              {s.label}
            </button>
          );
        })}
      </div>

      <div className="relative w-full">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Xu hướng theo ngày: ${series.map((s) => s.label).join(", ")}. Xem dạng bảng để đọc số liệu.`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity="0.08" />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="currentColor" fillOpacity="0.6">
                {mode === "roas" ? `${t.toFixed(1)}x` : formatAxis(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) =>
            i % step === 0 || i === n - 1 ? (
              <text key={r.report_date} x={x(i)} y={H - 9} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.6">
                {r.report_date.slice(5)}
              </text>
            ) : null,
          )}
          {series.map((s) => (
            <path key={s.key} d={path(s)} fill="none" style={{ stroke: s.color }} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "6 4" : undefined} className="animate-ads-reveal" />
          ))}
          {hover !== null &&
            series.map((s) => {
              const v = s.value(rows[hover]);
              return v === null ? null : <circle key={s.key} cx={x(hover)} cy={y(v)} r="3.5" style={{ fill: s.color }} stroke="var(--card)" strokeWidth="1.5" />;
            })}
          {rows.map((r, i) => (
            <rect key={r.report_date} x={x(i) - (W - PAD.l - PAD.r) / Math.max(1, n) / 2} y={PAD.t} width={(W - PAD.l - PAD.r) / Math.max(1, n)} height={H - PAD.t - PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" strokeOpacity="0.25" />}
        </svg>
        {hover !== null && rows[hover] && (
          <div className="pointer-events-none absolute top-2 right-2 max-w-[16rem] rounded-lg border border-ads-border bg-popover p-2.5 text-xs shadow-md">
            <p className="mb-1 font-medium">{rows[hover].report_date}</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2 rounded-full" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="font-medium tabular-nums">{s.value(rows[hover]) === null ? "chưa đủ dữ liệu" : s.fmt(s.value(rows[hover]))}</span>
              </p>
            ))}
            {mode === "money" && hasAds && <p className="mt-1 text-[10px] text-muted-foreground">Broad GMV là attribution — không cộng / trừ với doanh số.</p>}
          </div>
        )}
      </div>

      {table && (
        <div id={tableId} className="max-h-80 overflow-auto rounded-lg border border-ads-border">
          <table className="w-full text-xs">
            <caption className="sr-only">Số liệu theo ngày</caption>
            <thead className="sticky top-0 bg-ads-surface-strong">
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="px-2 py-1.5">Ngày</th>
                <th scope="col" className="px-2 text-right">Doanh số</th>
                <th scope="col" className="px-2 text-right">Đơn</th>
                <th scope="col" className="px-2 text-right">SL</th>
                {hasAds && (
                  <>
                    <th scope="col" className="px-2 text-right">Chi Ads</th>
                    <th scope="col" className="px-2 text-right">Broad GMV</th>
                    <th scope="col" className="px-2 text-right">Click</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.report_date} className="border-t border-ads-border/70">
                  <th scope="row" className="px-2 py-1 text-left font-normal">{r.report_date}</th>
                  <td className="px-2 text-right tabular-nums">{r.gmv === null ? "—" : formatVndFull(r.gmv)}</td>
                  <td className="px-2 text-right tabular-nums">{r.orders === null ? "—" : formatInt(r.orders)}</td>
                  <td className="px-2 text-right tabular-nums">{r.units === null ? "—" : formatInt(r.units)}</td>
                  {hasAds && (
                    <>
                      <td className="px-2 text-right tabular-nums">{formatVndFull(r.spend)}</td>
                      <td className="px-2 text-right tabular-nums">{formatVndFull(r.broad_gmv)}</td>
                      <td className="px-2 text-right tabular-nums">{formatInt(r.clicks)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {uncovered > 0 && (
        <p className="text-xs text-muted-foreground">
          {uncovered === rows.length ? "Chưa có ngày nào đủ dữ liệu đơn hàng (chưa backfill) — chỉ hiển thị số liệu Ads." : `${uncovered} ngày chưa đủ dữ liệu đơn hàng — doanh số để trống, không phải 0.`}
        </p>
      )}
      <p className="text-xs text-muted-foreground">Các đường đặt cạnh nhau để quan sát — biểu đồ không thể hiện quan hệ nhân quả giữa quảng cáo và doanh số.</p>
    </div>
  );
}
