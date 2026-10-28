// ============================================================
// SHOPEE-ADS-0 — legacy Shopee modules retired, connector kept. Against the
// REAL database in .env.local (local Docker Supabase) with fixture providers:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/ads-retirement.integration.test.ts
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { getShopeeFlags, isLegacyShopeeApi, isLegacyShopeePage, legacyRedirectTarget } from "../../feature-flags.ts";
import { getSyncConfig } from "../core/sync-config.ts";
import { activeSyncTypes, LEGACY_DISABLED_CODE, PLANNED_ADS_SYNC_TYPES, retiredSyncTypes } from "../core/sync-domains.ts";
import { RUNNABLE_SYNC_TYPES, type SyncJobRow } from "../core/sync-jobs.ts";
import { SyncWorker } from "../core/sync-worker.ts";
import { AdsNotImplementedError, NotImplementedShopeeAdsProvider } from "./ads/provider.ts";
import { FixtureShopeeOrderProvider } from "./order-provider.ts";
import { FixtureShopeePaymentProvider } from "./payment-provider.ts";
import { FixtureShopeeProductProvider } from "./product-provider.ts";
import { toJobFailure } from "./sync-errors.ts";
import { createShopeeRunnerFactory, hasDueSyncJobs, requestShopeeSync, runShopeeSchedulerTick } from "./sync-service.ts";
import { keepShopeeTokensAlive } from "./token-keepalive.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `ads0${Date.now()}`;
const shopIds: string[] = [];
let n = 0;

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
});

async function shop(source: "fixture" | "live" = "fixture"): Promise<string> {
  const { data, error } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `${source.toUpperCase()}_${TAG}_${++n}`, shop_name: `ads0 ${n}`, currency: "VND", data_source: source }).select("id").single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

const legacyOff = getShopeeFlags({ SHOPEE_LEGACY_MODULES_ENABLED: "false", SHOPEE_ADS_ENABLED: "true" });

// ================================================================ pure

test("4/34: flags — legacy off by default, Ads on by default; there is no global Shopee switch", () => {
  assert.deepEqual(getShopeeFlags({}), { legacyModulesEnabled: false, adsEnabled: true });
  assert.deepEqual(getShopeeFlags({ SHOPEE_LEGACY_MODULES_ENABLED: "true", SHOPEE_ADS_ENABLED: "0" }), { legacyModulesEnabled: true, adsEnabled: false });
  assert.deepEqual(getShopeeFlags({ SHOPEE_LEGACY_MODULES_ENABLED: "maybe" }), { legacyModulesEnabled: false, adsEnabled: true }, "garbage → safe defaults");
  assert.deepEqual(activeSyncTypes(legacyOff), [], "no legacy job type may run");
  assert.deepEqual(retiredSyncTypes(legacyOff), [...RUNNABLE_SYNC_TYPES]);
  assert.deepEqual(activeSyncTypes(getShopeeFlags({ SHOPEE_LEGACY_MODULES_ENABLED: "true" })), [...RUNNABLE_SYNC_TYPES]);
  assert.ok(PLANNED_ADS_SYNC_TYPES.every((t) => !(RUNNABLE_SYNC_TYPES as readonly string[]).includes(t)), "Ads types are planned, not runnable");
});

test("7/8/43: route policy — every legacy page / API matched; OAuth, settings, Ads, internal scheduler NOT matched", () => {
  for (const p of ["/shopee/dashboard", "/shopee/analytics/products", "/shopee/products", "/shopee/orders/abc", "/shopee/returns", "/shopee/returns/operations/settings", "/shopee/payouts/x", "/shopee/sync", "/shopee/system-health"]) assert.ok(isLegacyShopeePage(p), p);
  for (const p of ["/shopee/ads", "/shopee/ads/settings", "/settings/shopee", "/shopee", "/shopee/ordersx", "/products"]) assert.ok(!isLegacyShopeePage(p), p);
  for (const p of ["/api/shopee/analytics/export", "/api/shopee/returns/operations/export"]) assert.ok(isLegacyShopeeApi(p), p);
  for (const p of ["/api/shopee/auth/start", "/api/shopee/auth/callback", "/api/shopee/test-connection", "/api/internal/shopee/sync-scheduler"]) assert.ok(!isLegacyShopeeApi(p), p);
  assert.equal(legacyRedirectTarget(legacyOff), "/shopee/ads");
  assert.equal(legacyRedirectTarget({ legacyModulesEnabled: false, adsEnabled: false }), "/dashboard");
});

test("27: Ads provider is a contract only — it never calls Shopee", async () => {
  const p = new NotImplementedShopeeAdsProvider();
  await assert.rejects(p.listCampaigns(), AdsNotImplementedError);
  await assert.rejects(p.getBudgetInfo(), AdsNotImplementedError);
});

// ================================================================ scheduler / worker

test("9/12/44/49: scheduler with legacy retired enqueues nothing, cancels pending / retry legacy jobs with the reason, leaves running + history rows intact", async () => {
  const s = await shop();
  const pending = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  const retry = await requestShopeeSync(db, { shopId: s, syncType: "escrow", mode: "incremental" });
  await db.from("channel_sync_jobs").update({ status: "retry", next_attempt_at: new Date(Date.now() + 60_000).toISOString() }).eq("id", retry.jobId);
  const running = await requestShopeeSync(db, { shopId: s, syncType: "product", mode: "incremental" });
  await db.from("channel_sync_jobs").update({ status: "running", lock_owner: "w", locked_at: new Date().toISOString() }).eq("id", running.jobId);
  const { data: hist } = await db.from("channel_sync_jobs").insert({ shop_id: s, sync_type: "return", mode: "incremental", status: "success", finished_at: new Date().toISOString() }).select("id").single();

  const config = { ...getSyncConfig({}), shopAllowlist: [s] };
  const tick = await runShopeeSchedulerTick(db, { config, providerMode: "fixture", syncTypes: activeSyncTypes(legacyOff), retiredSyncTypes: retiredSyncTypes(legacyOff) });
  assert.equal(tick.enqueued.length, 0, "no legacy job enqueued");
  assert.ok(tick.retiredCancelled >= 2);
  assert.equal(tick.workDue, false);
  const row = async (id: string) => (await db.from("channel_sync_jobs").select("*").eq("id", id).single()).data as SyncJobRow;
  for (const id of [pending.jobId, retry.jobId]) {
    const j = await row(id);
    assert.equal(j.status, "cancelled");
    assert.equal(j.error_code, LEGACY_DISABLED_CODE);
  }
  assert.equal((await row(running.jobId)).status, "running", "a running job is never interrupted");
  assert.equal((await row(hist!.id)).status, "success", "history untouched");
  // the scheduler keeps running without creating anything
  const tick2 = await runShopeeSchedulerTick(db, { config, providerMode: "fixture", syncTypes: [], retiredSyncTypes: retiredSyncTypes(legacyOff) });
  assert.equal(tick2.enqueued.length, 0);
  await db.from("channel_sync_jobs").update({ status: "cancelled", lock_owner: null }).eq("id", running.jobId);
});

test("11/45/47: the worker with no active domain claims nothing and makes zero provider calls, even with legacy jobs queued", async () => {
  const s = await shop();
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "manual" });
  let calls = 0;
  const config = { ...getSyncConfig({}), shopAllowlist: [s] };
  const worker = new SyncWorker({
    db,
    config,
    workerId: "ads0-w",
    syncTypes: activeSyncTypes(legacyOff),
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: () => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider({ listPages: [], ordersBySn: new Map() }, { onCall: () => void calls++ }),
        product: new FixtureShopeeProductProvider({ itemListPages: [], itemBaseInfo: { error: "", response: { item_list: [] } }, modelLists: {} }, { onCall: () => void calls++ }),
        payment: new FixtureShopeePaymentProvider(new Map()),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });
  assert.equal(await worker.runOne(30_000), null);
  const burst = await worker.runBurst({ timeBudgetMs: 25_000 });
  assert.equal(burst.slices.length, 0);
  assert.equal(calls, 0, "no Shopee call");
  assert.equal((await db.from("channel_sync_jobs").select("status").eq("id", q.jobId).single()).data!.status, "pending", "left for the scheduler to cancel");
  assert.equal(await hasDueSyncJobs(db, new Date(), []), false);
  await db.from("channel_sync_jobs").update({ status: "cancelled" }).eq("id", q.jobId);
});

// ================================================================ token keepalive

test("14/32: token keepalive refreshes only idle connected live shops (once a day), through the normal single-flight path; fresh / disconnected / fixture shops untouched", async () => {
  const [idle, fresh, gone] = [await shop("live"), await shop("live"), await shop("live")];
  const fixture = await shop("fixture");
  const old = new Date(Date.now() - 30 * 3600_000).toISOString();
  const expired = new Date(Date.now() - 3600_000).toISOString();
  const { error } = await db.from("shop_connections").insert([
    { shop_id: idle, connection_status: "connected", access_token_expires_at: expired, last_token_refresh_at: old },
    { shop_id: fresh, connection_status: "connected", access_token_expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(), last_token_refresh_at: new Date().toISOString() },
    { shop_id: gone, connection_status: "disconnected", access_token_expires_at: expired, last_token_refresh_at: old },
    { shop_id: fixture, connection_status: "connected", access_token_expires_at: expired, last_token_refresh_at: old },
  ]);
  if (error) throw error;
  const asked: string[] = [];
  const r = await keepShopeeTokensAlive(db, { getValidAccessToken: async (id) => (asked.push(id), "token") }, { maxIdleHours: 24 });
  const mine = asked.filter((id) => shopIds.includes(id));
  assert.deepEqual(mine, [idle], "only the idle connected live shop is refreshed");
  assert.ok(r.refreshed.includes(idle));
  // a failing refresh is reported, never thrown
  const r2 = await keepShopeeTokensAlive(db, { getValidAccessToken: async () => { throw new Error("error_auth: revoked"); } }, { maxIdleHours: 24 });
  assert.ok(r2.failed.some((f) => f.shopId === idle));
});

// ================================================================ data

test("19/49: legacy historical data stays readable (no row deleted by the retirement path)", async () => {
  const s = await shop();
  const { data: o } = await db.from("channel_orders").insert({ shop_id: s, external_order_sn: `${TAG}-HIST`, order_status: "COMPLETED", currency: "VND" }).select("id").single();
  await runShopeeSchedulerTick(db, { config: { ...getSyncConfig({}), shopAllowlist: [s] }, providerMode: "fixture", syncTypes: [], retiredSyncTypes: retiredSyncTypes(legacyOff) });
  assert.ok((await db.from("channel_orders").select("id").eq("id", o!.id).single()).data);
});
