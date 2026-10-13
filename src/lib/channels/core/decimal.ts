// ============================================================
// PHASE SHOPEE-2: provider number → exact decimal string, at the boundary.
//
// Provider JSON numbers are parsed by JSON.parse into doubles. For values a
// marketplace realistically sends (prices / quantities with ≤ 15 significant
// digits), String(n) returns the shortest round-trip form, i.e. the same
// literal the provider sent (150000 → "150000", 19.9 → "19.9"). Anything that
// would not round-trip (exponent notation, > 15 significant digits,
// NaN/Infinity) is rejected instead of being stored approximately.
// No arithmetic happens here — values go to NUMERIC columns as strings.
// ============================================================
import type { Decimal } from "./types.ts";

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export function toDecimalString(value: unknown): Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  if (!DECIMAL_PATTERN.test(text)) return null;
  if (text.replace(/^-|\./g, "").replace(/^0+/, "").length > 15) return null;
  return text;
}
