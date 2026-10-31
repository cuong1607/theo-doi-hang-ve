// ============================================================
// PRODUCT-ANALYTICS-2: comparison periods (spec §35, §40–41). Pure.
//
//   today      partial: both days are cut at the same COMPLETED VN hour
//              (orders created before HH:00; Ads hourly rows with hour < HH)
//   yesterday  vs the day before
//   7d / 30d   the last N COMPLETED days (ending yesterday) vs the N days before —
//              never a partial today against full days
//   custom     equal-length previous period; a multi-day range that includes
//              today is flagged partial (no same-time logic → no comparison signals)
// ============================================================
import { addDays, daysBetween, isDay, MAX_PERIOD_DAYS, vnToday } from "../analytics/periods.ts";

export const PRODUCT_PERIOD_PRESETS = ["today", "yesterday", "7d", "30d", "custom"] as const;
export type ProductPeriodPreset = (typeof PRODUCT_PERIOD_PRESETS)[number];

export const PRODUCT_PERIOD_LABELS: Record<ProductPeriodPreset, string> = {
  today: "Hôm nay",
  yesterday: "Hôm qua",
  "7d": "7 ngày",
  "30d": "30 ngày",
  custom: "Tùy chỉnh",
};

export interface ProductPeriod {
  preset: ProductPeriodPreset;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  /** The range contains today (not finished). */
  partialToday: boolean;
  /** today only: completed VN hours compared on both days (0 = nothing comparable yet). */
  hourCutoff: number | null;
}

export function isProductPeriodPreset(v: unknown): v is ProductPeriodPreset {
  return typeof v === "string" && (PRODUCT_PERIOD_PRESETS as readonly string[]).includes(v);
}

function vnHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hourCycle: "h23" }).format(now));
}

export function resolveProductPeriod(input: { preset?: string; from?: string; to?: string }, now: Date = new Date(), fallback: ProductPeriodPreset = "7d"): ProductPeriod {
  const today = vnToday(now);
  const yesterday = addDays(today, -1);
  const preset: ProductPeriodPreset = isProductPeriodPreset(input.preset) ? input.preset : input.from || input.to ? "custom" : fallback;
  const shift = (from: string, to: string, partialToday = false, hourCutoff: number | null = null): ProductPeriod => {
    const len = daysBetween(from, to);
    return { preset, from, to, prevFrom: addDays(from, -len), prevTo: addDays(from, -1), partialToday, hourCutoff };
  };
  switch (preset) {
    case "today":
      return shift(today, today, true, vnHour(now));
    case "yesterday":
      return shift(yesterday, yesterday);
    case "7d":
      return shift(addDays(yesterday, -6), yesterday);
    case "30d":
      return shift(addDays(yesterday, -29), yesterday);
    case "custom": {
      let from = isDay(input.from) ? input.from : yesterday;
      let to = isDay(input.to) ? input.to : from;
      if (from > to) [from, to] = [to, from];
      if (to > today) to = today;
      if (from > to) from = to;
      if (daysBetween(from, to) > MAX_PERIOD_DAYS) from = addDays(to, -(MAX_PERIOD_DAYS - 1));
      if (from === today && to === today) return { ...shift(today, today, true, vnHour(now)), preset };
      return shift(from, to, to === today, null);
    }
  }
}
