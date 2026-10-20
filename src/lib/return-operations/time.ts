// ============================================================
// PHASE SHOPEE-6B: business date / local time of a delivered-to-seller
// timestamp. business_date = DATE(delivered_to_seller_at in the shop's
// business timezone) — never the UTC date. Vietnam has no DST, but this
// goes through Intl so any IANA zone is correct.
// Pure: no I/O.
// ============================================================

export const DEFAULT_BUSINESS_TIMEZONE = "Asia/Ho_Chi_Minh";

function parts(at: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

/** "YYYY-MM-DD" of the instant in the business timezone. */
export function businessDateOf(at: string | Date, timeZone: string = DEFAULT_BUSINESS_TIMEZONE): string {
  return parts(typeof at === "string" ? new Date(at) : at, timeZone).date;
}

/** "HH:MM:SS" (24 h) of the instant in the business timezone. */
export function localTimeOf(at: string | Date, timeZone: string = DEFAULT_BUSINESS_TIMEZONE): string {
  return parts(typeof at === "string" ? new Date(at) : at, timeZone).time;
}

/** "HH:MM" → minutes since midnight; null when malformed. */
export function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const hhmm = (t: string) => t.slice(0, 5);

/** dd/MM/yyyy for a YYYY-MM-DD date. */
export function displayDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

/** Shift a YYYY-MM-DD date by whole days (calendar arithmetic, timezone-free). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
