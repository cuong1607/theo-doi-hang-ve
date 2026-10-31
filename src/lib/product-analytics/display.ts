// ============================================================
// PRODUCT-ANALYTICS-3: display rules shared by list, cards and detail (pure, tested).
// MISSING DATA IS NOT ZERO: no sales data → "—"; not fully covered → "≥ x"
// (a lower bound); a % change only when SQL says the comparison is valid.
// ============================================================
import { formatInt, formatRoas, formatVndCompact, formatVndFull } from "../channels/shopee/ads/metrics.ts";

export type SalesAvailability = "no_data" | "lower_bound" | "complete";

export function salesAvailability(row: { sales_state: string; sales_exact: boolean }): SalesAvailability {
  if (row.sales_state === "no_data") return "no_data";
  return row.sales_exact ? "complete" : "lower_bound";
}

/** "—" (no data) · "≥ 1,2 tr ₫" (lower bound) · "1,2 tr ₫". */
export function formatSalesValue(v: number | null | undefined, availability: SalesAvailability, fmt: (n: number | null) => string): string {
  if (availability === "no_data" || v === null || v === undefined) return "—";
  if (availability === "lower_bound") return v > 0 ? `≥ ${fmt(v)}` : "—";
  return fmt(v);
}

export const fmt = {
  vnd: formatVndCompact,
  vndFull: formatVndFull,
  int: formatInt,
  roas: formatRoas,
};

/** "+12,3%" / "−8%" (sign + words carry the meaning; colour is extra). */
export function formatPct(pct: number | null | undefined, digits = 1): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  const s = Math.abs(pct).toLocaleString("vi-VN", { maximumFractionDigits: digits });
  return pct > 0 ? `+${s}%` : pct < 0 ? `−${s}%` : `${s}%`;
}

/** "12 phút trước" / "3 giờ trước" / "2 ngày trước". */
export function formatAge(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "chưa có";
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${Math.round(minutes)} phút trước`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} giờ trước`;
  return `${Math.round(minutes / 1440)} ngày trước`;
}

export function minutesSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
}

/** Attribution indicator wording — the only allowed label + tooltip (spec §10). */
export const ATTRIBUTION_INDICATOR_LABEL = "Ads attribution / total sales indicator";
export const ATTRIBUTION_INDICATOR_LABEL_VI = "Chỉ báo Ads attribution / tổng doanh số";
export const ATTRIBUTION_INDICATOR_TOOLTIP =
  "This compares Shopee Ads attribution GMV against product sales facts. It is NOT a sales-share percentage and may exceed 100%. — So sánh GMV quy đổi (attribution) của Shopee Ads với doanh số từ đơn hàng. KHÔNG phải tỷ trọng doanh số và có thể vượt 100%.";
export const BROAD_GMV_TOOLTIP = "Broad GMV là số liệu attribution của Shopee Ads (cửa sổ quy đổi của Shopee) — không phải phần doanh số do quảng cáo tạo ra, và doanh số trừ Broad GMV không phải doanh số tự nhiên.";
