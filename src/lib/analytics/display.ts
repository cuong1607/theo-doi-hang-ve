// ============================================================
// PHASE SHOPEE-8: analytics display helpers (pure). Money arrives as exact
// NUMERIC strings; rounding to the đồng for display is TEXTUAL (half up,
// away from zero) — no float on authoritative totals. Number() is used only
// for chart geometry (pixel positions), never for a displayed figure.
// ============================================================
import { formatDecimalString } from "../ui/format.ts";

/** "1116212.235" → "1116212"; "-0.5" → "-1"; null stays null. */
export function roundDecimalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = value.trim();
  const neg = s.startsWith("-");
  const [int, frac = ""] = s.replace(/^[-+]/, "").split(".");
  let digits = (int || "0").replace(/^0+(?=\d)/, "");
  if (frac.length > 0 && frac[0] >= "5") {
    const arr = digits.split("");
    let i = arr.length - 1;
    while (i >= 0) {
      if (arr[i] === "9") {
        arr[i] = "0";
        i--;
      } else {
        arr[i] = String(Number(arr[i]) + 1);
        break;
      }
    }
    digits = (i < 0 ? "1" : "") + arr.join("");
  }
  return neg && digits !== "0" ? `-${digits}` : digits;
}

/** "1.116.212 ₫" (rounded to the đồng); null → "—". */
export function formatMoney(value: string | null | undefined): string {
  const r = roundDecimalString(value);
  return r === null ? "—" : formatDecimalString(r, " ₫");
}

/** Signed money with an explicit + (profit / loss shown as sign + number). */
export function formatSignedMoney(value: string | null | undefined): string {
  const r = roundDecimalString(value);
  if (r === null) return "—";
  return `${r.startsWith("-") ? "−" : r === "0" ? "" : "+"}${formatDecimalString(r.replace(/^-/, ""), " ₫")}`;
}

/** Margin / rate "14,0%" from a decimal string; null → "—". */
export function formatPct(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const s = (typeof value === "number" ? String(value) : value).trim();
  const neg = s.startsWith("-");
  const [int, frac = ""] = s.replace(/^[-+]/, "").split(".");
  const grouped = (int || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "−" : ""}${grouped},${(frac + "0")[0]}%`;
}

export const isNegative = (v: string | null | undefined) => typeof v === "string" && v.trim().startsWith("-") && !/^-0+(\.0+)?$/.test(v.trim());

/** Profit wording that does not rely on colour. */
export function profitWord(v: string | null | undefined): string {
  if (v === null || v === undefined) return "chưa đủ dữ liệu";
  if (isNegative(v)) return "lỗ";
  return /^-?0+(\.0+)?$/.test(v.trim()) ? "hoà vốn" : "lãi";
}

/** Chart geometry only. */
export const chartNumber = (v: string | null | undefined): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
