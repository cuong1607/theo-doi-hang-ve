// ============================================================
// AI ASSISTANT — time periods in Asia/Ho_Chi_Minh (UTC+7, no DST), resolved
// on the SERVER from the real clock. The model is never asked what "today" is.
//
//   explicit UI preset / dates  >  words in the question  >  default (7 days)
//
// Weeks start on Monday (Vietnamese convention). "đến" dates are inclusive.
// ============================================================
import { foldVi } from "./text.ts";

export const MAX_PERIOD_DAYS = 92;
const DAY = 86_400_000;
const VN = 7 * 3_600_000;

export type PeriodPreset = "today" | "yesterday" | "this_week" | "last_week" | "last_7_days" | "last_30_days" | "this_month" | "last_month" | "custom";

export interface Period {
  preset: PeriodPreset;
  /** inclusive VN dates YYYY-MM-DD */
  fromDate: string;
  toDate: string;
  /** UTC instants: [start, end) */
  start: Date;
  end: Date;
  label: string;
  source: "ui" | "question" | "default";
}

const vnDate = (d: Date) => new Date(d.getTime() + VN).toISOString().slice(0, 10);
const startOfVnDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - VN);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const fmt = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

function make(preset: PeriodPreset, fromDate: string, toDate: string, source: Period["source"], label?: string): Period {
  return { preset, fromDate, toDate, start: startOfVnDay(fromDate), end: startOfVnDay(addDays(toDate, 1)), label: label ?? (fromDate === toDate ? fmt(fromDate) : `${fmt(fromDate)} – ${fmt(toDate)}`), source };
}

export function presetPeriod(preset: Exclude<PeriodPreset, "custom">, now: Date, source: Period["source"] = "ui"): Period {
  const today = vnDate(now);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  switch (preset) {
    case "today":
      return make(preset, today, today, source, `Hôm nay (${fmt(today)})`);
    case "yesterday": {
      const y = addDays(today, -1);
      return make(preset, y, y, source, `Hôm qua (${fmt(y)})`);
    }
    case "this_week":
      return make(preset, addDays(today, -dow), today, source, `Tuần này (${fmt(addDays(today, -dow))} – ${fmt(today)})`);
    case "last_week": {
      const mon = addDays(today, -dow - 7);
      return make(preset, mon, addDays(mon, 6), source, `Tuần trước (${fmt(mon)} – ${fmt(addDays(mon, 6))})`);
    }
    case "last_7_days":
      return make(preset, addDays(today, -6), today, source, `7 ngày qua (${fmt(addDays(today, -6))} – ${fmt(today)})`);
    case "last_30_days":
      return make(preset, addDays(today, -29), today, source, `30 ngày qua (${fmt(addDays(today, -29))} – ${fmt(today)})`);
    case "this_month":
      return make(preset, `${today.slice(0, 8)}01`, today, source, `Tháng này (${fmt(`${today.slice(0, 8)}01`)} – ${fmt(today)})`);
    case "last_month": {
      const first = `${today.slice(0, 8)}01`;
      const lastDay = addDays(first, -1);
      return make(preset, `${lastDay.slice(0, 8)}01`, lastDay, source, `Tháng trước (${fmt(`${lastDay.slice(0, 8)}01`)} – ${fmt(lastDay)})`);
    }
  }
}

export type PeriodError = "invalid_date" | "reversed" | "too_long" | "future";

export function customPeriod(fromDate: string, toDate: string, now: Date, source: Period["source"] = "ui"): Period | PeriodError {
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!valid(fromDate) || !valid(toDate)) return "invalid_date";
  if (fromDate > toDate) return "reversed";
  const today = vnDate(now);
  if (fromDate > today) return "future";
  const to = toDate > today ? today : toDate;
  if ((Date.parse(to) - Date.parse(fromDate)) / DAY + 1 > MAX_PERIOD_DAYS) return "too_long";
  return make("custom", fromDate, to, source);
}

/** d/m[/y] → YYYY-MM-DD; a missing year = the latest such date not after today. */
function parseDayMonth(d: string, m: string, y: string | undefined, today: string): string | null {
  const day = Number(d);
  const month = Number(m);
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return null;
  let year = y ? Number(y.length === 2 ? `20${y}` : y) : Number(today.slice(0, 4));
  let iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!y && iso > today) {
    year -= 1;
    iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

/** Finds a period in the question's words, or null. Never guesses. */
export function periodFromQuestion(question: string, now: Date): Period | null {
  const q = foldVi(question);
  const today = vnDate(now);
  const range = q.match(/(?:tu(?: ngay)?\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s*(?:den|toi|-|–)\s*(?:ngay\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/);
  if (range) {
    const a = parseDayMonth(range[1]!, range[2]!, range[3], today);
    const b = parseDayMonth(range[4]!, range[5]!, range[6] ?? range[3], today);
    if (a && b) {
      const p = customPeriod(a <= b ? a : b, a <= b ? b : a, now, "question");
      if (typeof p !== "string") return p;
    }
  }
  if (/\bhom qua\b/.test(q)) return presetPeriod("yesterday", now, "question");
  if (/\bhom nay\b/.test(q)) return presetPeriod("today", now, "question");
  if (/\btuan (truoc|roi)\b/.test(q)) return presetPeriod("last_week", now, "question");
  if (/\btuan nay\b/.test(q)) return presetPeriod("this_week", now, "question");
  if (/\bthang (truoc|roi)\b/.test(q)) return presetPeriod("last_month", now, "question");
  if (/\bthang nay\b/.test(q)) return presetPeriod("this_month", now, "question");
  const lastN = q.match(/\b(\d{1,2}) ngay (qua|gan day|vua qua)\b/);
  if (lastN) {
    const n = Math.min(Number(lastN[1]), MAX_PERIOD_DAYS);
    if (n >= 1) return make("custom", addDays(today, -(n - 1)), today, "question", `${n} ngày qua`);
  }
  const single = q.match(/\bngay (\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (single) {
    const d = parseDayMonth(single[1]!, single[2]!, single[3], today);
    if (d) return make("custom", d, d, "question");
  }
  return null;
}

export function resolvePeriod(input: { preset?: PeriodPreset; from?: string; to?: string } | undefined, question: string, now: Date): Period | PeriodError {
  if (input?.preset === "custom") return customPeriod(input.from ?? "", input.to ?? "", now, "ui");
  if (input?.preset) return presetPeriod(input.preset, now, "ui");
  return periodFromQuestion(question, now) ?? presetPeriod("last_7_days", now, "default");
}

export const PERIOD_ERROR_TEXT: Record<PeriodError, string> = {
  invalid_date: "Ngày không hợp lệ.",
  reversed: "Ngày bắt đầu phải trước ngày kết thúc.",
  too_long: `Khoảng thời gian tối đa ${MAX_PERIOD_DAYS} ngày.`,
  future: "Khoảng thời gian nằm trong tương lai.",
};
