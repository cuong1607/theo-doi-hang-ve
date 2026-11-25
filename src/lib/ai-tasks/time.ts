// ============================================================
// PHASE 06 — Asia/Ho_Chi_Minh calendar helpers. Vietnam has used UTC+7 with
// no daylight saving since 1975, so a fixed offset is exact (and needs no
// Intl data on the server). Pure.
// ============================================================

export const VN_TZ = "Asia/Ho_Chi_Minh";
export const VN_OFFSET_MS = 7 * 3_600_000;
export const DAY_MS = 86_400_000;

export interface VnParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

export function vnParts(d: Date): VnParts {
  const v = new Date(d.getTime() + VN_OFFSET_MS);
  return { year: v.getUTCFullYear(), month: v.getUTCMonth() + 1, day: v.getUTCDate(), hour: v.getUTCHours(), minute: v.getUTCMinutes(), weekday: v.getUTCDay() };
}

/** The UTC instant of a VN wall-clock time (month 1-12; overflowing days roll over like Date.UTC). */
export function vnTime(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - VN_OFFSET_MS);
}

export function vnStartOfDay(d: Date): Date {
  const p = vnParts(d);
  return vnTime(p.year, p.month, p.day);
}

/** "YYYY-MM-DD" of the VN calendar day. */
export function vnDateKey(d: Date): string {
  const p = vnParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "17:00 thứ Sáu 28/11/2026" — for messages and the UI. */
export function formatVn(d: Date, withWeekday = true): string {
  const p = vnParts(d);
  const wd = ["Chủ nhật", "thứ Hai", "thứ Ba", "thứ Tư", "thứ Năm", "thứ Sáu", "thứ Bảy"][p.weekday];
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return `${time} ${withWeekday ? `${wd} ` : ""}${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}/${p.year}`;
}
