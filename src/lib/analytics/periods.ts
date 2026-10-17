// ============================================================
// PHASE SHOPEE-8: reporting periods (pure, no I/O).
//
// Business days are Vietnam calendar days (Asia/Ho_Chi_Minh, UTC+7, no DST)
// — the SQL side buckets with analytics_tz(); this file only does date
// arithmetic on YYYY-MM-DD strings (never money).
//   resolvePeriod   preset / custom → { from, to } (inclusive VN days)
//   previousPeriod  the equivalent period right before (same length;
//                   "this month" → same days of the previous month)
//   chooseBucket    hour (≤ 2 days) / day (≤ 92) / week (≤ 370) / month
//   deltaPercent    (current − previous) / |previous| × 100, null when
//                   previous is 0 / missing (shown "—", never ∞)
//   deltaTone       semantic: up is good for profit, bad for returns
// ============================================================

export const PERIOD_PRESETS = ["today", "yesterday", "7d", "30d", "this_month", "last_month", "custom"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  today: "Hôm nay",
  yesterday: "Hôm qua",
  "7d": "7 ngày qua",
  "30d": "30 ngày qua",
  this_month: "Tháng này",
  last_month: "Tháng trước",
  custom: "Tuỳ chọn",
};

export interface Period {
  preset: PeriodPreset;
  from: string;
  to: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VN_OFFSET_MS = 7 * 3_600_000;

/** Today as a VN calendar day. */
export function vnToday(now: Date = new Date()): string {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive number of days in [from, to]. */
export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1;
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const lastDayOfMonth = (day: string) => {
  const d = new Date(`${monthStart(day)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};
const shiftMonth = (day: string, n: number) => {
  const d = new Date(`${monthStart(day)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

export const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
export const isPeriodPreset = (v: unknown): v is PeriodPreset => typeof v === "string" && (PERIOD_PRESETS as readonly string[]).includes(v);

/** Max custom range (keeps every query bounded). */
export const MAX_PERIOD_DAYS = 366;

export function resolvePeriod(input: { preset?: string; from?: string; to?: string }, now: Date = new Date(), fallback: PeriodPreset = "today"): Period {
  const today = vnToday(now);
  const preset: PeriodPreset = isPeriodPreset(input.preset) ? input.preset : input.from || input.to ? "custom" : fallback;
  switch (preset) {
    case "today":
      return { preset, from: today, to: today };
    case "yesterday":
      return { preset, from: addDays(today, -1), to: addDays(today, -1) };
    case "7d":
      return { preset, from: addDays(today, -6), to: today };
    case "30d":
      return { preset, from: addDays(today, -29), to: today };
    case "this_month":
      return { preset, from: monthStart(today), to: today };
    case "last_month": {
      const start = shiftMonth(today, -1);
      return { preset, from: start, to: lastDayOfMonth(start) };
    }
    case "custom": {
      let from = isDay(input.from) ? input.from : today;
      let to = isDay(input.to) ? input.to : from;
      if (from > to) [from, to] = [to, from];
      if (daysBetween(from, to) > MAX_PERIOD_DAYS) from = addDays(to, -(MAX_PERIOD_DAYS - 1));
      return { preset, from, to };
    }
  }
}

/** Equivalent previous period (same length; month presets → same days of the previous month). */
export function previousPeriod(p: Period): { from: string; to: string } {
  if (p.preset === "this_month") {
    const prevStart = shiftMonth(p.from, -1);
    const sameDay = addDays(prevStart, daysBetween(p.from, p.to) - 1);
    const end = lastDayOfMonth(prevStart);
    return { from: prevStart, to: sameDay > end ? end : sameDay };
  }
  if (p.preset === "last_month") {
    const prevStart = shiftMonth(p.from, -1);
    return { from: prevStart, to: lastDayOfMonth(prevStart) };
  }
  const len = daysBetween(p.from, p.to);
  return { from: addDays(p.from, -len), to: addDays(p.from, -1) };
}

export type Bucket = "hour" | "day" | "week" | "month";

/** Chart granularity: never hundreds of points. */
export function chooseBucket(from: string, to: string): Bucket {
  const days = daysBetween(from, to);
  if (days <= 2) return "hour";
  if (days <= 92) return "day";
  if (days <= 370) return "week";
  return "month";
}

/**
 * Percent change of two decimal strings (display only — the values come
 * from NUMERIC sums; the ratio is a presentation figure, one decimal).
 */
export function deltaPercent(current: string | number | null | undefined, previous: string | number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  const c = Number(current);
  const p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return Math.round(((c - p) / Math.abs(p)) * 1000) / 10;
}

/** Whether "up" is good for a metric (profit) or bad (returns, mismatches). */
export type MetricDirection = "up_good" | "up_bad" | "neutral";

export function deltaTone(delta: number | null, direction: MetricDirection): "success" | "danger" | "neutral" {
  if (delta === null || delta === 0 || direction === "neutral") return "neutral";
  const up = delta > 0;
  return (direction === "up_good") === up ? "success" : "danger";
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return "—";
  return `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}

/** Coverage "70 / 100 đơn (70%)". */
export function coverageText(have: number, total: number, unit = "đơn"): string {
  if (total === 0) return `0 ${unit}`;
  const pct = Math.round((have / total) * 100);
  return `${have.toLocaleString("vi-VN")} / ${total.toLocaleString("vi-VN")} ${unit} (${pct}%)`;
}

export const coverageRatio = (have: number, total: number) => (total === 0 ? null : have / total);
