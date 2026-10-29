// ============================================================
// SHOPEE-ADS-3A.1: hourly TODAY intraday analytics — reconciliation rules +
// the "Hôm nay theo giờ" view model (pure, plus two DB-only read helpers).
//
// Rules (docs/shopee-ads-hourly.md):
//   * Daily facts stay canonical for every day / 7-day / 30-day number and
//     for the TODAY overview KPI. Hourly rows are the intraday breakdown.
//   * Ratios are ratio-of-sums of hourly primitives (never an average of
//     hourly ROAS / CPC …); CPC = spend / clicks, never Shopee's "cpc".
//   * The current hour is partial ("Đang diễn ra"); hours after it are not
//     shown; an hour Shopee did not return is a gap (null), never a 0.
//   * Completed day: Σ hourly vs the daily row. Counts and GMV must match
//     exactly; expense may differ by the documented rounding tolerance.
//
// Never calls Shopee. No "server-only" marker: integration tests use it.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { addTotals, deriveMetrics, ZERO_TOTALS } from "./metrics.ts";
import type { AdsHourlyReconciliationStatus, AdsIntradayData, AdsIntradayHour, AdsTotals } from "./view-models.ts";

type Num = number | string | null;
const n = (v: Num | undefined): number => (v === null || v === undefined ? 0 : Number(v));

// ------------------------------------------------------------------ reconciliation

/**
 * Expense tolerance (VND) between Σ 24 hourly rows and the daily row.
 * Shopee rounds `expense` to a whole đồng per ROW (verified: cost_per_conversion
 * × orders = 41623.46 vs expense 41623), so Σ of 24 rounded hours may differ
 * from the rounded day by < 24 × 1 đ. Observed on 27/10: shop −1 đ, campaign
 * −2 đ. Anything above is a material difference (MISMATCH), never hidden.
 */
export const ADS_HOURLY_EXPENSE_TOLERANCE_VND = 24;

/** One row of ads_dashboard_hourly_reconciliation (shop × date). */
export interface AdsHourlyReconRow {
  shop_id: string;
  report_date: string;
  hours: number;
  h_expense: Num;
  h_impression: Num;
  h_clicks: Num;
  h_direct_order: Num;
  h_broad_order: Num;
  h_direct_gmv: Num;
  h_broad_gmv: Num;
  h_direct_item_sold: Num;
  h_broad_item_sold: Num;
  has_daily: boolean;
  d_expense: Num;
  d_impression: Num;
  d_clicks: Num;
  d_direct_order: Num;
  d_broad_order: Num;
  d_direct_gmv: Num;
  d_broad_gmv: Num;
  d_direct_item_sold: Num;
  d_broad_item_sold: Num;
  campaigns_compared: number;
  campaigns_incomplete: number;
  campaigns_metric_mismatch: number;
  campaign_max_abs_expense_delta: Num;
  campaign_expense_delta: Num;
}

export interface AdsHourlyReconciliation {
  shopId: string;
  date: string;
  status: AdsHourlyReconciliationStatus;
  hours: number;
  shop: { expenseDelta: number | null; mismatchedFields: string[] };
  campaign: { compared: number; incomplete: number; metricMismatch: number; maxAbsExpenseDelta: number | null };
  reasons: string[];
}

const EXACT_FIELDS = ["impression", "clicks", "direct_order", "broad_order", "direct_gmv", "broad_gmv", "direct_item_sold", "broad_item_sold"] as const;

/**
 * Status of one shop × date (strictest first):
 *   IN_PROGRESS          the day has not ended (current hour partial, endpoints refresh at different times)
 *   MISMATCH             a count / GMV differs, or |Δ expense| > tolerance (shop or any campaign)
 *   INSUFFICIENT_DATA    no daily row, or fewer than 24 hourly rows (shop or a campaign)
 *   ROUNDING_DIFFERENCE  only expense differs, within the tolerance
 *   MATCH                identical
 */
export function adsHourlyReconciliation(row: AdsHourlyReconRow, today: string, tolerance = ADS_HOURLY_EXPENSE_TOLERANCE_VND): AdsHourlyReconciliation {
  const date = String(row.report_date).slice(0, 10);
  const reasons: string[] = [];
  const mismatchedFields = row.has_daily ? EXACT_FIELDS.filter((f) => n(row[`h_${f}`]) !== n(row[`d_${f}`])) : [];
  const expenseDelta = row.has_daily ? Math.round((n(row.h_expense) - n(row.d_expense)) * 100) / 100 : null;
  const campaignMaxDelta = row.campaign_max_abs_expense_delta === null ? null : n(row.campaign_max_abs_expense_delta);
  const campaign = { compared: row.campaigns_compared, incomplete: row.campaigns_incomplete, metricMismatch: row.campaigns_metric_mismatch, maxAbsExpenseDelta: campaignMaxDelta };
  const result = (status: AdsHourlyReconciliationStatus): AdsHourlyReconciliation => ({ shopId: row.shop_id, date, status, hours: row.hours, shop: { expenseDelta, mismatchedFields }, campaign, reasons });

  if (date >= today) return result("IN_PROGRESS");
  if (mismatchedFields.length) reasons.push(`Shop: lệch ${mismatchedFields.join(", ")}`);
  if (expenseDelta !== null && Math.abs(expenseDelta) > tolerance) reasons.push(`Shop: chi tiêu lệch ${expenseDelta} đ (> ${tolerance} đ)`);
  if (campaign.metricMismatch > 0) reasons.push(`${campaign.metricMismatch} chiến dịch lệch số đếm / GMV`);
  if (campaignMaxDelta !== null && campaignMaxDelta > tolerance) reasons.push(`Chiến dịch: chi tiêu lệch tới ${campaignMaxDelta} đ (> ${tolerance} đ)`);
  if (reasons.length) return result("MISMATCH");
  if (!row.has_daily) reasons.push("Chưa có số liệu ngày để đối chiếu");
  if (row.hours < 24) reasons.push(`Shop: chỉ có ${row.hours}/24 giờ`);
  if (campaign.incomplete > 0) reasons.push(`${campaign.incomplete} chiến dịch thiếu giờ`);
  if (reasons.length) return result("INSUFFICIENT_DATA");
  if (expenseDelta !== 0 || (campaignMaxDelta ?? 0) > 0) {
    reasons.push(`Chi tiêu lệch do làm tròn (shop ${expenseDelta} đ${campaignMaxDelta ? `, chiến dịch tối đa ${campaignMaxDelta} đ` : ""})`);
    return result("ROUNDING_DIFFERENCE");
  }
  return result("MATCH");
}

const STATUS_RANK: Record<AdsHourlyReconciliationStatus, number> = { MISMATCH: 4, INSUFFICIENT_DATA: 3, ROUNDING_DIFFERENCE: 2, MATCH: 1, IN_PROGRESS: 0 };

/** The strictest status of several shops (All shops view). */
export function worstReconciliation(list: AdsHourlyReconciliation[]): AdsHourlyReconciliation | null {
  return list.reduce<AdsHourlyReconciliation | null>((w, r) => (!w || STATUS_RANK[r.status] > STATUS_RANK[w.status] ? r : w), null);
}

export async function loadAdsHourlyReconciliation(db: SupabaseClient, shopIds: string[], range: { from: string; to: string }): Promise<AdsHourlyReconRow[]> {
  if (!shopIds.length) return [];
  const { data, error } = await db.rpc("ads_dashboard_hourly_reconciliation", { p_shop_ids: shopIds, p_from: range.from, p_to: range.to });
  if (error) throw new Error(`ads_dashboard_hourly_reconciliation: ${error.message}`);
  return (data ?? []) as AdsHourlyReconRow[];
}

// ------------------------------------------------------------------ intraday view model

/** One row of ads_dashboard_shop_hourly (date × hour, summed across the selected shops). */
export interface AdsShopHourlyRow {
  report_date: string;
  report_hour: number;
  expense: Num;
  impression: Num;
  clicks: Num;
  direct_order: Num;
  broad_order: Num;
  direct_gmv: Num;
  broad_gmv: Num;
  shops_with_data: number;
}

export async function loadAdsShopHourly(db: SupabaseClient, shopIds: string[], range: { from: string; to: string }): Promise<AdsShopHourlyRow[]> {
  if (!shopIds.length) return [];
  // ≤ 24 rows per day (summed across shops): two days fit one PostgREST page
  const { data, error } = await db.rpc("ads_dashboard_shop_hourly", { p_shop_ids: shopIds, p_from: range.from, p_to: range.to });
  if (error) throw new Error(`ads_dashboard_shop_hourly: ${error.message}`);
  return (data ?? []) as AdsShopHourlyRow[];
}

const totalsOfHour = (r: AdsShopHourlyRow): AdsTotals => ({
  spend: n(r.expense),
  revenue: n(r.broad_gmv),
  orders: n(r.broad_order),
  directRevenue: n(r.direct_gmv),
  directOrders: n(r.direct_order),
  clicks: n(r.clicks),
  impressions: n(r.impression),
});

export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}h`;

/** A peak is reported only when the day so far carries enough signal (no "best hour" out of 2 clicks). */
const PEAK_MIN_COMPLETED_HOURS = 3;
const ROAS_PEAK_MIN_SPEND_SHARE = 0.1;
const ROAS_PEAK_MIN_CLICKS = 10;

export interface AdsIntradayInput {
  today: string;
  yesterday: string;
  currentHour: number;
  rows: AdsShopHourlyRow[];
  shops: { selected: number; enabled: number };
  /** Latest hourly write per shop with rows today (freshness = the OLDEST of them). */
  lastSyncedByShop: string[];
  reconciliation: AdsHourlyReconciliation[];
  now: Date;
  freshTargetMinutes: number;
  staleMinutes: number;
}

export function buildAdsIntraday(input: AdsIntradayInput): AdsIntradayData {
  const todayRows = new Map(input.rows.filter((r) => String(r.report_date).slice(0, 10) === input.today).map((r) => [Number(r.report_hour), r]));
  const yesterdayRows = new Map(input.rows.filter((r) => String(r.report_date).slice(0, 10) === input.yesterday).map((r) => [Number(r.report_hour), r]));
  let cum = ZERO_TOTALS;
  const hours: AdsIntradayHour[] = [];
  for (let h = 0; h <= input.currentHour; h++) {
    const r = todayRows.get(h);
    if (r) cum = addTotals(cum, totalsOfHour(r));
    hours.push({
      hour: h,
      label: hourLabel(h),
      state: h === input.currentHour ? "current" : "complete",
      metrics: r ? deriveMetrics(totalsOfHour(r)) : null,
      shops: r ? Number(r.shops_with_data) : 0,
      cumSpend: cum.spend,
      cumRevenue: cum.revenue,
    });
  }
  const withData = todayRows.size > 0;

  // same hours of yesterday: only completed hours of today, and only when yesterday has every one of them
  let sameHourYesterday: AdsIntradayData["sameHourYesterday"] = null;
  const through = input.currentHour - 1;
  if (through >= 0 && withData) {
    let t = ZERO_TOTALS;
    let y = ZERO_TOTALS;
    let complete = true;
    for (let h = 0; h <= through; h++) {
      const yr = yesterdayRows.get(h);
      if (!yr) complete = false;
      else y = addTotals(y, totalsOfHour(yr));
      const tr = todayRows.get(h);
      if (tr) t = addTotals(t, totalsOfHour(tr));
    }
    if (complete) sameHourYesterday = { throughHour: through, today: deriveMetrics(t), yesterday: deriveMetrics(y) };
  }

  // observational peaks among COMPLETED hours with data
  const done = hours.filter((h) => h.state === "complete" && h.metrics);
  const peaks: AdsIntradayData["peaks"] = [];
  if (done.length >= PEAK_MIN_COMPLETED_HOURS) {
    const doneSpend = done.reduce((a, h) => a + h.metrics!.spend, 0);
    const top = (pick: (h: AdsIntradayHour) => number, eligible: (h: AdsIntradayHour) => boolean) =>
      done.filter(eligible).reduce<AdsIntradayHour | null>((best, h) => (!best || pick(h) > pick(best) ? h : best), null);
    const spend = top((h) => h.metrics!.spend, (h) => h.metrics!.spend > 0);
    if (spend) peaks.push({ key: "spend", label: "Khung giờ chi tiêu cao nhất", hour: spend.hour, value: spend.metrics!.spend });
    const revenue = top((h) => h.metrics!.revenue, (h) => h.metrics!.revenue > 0);
    if (revenue) peaks.push({ key: "revenue", label: "Khung giờ doanh số Broad cao nhất", hour: revenue.hour, value: revenue.metrics!.revenue });
    const roas = top((h) => h.metrics!.roas ?? 0, (h) => h.metrics!.roas !== null && h.metrics!.roas > 0 && h.metrics!.spend >= doneSpend * ROAS_PEAK_MIN_SPEND_SHARE && h.metrics!.clicks >= ROAS_PEAK_MIN_CLICKS);
    if (roas) peaks.push({ key: "roas", label: "Khung giờ ROAS Broad cao nhất", hour: roas.hour, value: roas.metrics!.roas! });
  }

  const lastSyncedAt = input.lastSyncedByShop.length ? [...input.lastSyncedByShop].sort()[0] : null;
  const worst = worstReconciliation(input.reconciliation.filter((r) => r.date === input.yesterday));
  return {
    date: input.today,
    currentHour: input.currentHour,
    status: withData ? "ok" : input.shops.enabled > 0 ? "empty" : "disabled",
    hours,
    totals: deriveMetrics(cum),
    sameHourYesterday,
    peaks,
    freshness: {
      lastSyncedAt,
      targetMinutes: input.freshTargetMinutes,
      staleAfterMinutes: input.staleMinutes,
      stale: !lastSyncedAt || input.now.getTime() - Date.parse(lastSyncedAt) > input.staleMinutes * 60_000,
    },
    shops: { selected: input.shops.selected, enabled: input.shops.enabled, withData: Math.max(0, ...[...todayRows.values()].map((r) => Number(r.shops_with_data))) },
    reconciliation: worst ? { date: worst.date, status: worst.status, reasons: worst.reasons } : null,
  };
}

/** Placeholder when the hourly tables could not be read (e.g. code deployed before the migration). */
export function unavailableIntraday(today: string, currentHour: number, freshTargetMinutes: number, staleMinutes: number): AdsIntradayData {
  return {
    date: today,
    currentHour,
    status: "unavailable",
    hours: [],
    totals: deriveMetrics(ZERO_TOTALS),
    sameHourYesterday: null,
    peaks: [],
    freshness: { lastSyncedAt: null, targetMinutes: freshTargetMinutes, staleAfterMinutes: staleMinutes, stale: true },
    shops: { selected: 0, enabled: 0, withData: 0 },
    reconciliation: null,
  };
}
