// ============================================================
// SHOPEE-ADS-UI-1: Ads metric semantics + formatting (pure — unit tested).
//
//   ADS_METRIC_DEFS   label, tooltip definition, format, "which way is good"
//   deriveMetrics     totals → ROAS / ACOS / CTR / CPC / CR (null on ÷0)
//   adsDeltaTone      a rising number is NOT always good: ROAS ↑ good,
//                     ACOS / CPC ↑ bad, spend ↑ neutral unless revenue lags
//   formatAds*        vi-VN: 12,5 triệu ₫ · 12.542.300 ₫ · 4,82x · 3,42%
//
// Definitions are UI semantics for fixture data. SHOPEE-ADS-1 confirms
// them against the real API fields (e.g. which GMV Shopee attributes).
// ============================================================

import type { AdsMetricValues, AdsTotals } from "./view-models.ts";

export type AdsMetricKey = keyof AdsMetricValues;
export type AdsMetricFormat = "vnd" | "int" | "roas" | "pct1" | "pct2";
/** up = higher is better, down = lower is better, neutral = context-dependent. */
export type AdsMetricDirection = "up" | "down" | "neutral";
export type AdsDeltaTone = "good" | "bad" | "warning" | "neutral";

export interface AdsMetricDef {
  key: AdsMetricKey;
  label: string;
  short: string;
  format: AdsMetricFormat;
  direction: AdsMetricDirection;
  /** Concise definition shown in a tooltip (technical metrics only). */
  definition?: string;
}

export const ADS_METRIC_DEFS: Record<AdsMetricKey, AdsMetricDef> = {
  spend: { key: "spend", label: "Chi tiêu Ads", short: "Chi tiêu", format: "vnd", direction: "neutral", definition: "Tiền Shopee trừ cho quảng cáo trong kỳ" },
  revenue: { key: "revenue", label: "Doanh thu Ads", short: "Doanh thu", format: "vnd", direction: "up", definition: "Giá trị đơn được quy cho quảng cáo" },
  roas: { key: "roas", label: "ROAS", short: "ROAS", format: "roas", direction: "up", definition: "Doanh thu quảng cáo / Chi tiêu quảng cáo" },
  orders: { key: "orders", label: "Đơn hàng Ads", short: "Đơn hàng", format: "int", direction: "up", definition: "Đơn được quy cho quảng cáo" },
  clicks: { key: "clicks", label: "Clicks", short: "Clicks", format: "int", direction: "up", definition: "Số lần nhấp vào quảng cáo" },
  impressions: { key: "impressions", label: "Impressions", short: "Hiển thị", format: "int", direction: "up", definition: "Số lần quảng cáo được hiển thị" },
  ctr: { key: "ctr", label: "CTR", short: "CTR", format: "pct2", direction: "up", definition: "Clicks / Impressions" },
  cpc: { key: "cpc", label: "CPC", short: "CPC", format: "vnd", direction: "down", definition: "Chi tiêu / Clicks" },
  acos: { key: "acos", label: "ACOS", short: "ACOS", format: "pct1", direction: "down", definition: "Chi tiêu quảng cáo / Doanh thu quảng cáo" },
  conversionRate: { key: "conversionRate", label: "Tỷ lệ chuyển đổi", short: "CR", format: "pct2", direction: "up", definition: "Orders / Clicks" },
};

/**
 * Efficiency targets for the gauges — UI ASSUMPTION (fixture config), not a
 * business rule yet. A later phase can make them per-shop settings.
 */
export const ADS_TARGETS = {
  roas: 4,
  acos: 0.25,
  ctr: 0.025,
  cpc: 2000,
  conversionRate: 0.03,
} as const;

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function deriveMetrics(t: AdsTotals): AdsMetricValues {
  return {
    ...t,
    roas: ratio(t.revenue, t.spend),
    acos: ratio(t.spend, t.revenue),
    ctr: ratio(t.clicks, t.impressions),
    cpc: ratio(t.spend, t.clicks),
    conversionRate: ratio(t.orders, t.clicks),
  };
}

export const ZERO_TOTALS: AdsTotals = { spend: 0, revenue: 0, orders: 0, clicks: 0, impressions: 0 };

export function addTotals(a: AdsTotals, b: AdsTotals): AdsTotals {
  return {
    spend: a.spend + b.spend,
    revenue: a.revenue + b.revenue,
    orders: a.orders + b.orders,
    clicks: a.clicks + b.clicks,
    impressions: a.impressions + b.impressions,
  };
}

/** (current − previous) / |previous| × 100; null when not comparable (shown "—", never ∞). */
export function adsDeltaPercent(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** Below this |Δ%| a change is shown as flat (no colour judgement). */
export const FLAT_DELTA_PCT = 0.5;

/**
 * Semantic tone of a delta. `context.revenueDelta` lets spend be judged:
 * spend ↑ while revenue grows at least as fast → neutral; spend ↑ while
 * revenue lags / falls → warning. Spend ↓ is always neutral.
 */
export function adsDeltaTone(key: AdsMetricKey, delta: number | null, context: { revenueDelta?: number | null } = {}): AdsDeltaTone {
  if (delta === null || Math.abs(delta) < FLAT_DELTA_PCT) return "neutral";
  const dir = ADS_METRIC_DEFS[key].direction;
  if (dir === "up") return delta > 0 ? "good" : "bad";
  if (dir === "down") return delta < 0 ? "good" : "bad";
  if (key === "spend" && delta > 0) {
    const rev = context.revenueDelta;
    if (rev !== undefined && (rev === null || rev < delta)) return "warning";
  }
  return "neutral";
}

// ---------------- formatting (vi-VN) ----------------

export const ADS_EMPTY = "—";
const group = (n: number) => Math.round(n).toLocaleString("vi-VN");
const decimal = (n: number, digits: number) => n.toFixed(digits).replace(".", ",");
const trimZero = (s: string) => s.replace(/,0+$/, "");

/** 12.542.300 ₫ */
export function formatVndFull(n: number | null): string {
  return n === null || !Number.isFinite(n) ? ADS_EMPTY : `${group(n)} ₫`;
}

/** 12,5 triệu ₫ · 1,2 tỷ ₫ · below 1 triệu: full (850.000 ₫, 1.850 ₫). */
export function formatVndCompact(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return ADS_EMPTY;
  const a = Math.abs(n);
  if (a >= 1e9) return `${trimZero(decimal(n / 1e9, 2))} tỷ ₫`;
  if (a >= 1e6) return `${trimZero(decimal(n / 1e6, 1))} triệu ₫`;
  return formatVndFull(n);
}

/** 4,82x */
export function formatRoas(n: number | null): string {
  return n === null || !Number.isFinite(n) ? ADS_EMPTY : `${decimal(n, 2)}x`;
}

/** ratio 0.0342 → 3,42% (digits = 2) / 21,4% (digits = 1) */
export function formatAdsPercent(r: number | null, digits = 2): string {
  return r === null || !Number.isFinite(r) ? ADS_EMPTY : `${decimal(r * 100, digits)}%`;
}

export function formatInt(n: number | null): string {
  return n === null || !Number.isFinite(n) ? ADS_EMPTY : group(n);
}

/** Axis / chip compact: 12,5tr · 850k · 1,2 tỷ (no currency sign). */
export function formatAxis(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${trimZero(decimal(n / 1e9, 1))} tỷ`;
  if (a >= 1e6) return `${trimZero(decimal(n / 1e6, 1))}tr`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return trimZero(decimal(n, 1));
}

/** Main display value for a metric (compact for money). */
export function formatMetric(key: AdsMetricKey, v: number | null): string {
  switch (ADS_METRIC_DEFS[key].format) {
    case "vnd":
      return key === "cpc" ? formatVndFull(v) : formatVndCompact(v);
    case "int":
      return formatInt(v);
    case "roas":
      return formatRoas(v);
    case "pct1":
      return formatAdsPercent(v, 1);
    case "pct2":
      return formatAdsPercent(v, 2);
  }
}

/** Exact value for tooltips (money in full đồng). */
export function formatMetricDetailed(key: AdsMetricKey, v: number | null): string {
  return ADS_METRIC_DEFS[key].format === "vnd" ? formatVndFull(v) : formatMetric(key, v);
}

/** +12,4% / −3,1% / — */
export function formatDelta(delta: number | null): string {
  if (delta === null) return ADS_EMPTY;
  const s = decimal(Math.abs(delta), 1);
  return delta > 0 ? `+${s}%` : delta < 0 ? `−${s}%` : `${s}%`;
}

export type AdsTargetKey = keyof typeof ADS_TARGETS;

/** true = meets the (assumed) target, false = misses, null = no value. */
export function meetsTarget(key: AdsTargetKey, value: number | null): boolean | null {
  if (value === null || !Number.isFinite(value)) return null;
  return ADS_METRIC_DEFS[key].direction === "down" ? value <= ADS_TARGETS[key] : value >= ADS_TARGETS[key];
}

/** Gauge geometry: target sits at the middle of the bar; fill is clamped to [0, 1]. */
export function gaugeFill(key: AdsTargetKey, value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / (ADS_TARGETS[key] * 2)));
}
