// ============================================================
// PRODUCT-ANALYTICS-2P: sales coverage — MISSING DATA IS NOT ZERO.
//
// Sales facts are complete only from the first day the 30-day backfill
// covered. Before the backfill (or for days older than it), the facts hold
// only orders that a manual / HOT read happened to see, so a sum over those
// days is a lower bound and a "previous period" can be almost empty, which
// would show as +500 %. Every reader (list, detail, signals, agent tools)
// asks this module whether a period is fully covered. Pure.
// ============================================================
import { PRODUCT_ANALYTICS_BACKFILL_DAYS } from "./config.ts";
import type { ShopFreshnessRow } from "./types.ts";

export type SalesCoverageState = "no_data" | "not_backfilled" | "covered";

export interface SalesCoverage {
  state: SalesCoverageState;
  /** First VN date whose orders are all in the facts (null = none yet). */
  covered_from: string | null;
  current_complete: boolean;
  previous_complete: boolean;
}

const vnDate = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function salesCoverage(
  freshness: Pick<ShopFreshnessRow, "sales_last_success_at" | "sales_backfill_done_at"> | null | undefined,
  period: { from: string; prevFrom: string },
  backfillDays: number = PRODUCT_ANALYTICS_BACKFILL_DAYS,
): SalesCoverage {
  if (!freshness?.sales_last_success_at && !freshness?.sales_backfill_done_at) return { state: "no_data", covered_from: null, current_complete: false, previous_complete: false };
  if (!freshness.sales_backfill_done_at) return { state: "not_backfilled", covered_from: null, current_complete: false, previous_complete: false };
  // the backfill read orders created from (start of its day − backfillDays); using
  // the completion day is conservative when the run crossed midnight
  const coveredFrom = addDays(vnDate(freshness.sales_backfill_done_at), -backfillDays);
  return { state: "covered", covered_from: coveredFrom, current_complete: period.from >= coveredFrom, previous_complete: period.prevFrom >= coveredFrom };
}

/** Sales numbers of the current period can be shown as exact. */
export const salesExact = (c: SalesCoverage) => c.current_complete;
/** A sales % change means something only when BOTH periods are covered. */
export const salesComparable = (c: SalesCoverage) => c.current_complete && c.previous_complete;

export function salesCoverageNote(c: SalesCoverage): string | null {
  if (c.state === "no_data") return "Chưa có dữ liệu đơn hàng cho shop này — doanh số không phải 0 mà là CHƯA CÓ.";
  if (c.state === "not_backfilled") return "Chưa backfill 30 ngày: doanh số chỉ gồm các đơn của lần đọc gần nhất, là mức TỐI THIỂU; không so sánh kỳ.";
  if (!c.current_complete) return `Dữ liệu đơn hàng đầy đủ từ ${c.covered_from}; kỳ đang xem bắt đầu sớm hơn nên doanh số là mức tối thiểu.`;
  if (!c.previous_complete) return `Kỳ so sánh bắt đầu trước ${c.covered_from} (ngày có dữ liệu đầy đủ) — không tính % thay đổi doanh số.`;
  return null;
}
