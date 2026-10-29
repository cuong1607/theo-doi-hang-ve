// ============================================================
// SHOPEE-ADS-2 — pure scheduler planning (no DB):
//   node --test src/lib/channels/shopee/ads/ads-schedule.test.ts
// Slot maths, multi-shop staggering over simulated time, COLD times in
// Asia/Ho_Chi_Minh, HOT = today only, deterministic jitter, config defaults.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { adsJitterMs, adsShopOffsets, latestAdsSlot, latestColdSlot, planAdsShop, type AdsSlotState } from "./schedule.ts";
import { ShopeeApiError } from "../errors.ts";
import { ADS_PRIORITY, getAdsSyncConfig, invalidAdsCampaignIds } from "./sync.ts";

const TZ = "Asia/Ho_Chi_Minh";
const config = { ...getAdsSyncConfig({}), autoSyncEnabled: true };

test("config defaults match the ADS-2 production defaults (auto sync OFF until the pilot is validated)", () => {
  const c = getAdsSyncConfig({});
  assert.equal(c.autoSyncEnabled, false);
  assert.equal(c.hotIntervalMinutes, 15);
  assert.equal(c.campaignHotIntervalMinutes, 15);
  assert.equal(c.warmIntervalMinutes, 60);
  assert.equal(c.warmRestatementDays, 3);
  assert.equal(c.restatementDays, 7);
  assert.equal(c.metadataIntervalMinutes, 360);
  assert.equal(c.initialBackfillDays, 30);
  assert.equal(c.globalApiConcurrency, 2);
  assert.equal(c.perShopApiConcurrency, 1);
  assert.deepEqual(c.coldTimes, ["03:00", "15:00"]);
  assert.equal(c.coldTimeZone, TZ);
  assert.equal(getAdsSyncConfig({ ADS_AUTO_SYNC_ENABLED: "true" }).autoSyncEnabled, true);
  assert.deepEqual(getAdsSyncConfig({ ADS_COLD_RESTATEMENT_TIMES: "15:00,03:30" }).coldTimes, ["03:30", "15:00"]);
  assert.deepEqual(getAdsSyncConfig({ ADS_COLD_RESTATEMENT_TIMES: "25:00" }).coldTimes, ["03:00", "15:00"], "invalid → default");
  assert.equal(getAdsSyncConfig({ ADS_HOT_INTERVAL_MINUTES: "5" }).hotIntervalMinutes, 15, "never faster than upstream (≥10 min)");
});

test("offsets: explicit slot wins, else (rank × 2) mod 10 by shop id → 0,2,4,6,8; stable for the same set", () => {
  const shops = ["e", "a", "c", "b", "d"].map((id) => ({ id, syncSlot: null }));
  const o = adsShopOffsets(shops);
  assert.deepEqual(["a", "b", "c", "d", "e"].map((id) => o.get(id)), [0, 2, 4, 6, 8]);
  assert.deepEqual(adsShopOffsets([...shops].reverse()), o, "order-independent");
  assert.equal(adsShopOffsets([{ id: "a", syncSlot: 7 }]).get("a"), 7);
});

test("slot maths: 15-min windows aligned to :00/:15/:30/:45 + offset; COLD at 03:00 / 15:00 Vietnam time + stagger", () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(latestAdsSlot(at("2026-10-28T10:14:59Z"), 15, 0).toISOString(), "2026-10-28T10:00:00.000Z");
  assert.equal(latestAdsSlot(at("2026-10-28T10:15:00Z"), 15, 0).toISOString(), "2026-10-28T10:15:00.000Z");
  assert.equal(latestAdsSlot(at("2026-10-28T10:01:00Z"), 15, 2).toISOString(), "2026-10-28T09:47:00.000Z");
  assert.equal(latestAdsSlot(at("2026-10-28T10:02:00Z"), 15, 2).toISOString(), "2026-10-28T10:02:00.000Z");
  assert.equal(latestAdsSlot(at("2026-10-28T10:40:00Z"), 60, 5).toISOString(), "2026-10-28T10:05:00.000Z");
  // 03:00 VN = 20:00Z the day before; 15:00 VN = 08:00Z
  assert.equal(latestColdSlot(at("2026-10-28T07:59:00Z"), ["03:00", "15:00"], TZ, 0)!.toISOString(), "2026-10-27T20:00:00.000Z");
  assert.equal(latestColdSlot(at("2026-10-28T08:00:00Z"), ["03:00", "15:00"], TZ, 0)!.toISOString(), "2026-10-28T08:00:00.000Z");
  assert.equal(latestColdSlot(at("2026-10-28T08:05:00Z"), ["03:00", "15:00"], TZ, 6)!.toISOString(), "2026-10-27T20:06:00.000Z", "stagger: shop with offset 3 → 15:06");
});

test("jitter: deterministic, 0–20 s, varies by shop and slot", () => {
  const slot = new Date("2026-10-28T10:00:00Z");
  const a = adsJitterMs("shop-a", slot, 20);
  assert.equal(adsJitterMs("shop-a", slot, 20), a);
  assert.ok(a >= 0 && a <= 20_000 && a % 1000 === 0);
  const values = new Set(Array.from({ length: 30 }, (_, i) => adsJitterMs(`shop-${i}`, slot, 20)));
  assert.ok(values.size > 5, "spread across shops");
  assert.equal(adsJitterMs("shop-a", slot, 0), 0);
});

/** Applies a plan like the DB tick does (claim slot → "enqueue"). */
function applyPlan(slots: AdsSlotState, plan: ReturnType<typeof planAdsShop>) {
  for (const p of plan) slots[p.column] = p.slotAt.toISOString();
}

test("simulated time, 5 shops: HOT at :00 :02 :04 :06 :08, again 15 min later, never twice per slot (minute heartbeat)", () => {
  const ids = ["s1", "s2", "s3", "s4", "s5"];
  const offsets = adsShopOffsets(ids.map((id) => ({ id, syncSlot: null })));
  const slots = new Map(ids.map((id) => [id, {} as AdsSlotState]));
  // settled shops: catalogue + history present, all non-HOT slots already taken
  for (const s of slots.values()) Object.assign(s, { last_warm_slot_at: "2026-10-28T10:00:00Z", last_cold_slot_at: "2026-10-28T08:00:00Z", last_metadata_slot_at: "2026-10-28T08:00:00Z", last_hot_shop_slot_at: "2026-10-28T09:59:00Z", last_hot_campaign_slot_at: "2026-10-28T09:59:00Z" });
  const hotLog: string[] = [];
  for (let m = 0; m <= 31; m++) {
    const now = new Date(Date.parse("2026-10-28T10:00:00Z") + m * 60_000);
    for (const id of ids) {
      const plan = planAdsShop({ now, timeZone: TZ, offsetMinutes: offsets.get(id)!, slots: slots.get(id)!, config, hasCampaigns: true, performanceSynced: true });
      for (const p of plan) if (p.kind === "hot_shop") hotLog.push(`${String(m).padStart(2, "0")}:${id}`);
      applyPlan(slots.get(id)!, plan);
    }
  }
  assert.deepEqual(hotLog, ["00:s1", "02:s2", "04:s3", "06:s4", "08:s5", "15:s1", "17:s2", "19:s3", "21:s4", "23:s5", "30:s1"]);
});

test("HOT jobs: shop total (prio 2) + ACTIVE campaigns (prio 3), TODAY only — never a 7-day window", () => {
  const now = new Date("2026-10-28T09:30:00Z");
  const plan = planAdsShop({ now, timeZone: TZ, offsetMinutes: 0, slots: { last_warm_slot_at: now.toISOString(), last_cold_slot_at: now.toISOString(), last_metadata_slot_at: now.toISOString() }, config, hasCampaigns: true, performanceSynced: true });
  assert.deepEqual(plan.map((p) => p.kind), ["hot_shop", "hot_campaign"]);
  const jobs = plan.flatMap((p) => p.jobs);
  assert.deepEqual(jobs.map((j) => [j.syncType, j.strategy, j.priority, j.range, j.scope]), [
    ["ads_shop_performance_read", "hot", ADS_PRIORITY.hotShop, { from: "2026-10-28", to: "2026-10-28" }, undefined],
    ["ads_campaign_performance_read", "hot", ADS_PRIORITY.hotCampaign, { from: "2026-10-28", to: "2026-10-28" }, "hot"],
  ]);
});

test("WARM hourly (3 completed days), COLD at 15:00 (7 days + today, ALL campaigns), metadata every 6 h; priorities HOT < WARM < metadata < COLD < backfill", () => {
  const now = new Date("2026-10-28T08:10:00Z"); // 15:10 VN
  const plan = planAdsShop({ now, timeZone: TZ, offsetMinutes: 0, slots: { last_hot_shop_slot_at: now.toISOString(), last_hot_campaign_slot_at: now.toISOString() }, config, hasCampaigns: true, performanceSynced: true });
  const byKind = Object.fromEntries(plan.map((p) => [p.kind, p]));
  assert.deepEqual(Object.keys(byKind).sort(), ["cold", "metadata", "warm"]);
  assert.deepEqual(byKind.warm.jobs.map((j) => [j.syncType, j.range, j.scope ?? null]), [
    ["ads_shop_performance_read", { from: "2026-10-25", to: "2026-10-27" }, null],
    ["ads_campaign_performance_read", { from: "2026-10-25", to: "2026-10-27" }, "warm"],
  ]);
  assert.deepEqual(byKind.cold.jobs.map((j) => [j.syncType, j.range, j.scope ?? null]), [
    ["ads_shop_performance_read", { from: "2026-10-21", to: "2026-10-28" }, null],
    ["ads_campaign_performance_read", { from: "2026-10-21", to: "2026-10-28" }, "all"],
  ]);
  assert.equal(byKind.metadata.jobs[0].syncType, "ads_campaign_read");
  assert.equal(byKind.metadata.slotAt.toISOString(), "2026-10-28T06:10:00.000Z", "6-hour cadence (+10 min offset)");
  assert.ok(ADS_PRIORITY.manual < ADS_PRIORITY.hotShop && ADS_PRIORITY.hotShop < ADS_PRIORITY.hotCampaign && ADS_PRIORITY.hotCampaign < ADS_PRIORITY.warm && ADS_PRIORITY.warm < ADS_PRIORITY.metadata && ADS_PRIORITY.metadata < ADS_PRIORITY.cold && ADS_PRIORITY.cold < ADS_PRIORITY.backfill);
  // metadata is not re-planned within its 6 h window (not every 15 minutes)
  const later = new Date("2026-10-28T09:10:00Z");
  const again = planAdsShop({ now: later, timeZone: TZ, offsetMinutes: 0, slots: Object.fromEntries(plan.map((p) => [p.column, p.slotAt.toISOString()])), config, hasCampaigns: true, performanceSynced: true });
  assert.ok(!again.some((p) => p.kind === "metadata" || p.kind === "cold"));
});

test("new shop: metadata every 15 min until the catalogue exists (prio 2); first performance = 30-day BACKFILL instead of WARM; no COLD before it", () => {
  const now = new Date("2026-10-28T09:30:00Z");
  const fresh = planAdsShop({ now, timeZone: TZ, offsetMinutes: 0, slots: {}, config, hasCampaigns: false, performanceSynced: false });
  const kinds = Object.fromEntries(fresh.map((p) => [p.kind, p]));
  assert.deepEqual(Object.keys(kinds).sort(), ["backfill", "cold", "hot_shop", "metadata"]);
  assert.equal(kinds.metadata.jobs[0].priority, ADS_PRIORITY.metadataInitial);
  assert.deepEqual(kinds.backfill.jobs.map((j) => [j.syncType, j.range, j.priority]), [
    ["ads_shop_performance_read", { from: "2026-09-28", to: "2026-10-28" }, ADS_PRIORITY.backfill],
    ["ads_campaign_performance_read", { from: "2026-09-28", to: "2026-10-28" }, ADS_PRIORITY.backfill],
  ]);
  assert.deepEqual(kinds.cold.jobs, [], "COLD slot consumed without jobs before the first backfill");
  assert.ok(!kinds.hot_campaign, "no campaign HOT before the catalogue exists");
  // still no catalogue 15 minutes later → metadata again
  const slots: AdsSlotState = Object.fromEntries(fresh.map((p) => [p.column, p.slotAt.toISOString()]));
  const next = planAdsShop({ now: new Date("2026-10-28T09:45:00Z"), timeZone: TZ, offsetMinutes: 0, slots, config, hasCampaigns: false, performanceSynced: false });
  assert.deepEqual(next.map((p) => p.kind).sort(), ["hot_shop", "metadata"]);
});

test("WARM can be disabled (ADS_WARM_RESTATEMENT_DAYS=0) without touching HOT", () => {
  const now = new Date("2026-10-28T09:30:00Z");
  const plan = planAdsShop({ now, timeZone: TZ, offsetMinutes: 0, slots: { last_cold_slot_at: now.toISOString(), last_metadata_slot_at: now.toISOString() }, config: { ...config, warmRestatementDays: 0 }, hasCampaigns: true, performanceSynced: true });
  assert.deepEqual(plan.map((p) => p.kind), ["hot_shop", "hot_campaign"]);
});

test("ADS-2.1: a failed backfill is re-planned even after HOT succeeded; only the missing type is re-read; no COLD before it", () => {
  const now = new Date("2026-10-29T04:05:30Z");
  const plan = planAdsShop({ now, timeZone: TZ, offsetMinutes: 0, slots: {}, config, hasCampaigns: true, performanceSynced: false, backfilled: { shop: true, campaign: false } });
  const backfill = plan.find((p) => p.kind === "backfill");
  assert.ok(backfill, "backfill slot planned");
  assert.deepEqual(backfill.jobs.map((j) => [j.syncType, j.strategy, j.scope]), [["ads_campaign_performance_read", "backfill", "all"]]);
  assert.equal(plan.find((p) => p.kind === "warm"), undefined);
  assert.deepEqual(plan.find((p) => p.kind === "cold")?.jobs ?? [], []);
});

test("ADS-2.1: Shopee's 'invalid product ads campaign ids' error names the ids to drop (only ids of the batch)", () => {
  const err = (message: string) => new ShopeeApiError({ apiPath: "/api/v2/ads/get_product_campaign_daily_performance", errorCode: "error_param", message });
  assert.deepEqual(invalidAdsCampaignIds(err("Wrong parameters. campaign_id_list: has invalid product ads campaign ids- 20932764;"), ["1", "20932764"]), ["20932764"]);
  assert.deepEqual(invalidAdsCampaignIds(err("campaign_id_list: has invalid product ads campaign ids- 5, 6;"), ["5", "6", "7"]), ["5", "6"]);
  assert.deepEqual(invalidAdsCampaignIds(err("has invalid product ads campaign ids- 99;"), ["5"]), [], "an id outside the batch is never dropped");
  assert.deepEqual(invalidAdsCampaignIds(err("Wrong parameters. start_date invalid"), ["5"]), []);
  assert.deepEqual(invalidAdsCampaignIds(new Error("has invalid product ads campaign ids- 5"), ["5"]), [], "only a provider error");
});
