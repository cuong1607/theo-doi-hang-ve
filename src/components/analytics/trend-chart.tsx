"use client";

// SHOPEE-8: dependency-free SVG line chart with series toggles. Series are
// told apart by stroke style + label, not colour alone; every chart has a
// text summary (aria-label) and the raw numbers in a table (<details>).
// Values are numbers for geometry only — the displayed figures are the
// server-formatted strings passed in `display`.
import { useId, useState } from "react";
import { cn } from "cn";

export interface TrendSeries {
  key: string;
  label: string;
  color: string; // CSS colour (token var)
  dash?: string;
}

export interface TrendPointView {
  label: string;
  values: Record<string, number | null>;
  display: Record<string, string>;
}

const W = 720;
const H = 240;
const PAD = { l: 64, r: 12, t: 12, b: 28 };

function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1).replace(".", ",")} tỷ`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(".", ",")} tr`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n * 10) / 10).replace(".", ",");
}

export function TrendChart({
  title,
  points,
  series,
  defaultVisible,
  unit = "",
  emptyText = "Chưa có dữ liệu trong khoảng thời gian này.",
}: {
  title: string;
  points: TrendPointView[];
  series: TrendSeries[];
  defaultVisible?: string[];
  unit?: string;
  emptyText?: string;
}) {
  const id = useId();
  const [visible, setVisible] = useState<string[]>(defaultVisible ?? series.map((s) => s.key));
  const shown = series.filter((s) => visible.includes(s.key));
  const all = points.flatMap((p) => shown.map((s) => p.values[s.key]).filter((v): v is number => v !== null && Number.isFinite(v)));
  const hasData = all.length > 0;
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const span = max - min || 1;
  const x = (i: number) => PAD.l + (points.length <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (points.length - 1));
  const y = (v: number) => PAD.t + ((max - v) / span) * (H - PAD.t - PAD.b);
  const ticks = [0, 1, 2, 3, 4].map((i) => min + (span * i) / 4);
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  const summary = hasData
    ? shown
        .map((s) => {
          const vals = points.map((p) => p.values[s.key]).filter((v): v is number => v !== null);
          return vals.length ? `${s.label}: cao nhất ${compact(Math.max(...vals))}${unit}, thấp nhất ${compact(Math.min(...vals))}${unit}` : `${s.label}: chưa có dữ liệu`;
        })
        .join("; ")
    : emptyText;

  return (
    <figure className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs" role="group" aria-label={`Chọn đường hiển thị — ${title}`}>
        {series.map((s) => (
          <label key={s.key} className="inline-flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={visible.includes(s.key)}
              onChange={(e) => setVisible((v) => (e.target.checked ? [...v, s.key] : v.filter((k) => k !== s.key)))}
            />
            <svg width="22" height="8" aria-hidden="true">
              <line x1="1" y1="4" x2="21" y2="4" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dash} />
            </svg>
            {s.label}
          </label>
        ))}
      </div>
      {hasData ? (
        <div className="w-full overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-labelledby={`${id}-t ${id}-d`}>
            <title id={`${id}-t`}>{title}</title>
            <desc id={`${id}-d`}>{summary}</desc>
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={t === 0 ? 1.2 : 0.6} strokeDasharray={t === 0 ? undefined : "3 3"} />
                <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">
                  {compact(t)}
                  {unit}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % labelEvery === 0 || i === points.length - 1 ? (
                <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {p.label}
                </text>
              ) : null,
            )}
            {shown.map((s) => {
              const segs: string[][] = [[]];
              points.forEach((p, i) => {
                const v = p.values[s.key];
                if (v === null || !Number.isFinite(v)) segs.push([]);
                else segs[segs.length - 1].push(`${x(i)},${y(v)}`);
              });
              return (
                <g key={s.key}>
                  {segs
                    .filter((g) => g.length > 0)
                    .map((g, gi) => (g.length === 1 ? <circle key={gi} cx={g[0].split(",")[0]} cy={g[0].split(",")[1]} r={3} fill={s.color} /> : <polyline key={gi} points={g.join(" ")} fill="none" stroke={s.color} strokeWidth={2.2} strokeDasharray={s.dash} />))}
                  {points.map((p, i) => {
                    const v = p.values[s.key];
                    return v === null || !Number.isFinite(v) ? null : (
                      <circle key={i} cx={x(i)} cy={y(v)} r={points.length > 40 ? 0 : 2.5} fill={s.color}>
                        <title>{`${p.label} · ${s.label}: ${p.display[s.key] ?? v}`}</title>
                      </circle>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p>
      )}
      <figcaption className="sr-only">{summary}</figcaption>
      {hasData && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Xem số liệu dạng bảng</summary>
          <div className="mt-2 max-h-64 overflow-auto">
            <table className="w-full text-left tabular-nums">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Mốc</th>
                  {series.map((s) => (
                    <th key={s.key} className="py-1 pr-3 text-right font-medium">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {points.map((p, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1 pr-3">{p.label}</td>
                    {series.map((s) => (
                      <td key={s.key} className={cn("py-1 pr-3 text-right")}>
                        {p.display[s.key] ?? "—"}
                      </td>
                    ))}
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
