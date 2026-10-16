// ============================================================
// PHASE UIUX-1: the ONE place display formatting lives (pure — unit tested).
//
//   formatCurrency  number or NUMERIC string → "1.234.567 ₫" (strings are
//                   never converted to float — exact for money from the DB)
//   formatQuantity  "1.234" / "1,5"
//   formatPercent   ratio 0.125 → "12,5%"
//   formatDate      dd/MM/yyyy            (Asia/Ho_Chi_Minh)
//   formatDateTime  dd/MM/yyyy HH:mm      (Asia/Ho_Chi_Minh)
//   formatDuration  ms → "850 ms" / "38 giây" / "3 phút 5 giây" / "2 giờ 10 phút"
//   formatAge       time since an ISO instant, same words
// null / undefined always render as "—" (never as 0).
// ============================================================

export const APP_TIME_ZONE = "Asia/Ho_Chi_Minh";
export const EMPTY_VALUE = "—";

type Numeric = number | string | null | undefined;

/** Groups the integer part with "." and keeps the decimals (",") of a NUMERIC string — no float conversion. */
export function formatDecimalString(value: string, unit = ""): string {
  const negative = value.trim().startsWith("-");
  const [intPart, frac = ""] = value.trim().replace(/^[-+]/, "").split(".");
  const grouped = (intPart || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const trimmedFrac = frac.replace(/0+$/, "");
  const body = `${grouped}${trimmedFrac ? `,${trimmedFrac}` : ""}`;
  return `${negative && body !== "0" ? "-" : ""}${body}${unit}`;
}

const quantityFormat = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });
// VND has no minor unit: JS numbers (UI-side totals) round to the đồng, as before.
// Exact NUMERIC strings from the database keep whatever precision they carry.
const currencyFormat = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });

function formatNumeric(value: Numeric, unit: string, format: Intl.NumberFormat): string {
  if (value === null || value === undefined || value === "") return EMPTY_VALUE;
  if (typeof value === "string") return formatDecimalString(value, unit);
  if (!Number.isFinite(value)) return EMPTY_VALUE;
  return `${format.format(value)}${unit}`;
}

export function formatCurrency(value: Numeric): string {
  return formatNumeric(value, " ₫", currencyFormat);
}

export function formatQuantity(value: Numeric): string {
  return formatNumeric(value, "", quantityFormat);
}

/** ratio (0.125) → "12,5%". */
export function formatPercent(ratio: number | null | undefined, fractionDigits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return EMPTY_VALUE;
  return `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: fractionDigits }).format(ratio * 100)}%`;
}

const dateParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(value: string | Date): Record<string, string> | null {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Object.fromEntries(dateParts.formatToParts(d).map((p) => [p.type, p.value]));
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  // A plain calendar day ("2026-10-16") is not an instant: never shift it by time zone.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-");
    return `${d}/${m}/${y}`;
  }
  const p = parts(value);
  return p ? `${p.day}/${p.month}/${p.year}` : EMPTY_VALUE;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  const p = parts(value);
  return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : EMPTY_VALUE;
}

/** "HH:mm" of an instant (Asia/Ho_Chi_Minh). */
export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  const p = parts(value);
  return p ? `${p.hour}:${p.minute}` : EMPTY_VALUE;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return EMPTY_VALUE;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} giây`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} phút ${seconds} giây` : `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
}

/** Time elapsed since `since` (e.g. a running job's start). */
export function formatAge(since: string | Date | null | undefined, now: Date = new Date()): string {
  if (!since) return EMPTY_VALUE;
  const t = since instanceof Date ? since.getTime() : new Date(since).getTime();
  if (Number.isNaN(t)) return EMPTY_VALUE;
  return formatDuration(Math.max(0, now.getTime() - t));
}

/** Sign of a NUMERIC string / number: 1, -1 or 0 (null → null). */
export function numericSign(value: Numeric): 1 | -1 | 0 | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value > 0 ? 1 : value < 0 ? -1 : 0;
  const v = value.trim();
  if (/^-?0*(\.0*)?$/.test(v.replace(/^\+/, ""))) return 0;
  return v.startsWith("-") ? -1 : 1;
}
