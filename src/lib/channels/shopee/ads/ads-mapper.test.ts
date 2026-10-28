// ============================================================
// SHOPEE-ADS-1B — provider DTO → canonical mapping, from the REAL sanitized
// production fixtures (pure: no DB, no network):
//   node --test src/lib/channels/shopee/ads/ads-mapper.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AdsPayloadError,
  epochSecondsToIso,
  formatAdsDate,
  mapAdsCampaignStatus,
  mapAdsCampaignType,
  money,
  parseAdsDate,
  parseCampaignDailyPerformance,
  parseCampaignIdPage,
  parseCampaignSettings,
  parseShopDailyPerformance,
} from "./mapper.ts";
import { deriveMetrics } from "./metrics.ts";
import { loadAdsFixtures } from "./provider.ts";
import { addDaysIso, adsPerformanceRange, getAdsSyncConfig, shopToday, splitAdsRange } from "./sync.ts";
import { totalsOf } from "./real-source.ts";

const DIR = path.join(process.cwd(), "src/lib/channels/shopee/ads/__fixtures__/provider");
const fx = (name: string) => (JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as { response: unknown }).response;

test("campaign id list: ids as text, has_next_page, page length (real pages of 100 + 43)", () => {
  const p1 = parseCampaignIdPage(fx("exp-campaign-id-list"));
  const p2 = parseCampaignIdPage(fx("exp-campaign-id-list-2"));
  assert.equal(p1.count, 100);
  assert.equal(p1.hasNextPage, true);
  assert.equal(p2.count, 43);
  assert.equal(p2.hasNextPage, false);
  assert.ok(p1.campaignIds.every((id) => typeof id === "string" && /^\d+$/.test(id)));
  assert.equal(new Set([...p1.campaignIds, ...p2.campaignIds]).size, 143);
});

test("campaign settings: raw provider values kept, daily budget, epoch SECONDS, end 0 → null, roas_target only for auto bidding, item ids", () => {
  const all = ["exp-campaign-setting-info", "exp-campaign-setting-info-2", "exp-campaign-setting-info-3"].flatMap((f) => parseCampaignSettings(fx(f)).campaigns);
  assert.equal(all.length, 143);
  const statuses = new Set(all.map((c) => c.providerStatus));
  assert.deepEqual([...statuses].sort(), ["closed", "ended", "ongoing", "paused"]);
  const first = all.find((c) => c.providerStatus === "ended" && c.providerBiddingMethod === "auto")!;
  assert.equal(first.providerStartAt, "2025-03-30T17:00:00.000Z", "1743354000 s = 2025-03-31 00:00 in VN");
  const ongoing = all.find((c) => c.providerStatus === "ongoing")!;
  assert.equal(ongoing.providerEndAt, null, "end_time 0 = no end date");
  assert.match(ongoing.dailyBudget ?? "", /^\d+$/, "VND integer kept as an exact decimal string");
  for (const c of all) {
    if (c.providerBiddingMethod === "manual") assert.equal(c.roasTarget, null, "manual bidding has no auto_bidding_info");
    assert.equal(c.itemIds.length, 1, "every verified campaign advertises exactly one item");
  }
  assert.ok(all.some((c) => c.dailyBudget === "0"), "budget 0 stored as provided (meaning unknown)");
});

test("campaign daily performance: primitives only; *_order_amount → item_sold; NO provider ratio (cpc / roi / cir …) is mapped", () => {
  const { rows, failures, missingFields } = parseCampaignDailyPerformance(fx("exp-campaign-daily-performance"));
  assert.equal(failures.length, 0);
  assert.equal(missingFields, 0);
  assert.equal(rows.length, 50);
  const nonZero = rows.find((r) => r.expense === "92959")!; // campaign #26 on 27/10
  assert.deepEqual(nonZero, {
    providerCampaignId: nonZero.providerCampaignId,
    reportDate: "2026-10-27",
    expense: "92959",
    impression: 2763,
    clicks: 168,
    directOrder: 9,
    broadOrder: 9,
    directGmv: "926480",
    broadGmv: "926480",
    directItemSold: 10,
    broadItemSold: 10,
  });
  for (const key of ["cpc", "cpdc", "ctr", "broad_roi", "direct_roi", "broad_cir", "direct_cir", "cr", "direct_cr"]) {
    assert.ok(!(key in nonZero), `provider ratio "${key}" must not be mapped`);
  }
});

test("REGRESSION provider cpc ≠ click CPC: Shopee cpc = expense / broad_order; the UI CPC = spend / clicks", () => {
  const raw = (fx("exp-campaign-daily-performance") as { response: { campaign_list: Array<{ metrics_list: Array<Record<string, number>> }> } }).response.campaign_list
    .flatMap((c) => c.metrics_list)
    .find((m) => m.expense === 300000)!; // campaign #40: expense 300000, clicks 172, broad_order 15
  assert.equal(raw.cpc, 20000, "provider cpc");
  assert.equal(raw.expense / raw.broad_order, 20000, "provider cpc is cost per BROAD ORDER");
  const row = parseCampaignDailyPerformance({ response: { campaign_list: [{ campaign_id: 1, metrics_list: [raw] }] } }).rows[0];
  const ui = deriveMetrics(totalsOf([{ expense: row.expense, impression: row.impression, clicks: row.clicks, direct_order: row.directOrder, broad_order: row.broadOrder, direct_gmv: row.directGmv, broad_gmv: row.broadGmv }]));
  assert.ok(Math.abs(ui.cpc! - 300000 / 172) < 1e-9, "UI CPC = spend / clicks");
  assert.notEqual(Math.round(ui.cpc!), raw.cpc, "the provider field is never shown as CPC");
});

test("shop daily performance (all CPC ads): DD-MM-YYYY → DATE, 30 rows, exact primitives", () => {
  const { rows, missingFields } = parseShopDailyPerformance(fx("exp-shop-daily-performance-2"));
  assert.equal(rows.length, 30);
  assert.equal(missingFields, 0);
  assert.equal(rows[0].reportDate, "2026-09-28");
  const d27 = rows.find((r) => r.reportDate === "2026-10-27")!;
  assert.deepEqual(d27, { reportDate: "2026-10-27", expense: "1104162", impression: 36145, clicks: 1042, directOrder: 41, broadOrder: 52, directGmv: "10966208", broadGmv: "11447308", directItemSold: 43, broadItemSold: 54 });
});

test("dates: strict DD-MM-YYYY parsing (no locale parser), round trip, invalid days refused", () => {
  assert.equal(parseAdsDate("27-10-2026"), "2026-10-27");
  assert.equal(formatAdsDate("2026-10-27"), "27-10-2026");
  for (const bad of ["2026-10-27", "31-02-2026", "27/10/2026", "", 20261027]) assert.throws(() => parseAdsDate(bad), AdsPayloadError, String(bad));
});

test("epoch unit: seconds converted; millisecond-looking values refused (never guessed)", () => {
  assert.equal(epochSecondsToIso(1743354000), "2025-03-30T17:00:00.000Z");
  assert.equal(epochSecondsToIso(0), null);
  assert.equal(epochSecondsToIso(null), null);
  assert.throws(() => epochSecondsToIso(1743354000000), AdsPayloadError);
});

test("money: integer VND exact, decimals kept to 2 places, negatives / garbage refused", () => {
  assert.equal(money(1104162), "1104162");
  assert.equal(money("926480"), "926480");
  assert.equal(money(12.5), "12.5");
  assert.throws(() => money(-1), AdsPayloadError);
  assert.throws(() => money("12a"), AdsPayloadError);
});

test("unknown / null / zero / abnormal rows never fail the batch", () => {
  // unknown status: stored raw, UI neutral
  const s = parseCampaignSettings({ response: { campaign_list: [{ campaign_id: 7, common_info: { campaign_status: "scheduled_new", ad_type: "brand_new_type", item_id_list: [] }, auto_bidding_info: null }] } });
  assert.equal(s.campaigns[0].providerStatus, "scheduled_new");
  assert.equal(s.campaigns[0].providerAdType, "brand_new_type");
  assert.equal(mapAdsCampaignStatus("scheduled_new"), "unknown");
  assert.equal(mapAdsCampaignType("manual", "new_place"), "other");
  // one broken campaign does not drop the others
  const mixed = parseCampaignSettings({ response: { campaign_list: [{ campaign_id: "x" }, { campaign_id: 8, common_info: { campaign_status: "ongoing" } }] } });
  assert.equal(mixed.campaigns.length, 1);
  assert.equal(mixed.failures.length, 1);
  // missing optional metric fields → 0 and counted (not a failure)
  const missing = parseShopDailyPerformance({ response: [{ date: "27-10-2026", expense: 10 }] });
  assert.equal(missing.rows[0].clicks, 0);
  assert.ok(missing.missingFields > 0);
  // zero metrics: ratios null, no NaN / Infinity
  const zero = deriveMetrics(totalsOf([{ expense: 0, impression: 0, clicks: 0, direct_order: 0, broad_order: 0, direct_gmv: 0, broad_gmv: 0 }]));
  for (const k of ["roas", "acos", "ctr", "cpc", "conversionRate", "directRoas", "directAcos", "directConversionRate"] as const) assert.equal(zero[k], null, k);
  // abnormal real row: broad_order 1, broad_gmv 0 (campaign #123 on 27/10) — persisted exactly
  const abnormal = parseCampaignDailyPerformance(fx("exp-campaign-daily-performance-3")).rows.find((r) => r.broadOrder === 1 && r.broadGmv === "0")!;
  assert.ok(abnormal, "the real abnormal row is in the fixtures");
  const m = deriveMetrics(totalsOf([{ expense: abnormal.expense, impression: abnormal.impression, clicks: abnormal.clicks, direct_order: abnormal.directOrder, broad_order: abnormal.broadOrder, direct_gmv: abnormal.directGmv, broad_gmv: abnormal.broadGmv }]));
  assert.equal(m.roas, 0);
  assert.equal(m.acos, null, "ACOS undefined when GMV is 0");
  // hourly rows are refused in the daily tables
  assert.equal(parseCampaignDailyPerformance(fx("exp-campaign-hourly-performance")).failures.length, 1);
});

test("windows: refresh = today + 7 completed days (provisional), first sync = 30-day backfill; split ≤7 / ≤30 days", () => {
  const now = new Date("2026-10-28T09:30:00Z");
  const config = getAdsSyncConfig({});
  assert.equal(config.restatementDays, 7);
  assert.equal(shopToday(new Date("2026-10-27T17:30:00Z"), "Asia/Ho_Chi_Minh"), "2026-10-28", "shop timezone, not UTC");
  assert.deepEqual(adsPerformanceRange(now, "Asia/Ho_Chi_Minh", config, false), { from: "2026-10-21", to: "2026-10-28" });
  assert.deepEqual(adsPerformanceRange(now, "Asia/Ho_Chi_Minh", config, true), { from: "2026-09-28", to: "2026-10-28" });
  const w7 = splitAdsRange({ from: "2026-09-28", to: "2026-10-28" }, 7);
  assert.equal(w7.length, 5);
  assert.deepEqual(w7[0], { from: "2026-09-28", to: "2026-10-04" });
  assert.deepEqual(w7.at(-1), { from: "2026-10-26", to: "2026-10-28" });
  assert.deepEqual(splitAdsRange({ from: "2026-09-28", to: "2026-10-28" }, 30), [{ from: "2026-09-28", to: "2026-10-27" }, { from: "2026-10-28", to: "2026-10-28" }]);
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
  assert.equal(getAdsSyncConfig({ ADS_PERFORMANCE_RESTATEMENT_DAYS: "3" }).restatementDays, 3);
  assert.equal(getAdsSyncConfig({ ADS_PERFORMANCE_RESTATEMENT_DAYS: "999" }).restatementDays, 7, "out of range → default");
});

test("fixture provider data: complete masked campaign set + 30-day shop window + today's partial row", () => {
  const d = loadAdsFixtures();
  assert.equal(d.campaignIds.length, 143);
  assert.equal(d.settings.size, 143);
  assert.ok(d.shopDaily.has("27-10-2026") && d.shopDaily.has("28-10-2026") && d.shopDaily.has("28-09-2026"));
});
