// ============================================================
// SHOPEE-ADS-3A.1 — hourly TODAY intraday analytics (pure, no DB):
//   node --test src/lib/channels/shopee/ads/ads-hourly.test.ts
//
// Mapper (sanitized PRODUCTION hourly fixtures, 27/10), hour / date parsing,
// partial today + future hours + gaps, ratio-of-sums, CPC = spend / clicks
// (never Shopee's campaign "cpc"), hourly vs daily reconciliation (expense
// rounding tolerance), same-hour-yesterday, observational peaks, scheduler
// plan (hourly below daily HOT; finalize once for yesterday), config.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ADS_HOURLY_EXPENSE_TOLERANCE_VND, adsHourlyReconciliation, buildAdsIntraday, worstReconciliation, type AdsHourlyReconRow, type AdsShopHourlyRow } from "./hourly.ts";
import { AdsPayloadError, parseAdsHour, parseCampaignDailyPerformance, parseCampaignHourlyPerformance, parseShopDailyPerformance, parseShopHourlyPerformance } from "./mapper.ts";
import { ADS_FIXTURE_DIR, assertVerifiedAdsRequest, FixtureShopeeAdsProvider, loadAdsFixtures } from "./provider.ts";
import { ADS_READ_ENDPOINTS, isAdsReadJobType, isAdsReadOnlyRequest } from "./read-only-policy.ts";
import { planAdsShop } from "./schedule.ts";
import { ADS_PRIORITY, getAdsSyncConfig, shopHour, storableHourlyRows } from "./sync.ts";

type Obj = Record<string, unknown>;
const fx = (name: string) => JSON.parse(readFileSync(path.join(ADS_FIXTURE_DIR, `${name}.json`), "utf8")).response as Obj;
const shopHourly = fx("shop-hourly-performance");
const campaignHourly = fx("exp-campaign-hourly-performance");
const rawShopRows = shopHourly.response as Obj[];
const TODAY = "2026-10-28";
const YESTERDAY = "2026-10-27";
const NOW = new Date("2026-10-28T07:40:00Z"); // 14:40 VN

/** Shop fixture rows (27/10) as one ads_dashboard_shop_hourly row per hour, re-dated. */
function rpcRows(date: string, hours: number[] = rawShopRows.map((r) => Number(r.hour))): AdsShopHourlyRow[] {
  return rawShopRows
    .filter((r) => hours.includes(Number(r.hour)))
    .map((r) => ({ report_date: date, report_hour: Number(r.hour), expense: Number(r.expense), impression: Number(r.impression), clicks: Number(r.clicks), direct_order: Number(r.direct_order), broad_order: Number(r.broad_order), direct_gmv: Number(r.direct_gmv), broad_gmv: Number(r.broad_gmv), shops_with_data: 1 }));
}

const intraday = (rows: AdsShopHourlyRow[], currentHour = 14, extra: Partial<Parameters<typeof buildAdsIntraday>[0]> = {}) =>
  buildAdsIntraday({ today: TODAY, yesterday: YESTERDAY, currentHour, rows, shops: { selected: 1, enabled: 1 }, lastSyncedByShop: [NOW.toISOString()], reconciliation: [], now: NOW, freshTargetMinutes: 25, staleMinutes: 35, ...extra });

// ------------------------------------------------------------------ mapper (65)

test("65. shop hourly mapper: 24 rows of the production fixture, exact primitives per hour (hour 0 verified field by field)", () => {
  const { rows, missingFields } = parseShopHourlyPerformance(shopHourly);
  assert.equal(rows.length, 24);
  assert.deepEqual(rows.map((r) => r.reportHour), Array.from({ length: 24 }, (_, h) => h));
  assert.equal(missingFields, 0);
  assert.deepEqual(rows[0], { reportDate: "2026-10-27", reportHour: 0, expense: "41623", impression: 1587, clicks: 40, directOrder: 1, broadOrder: 1, directGmv: "273350", broadGmv: "273350", directItemSold: 1, broadItemSold: 1 });
  // provider ratios are not mapped (ctr / roas / cost_per_conversion stay in the raw snapshot)
  assert.ok(!("ctr" in rows[0]) && !("roas" in rows[0]) && !("cpc" in rows[0]));
  const sum = (k: "impression" | "clicks" | "broadOrder") => rows.reduce((a, r) => a + r[k], 0);
  assert.deepEqual([sum("impression"), sum("clicks"), sum("broadOrder")], [36145, 1042, 52], "Σ hourly counts = the 27/10 daily row");
});

test("65. campaign hourly mapper: 24 rows for the captured campaign, *_order_amount → item_sold, campaign id kept as text", () => {
  const { rows, failures } = parseCampaignHourlyPerformance(campaignHourly);
  assert.equal(failures.length, 0);
  assert.equal(rows.length, 24);
  assert.ok(rows.every((r) => r.providerCampaignId === "900000040" && r.reportDate === "2026-10-27"));
  const h1 = rows.find((r) => r.reportHour === 1)!;
  assert.deepEqual(h1, { providerCampaignId: "900000040", reportDate: "2026-10-27", reportHour: 1, expense: "12640", impression: 236, clicks: 8, directOrder: 1, broadOrder: 1, directGmv: "514800", broadGmv: "514800", directItemSold: 1, broadItemSold: 1 });
  assert.equal(rows.reduce((a, r) => a + Number(r.expense), 0), 299998);
  // hourly rows are never accepted by the daily parsers, and daily rows never by the hourly ones
  assert.equal(parseCampaignDailyPerformance(campaignHourly).failures.length, 1);
  assert.throws(() => parseShopDailyPerformance(shopHourly), AdsPayloadError);
  assert.throws(() => parseShopHourlyPerformance(fx("shop-daily-performance")), /bảng giờ/);
});

// ------------------------------------------------------------------ parsing (66) + negatives (61)

test("66. hour 0–23 only (-1, 24, 99, 1.5, 'x' refused); date DD-MM-YYYY strict; duplicate hour refused; negative primitive refused (flagged, never corrected)", () => {
  for (const ok of [0, 9, 23, "7"]) assert.equal(parseAdsHour(ok), Number(ok));
  for (const bad of [-1, 24, 99, 1.5, "x", null, undefined, "24"]) assert.throws(() => parseAdsHour(bad), AdsPayloadError, String(bad));
  const row = { ...rawShopRows[3] };
  assert.throws(() => parseShopHourlyPerformance({ response: [{ ...row, hour: 24 }] }), /Giờ báo cáo/);
  assert.throws(() => parseShopHourlyPerformance({ response: [{ ...row, date: "2026-10-27" }] }), /DD-MM-YYYY/);
  assert.throws(() => parseShopHourlyPerformance({ response: [{ ...row, date: "31-02-2026" }] }), /không tồn tại/);
  assert.throws(() => parseShopHourlyPerformance({ response: [row, row] }), /Trùng giờ/);
  assert.throws(() => parseShopHourlyPerformance({ response: [{ ...row, expense: -5 }] }), AdsPayloadError);
  // campaign side: the bad campaign fails alone, the batch keeps the others
  const list = (campaignHourly.response as Obj).campaign_list as Obj[];
  const bad = { ...list[0], campaign_id: 900000041, metrics_list: [{ ...(list[0].metrics_list as Obj[])[0], clicks: -1 }] };
  const parsed = parseCampaignHourlyPerformance({ response: { campaign_list: [list[0], bad] } });
  assert.equal(parsed.rows.length, 24);
  assert.deepEqual(parsed.failures.map((f) => f.id), ["900000041"]);
});

// ------------------------------------------------------------------ partial today / future hours / gaps (27–29, 72)

test("72. partial today: hours after the current shop-local hour are never stored (counted as futureHours); other dates are not stored either", () => {
  const { rows } = parseShopHourlyPerformance({ response: rawShopRows.map((r) => ({ ...r, date: "28-10-2026" })) });
  const kept = storableHourlyRows(rows, { date: TODAY, today: TODAY, currentHour: 14 });
  assert.equal(kept.rows.length, 15);
  assert.equal(kept.futureHours, 9);
  assert.ok(kept.rows.every((r) => r.reportHour <= 14));
  // a completed day keeps all 24 hours
  assert.equal(storableHourlyRows(rows, { date: TODAY, today: "2026-10-29", currentHour: 1 }).rows.length, 24);
  // a row for another date than requested is refused (counted)
  const other = storableHourlyRows(rows, { date: YESTERDAY, today: TODAY, currentHour: 14 });
  assert.deepEqual([other.rows.length, other.otherDates], [0, 24]);
  // the provider hour is the SHOP's hour, never UTC
  assert.equal(shopHour(NOW, "Asia/Ho_Chi_Minh"), 14);
  assert.equal(shopHour(new Date("2026-10-28T17:30:00Z"), "Asia/Ho_Chi_Minh"), 0, "00:30 VN of the next day");
});

test("27–29 / 72. intraday: 00h → current hour only, current hour marked partial, a missing hour is a GAP (null), never a fabricated 0", () => {
  const rows = rpcRows(TODAY, [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16]); // hour 7 omitted; 15–16 would be future
  const d = intraday(rows, 14);
  assert.equal(d.status, "ok");
  assert.equal(d.hours.length, 15, "future hours are not part of the chart");
  assert.equal(d.hours.at(-1)!.state, "current");
  assert.ok(d.hours.slice(0, -1).every((h) => h.state === "complete"));
  assert.equal(d.hours[7].metrics, null, "gap");
  assert.ok(d.hours.filter((h) => h.hour !== 7).every((h) => h.metrics !== null));
  // the cumulative line carries over the gap (nothing added for it)
  assert.equal(d.hours[7].cumSpend, d.hours[6].cumSpend);
  assert.equal(d.totals.spend, rows.filter((r) => r.report_hour <= 14).reduce((a, r) => a + Number(r.expense), 0), "hours after the current one are ignored");
});

test("63. zero-activity hours: ratios are null (\"—\"), never NaN / Infinity", () => {
  const zero = rpcRows(TODAY, [0, 1]).map((r) => ({ ...r, expense: 0, impression: 0, clicks: 0, broad_gmv: 0, direct_gmv: 0, broad_order: 0, direct_order: 0 }));
  const d = intraday(zero, 1);
  for (const h of d.hours) {
    for (const v of Object.values(h.metrics!)) assert.ok(v === null || Number.isFinite(v), JSON.stringify(h.metrics));
    assert.deepEqual([h.metrics!.roas, h.metrics!.cpc, h.metrics!.ctr, h.metrics!.directRoas], [null, null, null, null]);
  }
  assert.equal(d.totals.roas, null);
  assert.deepEqual(d.peaks, [], "no peak out of zero activity");
});

// ------------------------------------------------------------------ CPC (31, 69) + ratio-of-sums (32, 70)

test("69. hourly CPC = spend / clicks — never Shopee's campaign `cpc` (= expense / broad_order)", () => {
  const list = (campaignHourly.response as Obj).campaign_list as Obj[];
  const h1 = (list[0].metrics_list as Obj[]).find((m) => m.hour === 1)!;
  assert.equal(h1.cpc, 12640, "provider cpc = expense / broad_order");
  const row: AdsShopHourlyRow = { report_date: TODAY, report_hour: 0, expense: Number(h1.expense), impression: Number(h1.impression), clicks: Number(h1.clicks), direct_order: Number(h1.direct_order), broad_order: Number(h1.broad_order), direct_gmv: Number(h1.direct_gmv), broad_gmv: Number(h1.broad_gmv), shops_with_data: 1 };
  const d = intraday([row], 0);
  assert.equal(d.hours[0].metrics!.cpc, 12640 / 8, "1,580 đ per click");
  assert.notEqual(d.hours[0].metrics!.cpc, h1.cpc);
});

test("70. ratio-of-sums: today's ROAS / CPC / CTR come from summed primitives, never the average of hourly ratios", () => {
  const rows = rpcRows(TODAY);
  const d = intraday(rows, 23);
  const spend = rows.reduce((a, r) => a + Number(r.expense), 0);
  const gmv = rows.reduce((a, r) => a + Number(r.broad_gmv), 0);
  const clicks = rows.reduce((a, r) => a + Number(r.clicks), 0);
  const hourly = d.hours.map((h) => h.metrics!.roas).filter((v): v is number => v !== null);
  const avg = hourly.reduce((a, v) => a + v, 0) / hourly.length;
  assert.ok(Math.abs(avg - gmv / spend) > 0.5, `the sample really differs: avg ${avg.toFixed(3)} vs ${(gmv / spend).toFixed(3)}`);
  assert.equal(d.totals.roas, gmv / spend);
  assert.equal(d.totals.cpc, spend / clicks);
  assert.equal(Math.round(d.totals.roas! * 100) / 100, 10.37, "= Shopee's daily broad_roas for 27/10");
});

// ------------------------------------------------------------------ reconciliation (33–36, 60, 71)

function recon(over: Partial<AdsHourlyReconRow> = {}): AdsHourlyReconRow {
  // the real 27/10 shop figures: Σ 24 hourly rows vs the daily row (expense −1 đ, counts / GMV exact)
  const s = (k: string) => rawShopRows.reduce((a, r) => a + Number(r[k]), 0);
  return {
    shop_id: "shop-1", report_date: YESTERDAY, hours: 24,
    h_expense: s("expense"), h_impression: s("impression"), h_clicks: s("clicks"), h_direct_order: s("direct_order"), h_broad_order: s("broad_order"),
    h_direct_gmv: s("direct_gmv"), h_broad_gmv: s("broad_gmv"), h_direct_item_sold: s("direct_item_sold"), h_broad_item_sold: s("broad_item_sold"),
    has_daily: true,
    d_expense: 1104162, d_impression: 36145, d_clicks: 1042, d_direct_order: s("direct_order"), d_broad_order: 52,
    d_direct_gmv: s("direct_gmv"), d_broad_gmv: 11447308, d_direct_item_sold: s("direct_item_sold"), d_broad_item_sold: s("broad_item_sold"),
    // campaign 900000040 on 27/10: Σ hourly 299,998 vs daily 300,000 (−2 đ); 100 zero campaigns identical
    campaigns_compared: 101, campaigns_incomplete: 0, campaigns_metric_mismatch: 0, campaign_max_abs_expense_delta: 2, campaign_expense_delta: -2,
    ...over,
  };
}

test("71. completed day 27/10 (production fixtures): counts / GMV exact, expense −1 đ (shop) / −2 đ (campaign) → ROUNDING_DIFFERENCE, not a mismatch", () => {
  const r = adsHourlyReconciliation(recon(), TODAY);
  assert.equal(r.status, "ROUNDING_DIFFERENCE");
  assert.equal(r.shop.expenseDelta, -1);
  assert.deepEqual(r.shop.mismatchedFields, []);
  assert.equal(r.campaign.maxAbsExpenseDelta, 2);
  assert.ok(ADS_HOURLY_EXPENSE_TOLERANCE_VND >= 2 && ADS_HOURLY_EXPENSE_TOLERANCE_VND <= 24, "documented tolerance: < 1 đ rounding per hourly row");
});

test("60 / 34–36. reconciliation statuses: MATCH, MISMATCH (count, GMV, material expense, campaign), INSUFFICIENT_DATA, IN_PROGRESS (today never an anomaly)", () => {
  assert.equal(adsHourlyReconciliation(recon({ h_expense: 1104162, campaign_max_abs_expense_delta: 0 }), TODAY).status, "MATCH");
  assert.equal(adsHourlyReconciliation(recon({ h_broad_order: 51 }), TODAY).status, "MISMATCH");
  assert.equal(adsHourlyReconciliation(recon({ h_broad_gmv: 11447309 }), TODAY).status, "MISMATCH", "GMV exact");
  const material = adsHourlyReconciliation(recon({ h_expense: 1104162 - 500 }), TODAY);
  assert.equal(material.status, "MISMATCH");
  assert.match(material.reasons.join(" "), /-500/);
  assert.equal(adsHourlyReconciliation(recon({ campaigns_metric_mismatch: 3 }), TODAY).status, "MISMATCH");
  assert.equal(adsHourlyReconciliation(recon({ campaign_max_abs_expense_delta: 90 }), TODAY).status, "MISMATCH");
  assert.equal(adsHourlyReconciliation(recon({ hours: 23 }), TODAY).status, "INSUFFICIENT_DATA");
  assert.equal(adsHourlyReconciliation(recon({ has_daily: false }), TODAY).status, "INSUFFICIENT_DATA");
  assert.equal(adsHourlyReconciliation(recon({ campaigns_incomplete: 2 }), TODAY).status, "INSUFFICIENT_DATA");
  assert.equal(adsHourlyReconciliation(recon({ report_date: TODAY, hours: 15, h_broad_order: 1 }), TODAY).status, "IN_PROGRESS");
  // All shops: the strictest status wins
  const worst = worstReconciliation([adsHourlyReconciliation(recon(), TODAY), adsHourlyReconciliation(recon({ shop_id: "shop-2", hours: 20 }), TODAY)]);
  assert.equal(worst!.status, "INSUFFICIENT_DATA");
});

// ------------------------------------------------------------------ comparisons / peaks (46–47, 58)

test("47. same-hour yesterday: today 00h → last COMPLETED hour vs the same hours of yesterday; none when yesterday misses an hour", () => {
  const rows = [...rpcRows(TODAY), ...rpcRows(YESTERDAY)];
  const d = intraday(rows, 14);
  assert.equal(d.sameHourYesterday!.throughHour, 13);
  const y = rpcRows(YESTERDAY).filter((r) => r.report_hour <= 13).reduce((a, r) => a + Number(r.expense), 0);
  assert.equal(d.sameHourYesterday!.yesterday.spend, y, "not a full yesterday");
  assert.equal(d.sameHourYesterday!.today.spend, y, "same profile both days → identical");
  assert.equal(intraday([...rpcRows(TODAY), ...rpcRows(YESTERDAY, [0, 1, 2])], 14).sameHourYesterday, null);
  assert.equal(intraday(rows, 0).sameHourYesterday, null, "00h: no completed hour yet");
});

test("58. peaks are observational, completed hours only, and need enough data (ROAS peak: ≥ 10% of the spend and ≥ 10 clicks)", () => {
  const d = intraday(rpcRows(TODAY), 14);
  const done = rpcRows(TODAY).filter((r) => r.report_hour < 14);
  const maxSpend = done.reduce((a, r) => (Number(r.expense) > Number(a.expense) ? r : a));
  assert.deepEqual(d.peaks.find((p) => p.key === "spend")!.hour, maxSpend.report_hour);
  const roas = d.peaks.find((p) => p.key === "roas");
  if (roas) {
    const h = done.find((r) => r.report_hour === roas.hour)!;
    assert.ok(Number(h.clicks) >= 10 && Number(h.expense) >= 0.1 * done.reduce((a, r) => a + Number(r.expense), 0));
  }
  for (const p of d.peaks) assert.doesNotMatch(p.label, /tăng|giảm|tạm dừng|bid|ngân sách/i, "no action wording");
  assert.deepEqual(intraday(rpcRows(TODAY, [0, 1]), 2).peaks, [], "fewer than 3 completed hours → no peak");
});

test("49–50. statuses + freshness: disabled / empty / ok; stale after ADS_HOURLY_STALE_MINUTES", () => {
  assert.equal(intraday([], 10, { shops: { selected: 1, enabled: 0 }, lastSyncedByShop: [] }).status, "disabled");
  const empty = intraday([], 10, { lastSyncedByShop: [] });
  assert.equal(empty.status, "empty");
  assert.equal(empty.hours.length, 11);
  assert.ok(empty.hours.every((h) => h.metrics === null), "nothing synthesized from daily data");
  const fresh = intraday(rpcRows(TODAY), 14, { lastSyncedByShop: [new Date(NOW.getTime() - 20 * 60_000).toISOString()] });
  assert.equal(fresh.freshness.stale, false);
  const stale = intraday(rpcRows(TODAY), 14, { lastSyncedByShop: [new Date(NOW.getTime() - 40 * 60_000).toISOString(), NOW.toISOString()] });
  assert.equal(stale.freshness.stale, true, "All shops: the oldest shop decides");
});

// ------------------------------------------------------------------ scheduler plan (19–21, 38) + config (80)

const CONFIG = { ...getAdsSyncConfig({}), autoSyncEnabled: true, hourlySyncEnabled: true };

test("19–20. hourly rides the HOT slot (today only) BELOW the daily HOT priorities; disabled → nothing; daily backlog → hourly waits", () => {
  const base = { now: new Date("2026-10-28T07:45:30Z"), timeZone: "Asia/Ho_Chi_Minh", offsetMinutes: 0, slots: {}, config: CONFIG, hasCampaigns: true, performanceSynced: true };
  const plan = planAdsShop({ ...base, hourlyEnabled: true });
  const hourly = plan.find((p) => p.kind === "hot_hourly")!;
  assert.deepEqual(hourly.jobs.map((j) => [j.syncType, j.strategy, j.priority, j.range, j.scope]), [
    ["ads_shop_hourly_read", "hot", 4, { from: TODAY, to: TODAY }, undefined],
    ["ads_campaign_hourly_read", "hot", 5, { from: TODAY, to: TODAY }, "hot"],
  ]);
  const hotShop = plan.find((p) => p.kind === "hot_shop")!;
  assert.equal(hourly.slotAt.getTime(), hotShop.slotAt.getTime(), "same 15-minute slot as HOT (no separate scheduler)");
  assert.ok(hourly.jobs.every((j) => j.priority > ADS_PRIORITY.hotShop && j.priority > ADS_PRIORITY.hotCampaign));
  assert.equal(planAdsShop({ ...base, hourlyEnabled: false }).filter((p) => p.kind.includes("hourly")).length, 0);
  assert.equal(planAdsShop(base).filter((p) => p.kind.includes("hourly")).length, 0, "off unless enabled");
  const behind = planAdsShop({ ...base, hourlyEnabled: true, dailyHotBacklog: true });
  assert.ok(!behind.some((p) => p.kind === "hot_hourly"), "hourly waits while the daily HOT queue is behind");
  assert.ok(behind.some((p) => p.kind === "hot_shop"), "daily HOT unaffected");
});

test("18 / 38. finalize: once per day after 02:30 (shop-local), YESTERDAY only, ALL campaigns, low priority", () => {
  const at = (iso: string, slots = {}) => planAdsShop({ now: new Date(iso), timeZone: "Asia/Ho_Chi_Minh", offsetMinutes: 0, slots, config: CONFIG, hasCampaigns: true, performanceSynced: true, hourlyEnabled: true }).find((p) => p.kind === "hourly_finalize");
  const f = at("2026-10-28T19:31:00Z")!; // 02:31 VN on 29/10
  assert.deepEqual(f.jobs.map((j) => [j.syncType, j.strategy, j.priority, j.range, j.scope]), [
    ["ads_shop_hourly_read", "finalize", ADS_PRIORITY.hourlyFinalize, { from: TODAY, to: TODAY }, undefined],
    ["ads_campaign_hourly_read", "finalize", ADS_PRIORITY.hourlyFinalize, { from: TODAY, to: TODAY }, "all"],
  ]);
  assert.equal(at("2026-10-28T20:31:00Z", { last_hourly_finalize_slot_at: f.slotAt.toISOString() }), undefined, "not again the same day");
  assert.ok(ADS_PRIORITY.hourlyFinalize > ADS_PRIORITY.warm);
});

test("20. priority order: manual < HOT shop < HOT campaign < hourly shop < hourly campaign < WARM < metadata < COLD < backfill; manual hourly after manual daily", () => {
  const p = ADS_PRIORITY;
  const order = [p.manual, p.hotShop, p.hotCampaign, p.hotShopHourly, p.hotCampaignHourly, p.warm, p.metadata, p.cold, p.backfill];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(new Set(order).size, order.length);
  assert.ok(p.manualHourly > p.manual);
});

test("80. config: hourly OFF by default, retention 14 days (≥ 2), freshness 25 / 35 min, finalize 02:30", () => {
  const c = getAdsSyncConfig({});
  assert.deepEqual([c.hourlySyncEnabled, c.hourlyRetentionDays, c.hourlyFreshTargetMinutes, c.hourlyStaleMinutes, c.hourlyFinalizeTime], [false, 14, 25, 35, "02:30"]);
  const e = getAdsSyncConfig({ ADS_HOURLY_SYNC_ENABLED: "true", ADS_HOURLY_RETENTION_DAYS: "1", ADS_HOURLY_FINALIZE_TIME: "04:00" });
  assert.deepEqual([e.hourlySyncEnabled, e.hourlyRetentionDays, e.hourlyFinalizeTime], [true, 14, "04:00"], "retention below 2 days is refused");
});

// ------------------------------------------------------------------ provider: read only, verified shape (11–14)

test("11–14. hourly provider calls: GET allowlisted read endpoints, one date per call, ≤ 50 ids, read job types", async () => {
  for (const p of [ADS_READ_ENDPOINTS.shop_hourly_performance, ADS_READ_ENDPOINTS.campaign_hourly_performance]) {
    assert.ok(isAdsReadOnlyRequest("GET", p));
    assert.equal(isAdsReadOnlyRequest("POST", p), false);
  }
  for (const t of ["ads_shop_hourly_read", "ads_campaign_hourly_read"]) assert.ok(isAdsReadJobType(t));
  const ids = Array.from({ length: 51 }, (_, i) => String(900000001 + i));
  assert.throws(() => assertVerifiedAdsRequest("campaign_hourly", { ids, date: TODAY }), /50/);
  assert.throws(() => assertVerifiedAdsRequest("campaign_hourly", { ids: ids.slice(0, 2), date: "28-10-2026" }));
  assert.throws(() => assertVerifiedAdsRequest("shop_hourly", { date: "" }));
  const data = { ...loadAdsFixtures(), replayHourly: false };
  const p = new FixtureShopeeAdsProvider(data);
  const shop = await p.getAllCpcAdsHourlyPerformance({ shopId: "x", externalShopId: "1" }, { date: YESTERDAY });
  assert.equal(shop.apiName, ADS_READ_ENDPOINTS.shop_hourly_performance);
  assert.equal(((shop.raw as Obj).response as Obj[]).length, 24);
  assert.equal(((await p.getAllCpcAdsHourlyPerformance({ shopId: "x", externalShopId: "1" }, { date: TODAY })).raw as Obj).response instanceof Array, true);
  assert.equal((((await p.getAllCpcAdsHourlyPerformance({ shopId: "x", externalShopId: "1" }, { date: TODAY })).raw as Obj).response as Obj[]).length, 0, "no capture for that date + replay off → nothing invented");
});
