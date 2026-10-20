// ============================================================
// SHOPEE-9A — production hardening against the REAL database in .env.local
// (local Docker Supabase) with FIXTURE providers:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/hardening.integration.test.ts
//
// Every worker / scheduler is scoped to this file's own shops (allowlist).
// Shared rows touched (heartbeats) are saved and restored.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { retryDelaySeconds } from "../core/retry-policy.ts";
import { getSyncConfig, SLO_DEFAULT_MINUTES, type SyncConfig } from "../core/sync-config.ts";
import { getHeartbeats, RATE_LIMIT_HEARTBEAT, SCHEDULER_HEARTBEAT, WORKER_HEARTBEAT } from "../core/sync-heartbeat.ts";
import { claimNextSyncJob, JobLease, type SyncJobRow } from "../core/sync-jobs.ts";
import { SyncWorker } from "../core/sync-worker.ts";
import { deriveShopHealth, getSystemHealth, setShopSyncEnabled, type DomainFreshness } from "../core/system-health.ts";
import { ShopeeApiError } from "./errors.ts";
import { FixtureShopeeOrderProvider, type OrderFixtureSet } from "./order-provider.ts";
import { FixtureShopeePaymentProvider } from "./payment-provider.ts";
import { ShopeePayloadError } from "./product-adapter.ts";
import { FixtureShopeeProductProvider } from "./product-provider.ts";
import { errorCategoryOf, toJobFailure } from "./sync-errors.ts";
import { createShopeeRunnerFactory, pruneRetention, requestShopeeSync, runShopeeSyncScheduler } from "./sync-service.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `h9a${Date.now()}`;
const NOW = Math.floor(Date.now() / 1000);
const shopIds: string[] = [];
let n = 0;
let savedBeats: Array<Record<string, unknown>> = [];

before(async () => {
  // the rate-limit marker is never restored (it would re-open a cooldown from an earlier test run)
  savedBeats = ((await db.from("channel_sync_heartbeats").select("*").neq("name", RATE_LIMIT_HEARTBEAT)).data ?? []) as Array<Record<string, unknown>>;
});

after(async () => {
  if (shopIds.length) {
    await db.from("channel_api_snapshots").delete().in("shop_id", shopIds);
    await db.from("shops").delete().in("id", shopIds);
  }
  await db.from("channel_sync_heartbeats").delete().in("name", [SCHEDULER_HEARTBEAT, WORKER_HEARTBEAT, RATE_LIMIT_HEARTBEAT]);
  if (savedBeats.length) await db.from("channel_sync_heartbeats").upsert(savedBeats, { onConflict: "name" });
});

async function shop(name = `h9a ${n + 1}`): Promise<string> {
  const { data, error } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: name, currency: "VND", data_source: "fixture" }).select("id").single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

async function settle(ids: string[]) {
  await db.from("channel_sync_jobs").update({ status: "cancelled", lock_owner: null, locked_at: null }).in("shop_id", ids).in("status", ["pending", "running", "retry"]);
}

const row = async (id: string) => (await db.from("channel_sync_jobs").select("*").eq("id", id).single()).data as SyncJobRow;

function orderFixtures(sns: string[]): OrderFixtureSet {
  const ordersBySn = new Map<string, unknown>();
  for (const sn of sns) {
    ordersBySn.set(sn, {
      order_sn: sn,
      order_status: "COMPLETED",
      create_time: NOW - 7200,
      update_time: NOW - 3600,
      currency: "VND",
      total_amount: 100000,
      item_list: [{ order_item_id: 1, item_id: 1, item_name: "Item 1", item_sku: "", model_id: 0, model_sku: "", model_original_price: 60000, model_discounted_price: 45000, model_quantity_purchased: 1 }],
    });
  }
  const listPages = [{ error: "", message: "", request_id: "fx", response: { more: false, next_cursor: "", order_list: sns.map((order_sn) => ({ order_sn, order_status: "COMPLETED" })) } }];
  return { listPages, ordersBySn };
}

async function catalog(shopId: string) {
  const { data: cp } = await db.from("channel_products").upsert({ shop_id: shopId, external_item_id: "1", item_name: "Item 1", has_model: false }, { onConflict: "shop_id,external_item_id" }).select("id").single();
  await db.from("channel_product_models").upsert({ channel_product_id: cp!.id, external_model_id: "NO_MODEL", is_synthetic: true }, { onConflict: "channel_product_id,external_model_id" });
}

function worker(shops: string[], opts: { orders?: OrderFixtureSet; config?: Partial<SyncConfig>; failShop?: { id: string; err: () => Error } } = {}) {
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: shops, globalWorkers: 5, ...opts.config };
  const w = new SyncWorker({
    db,
    config,
    workerId: `h9a-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: (j) => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider(opts.orders ?? orderFixtures([]), {
          onCall: () => {
            if (opts.failShop && j.shop_id === opts.failShop.id) throw opts.failShop.err();
          },
        }),
        product: new FixtureShopeeProductProvider({ itemListPages: [], itemBaseInfo: { error: "", response: { item_list: [] } }, modelLists: {} }),
        payment: new FixtureShopeePaymentProvider(new Map()),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });
  return { w, config };
}

// ================================================================ pure

test("10/11: backoff 1 → 5 → 15 → 30 → 60 min; a rate-limited retry never sooner than 5 min; error categories", () => {
  const r0 = () => 0;
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((a) => retryDelaySeconds(a, { random: r0 })), [60, 300, 900, 1800, 3600, 3600]);
  assert.equal(retryDelaySeconds(1, { random: r0, rateLimited: true }), 300);
  assert.equal(retryDelaySeconds(1, { random: r0, retryAfterSeconds: 1200 }), 1200, "provider Retry-After wins when longer");
  assert.equal(errorCategoryOf(new ShopeeApiError({ apiPath: "/x", errorCode: "error_auth", message: "invalid token", httpStatus: 403 })), "AUTH");
  assert.equal(errorCategoryOf(new ShopeeApiError({ apiPath: "/x", errorCode: "too_many_request", message: "", httpStatus: 429 })), "RATE_LIMIT");
  assert.equal(errorCategoryOf(new ShopeeApiError({ apiPath: "/x", errorCode: "error_server", message: "", httpStatus: 500 })), "PROVIDER_TEMPORARY");
  assert.equal(errorCategoryOf(new ShopeeApiError({ apiPath: "/x", errorCode: "timeout", message: "" })), "TIMEOUT");
  assert.equal(errorCategoryOf(new ShopeeApiError({ apiPath: "/x", errorCode: "network_error", message: "" })), "NETWORK");
  assert.equal(errorCategoryOf(new ShopeeApiError({ apiPath: "/x", errorCode: "error_param", message: "" })), "PROVIDER_INVALID_REQUEST");
  assert.equal(errorCategoryOf(new ShopeePayloadError("v2.x", "bad")), "DATA_MAPPING");
  assert.equal(errorCategoryOf(new Error("Không lưu được đơn X: connection reset")), "DATABASE");
  const fatal = toJobFailure(new ShopeePayloadError("v2.x", "bad"));
  assert.equal(fatal.kind, "fatal", "a mapping error is never retried blindly");
});

test("63/64: config flags + SLOs — auto-sync off, disabled types, SLO override, invalid values reported", () => {
  const c = getSyncConfig({ SHOPEE_AUTO_SYNC_ENABLED: "false", SHOPEE_SYNC_DISABLED_TYPES: "payout,bogus", SHOPEE_SLO_ORDER_MINUTES: "12", SHOPEE_SLO_ESCROW_MINUTES: "x" });
  assert.equal(c.autoSyncEnabled, false);
  assert.deepEqual(c.disabledSyncTypes, ["payout"]);
  assert.equal(c.sloMinutes.order, 12);
  assert.equal(c.sloMinutes.escrow, SLO_DEFAULT_MINUTES.escrow);
  assert.equal(c.warnings.length, 2);
  assert.equal(getSyncConfig({}).maxRunningPerShop, 1);
});

test("35: shop health derivation", () => {
  const now = new Date();
  const d = (type: string, status: DomainFreshness["status"], extra: Partial<DomainFreshness> = {}): DomainFreshness => ({ type, label: type, lastSyncedAt: null, ageMinutes: 1, sloMinutes: 10, status, pending: 0, running: 0, retrying: 0, failed24h: 0, lastErrorCode: null, ...extra });
  const ok = ["product", "order", "escrow", "return"].map((t) => d(t, "ok"));
  const base = { connectionStatus: "connected", syncEnabled: true, pausedUntil: null, pauseReason: null, now };
  assert.equal(deriveShopHealth({ ...base, domains: ok }), "healthy");
  assert.equal(deriveShopHealth({ ...base, connectionStatus: "revoked", domains: ok }), "needs_reauth");
  assert.equal(deriveShopHealth({ ...base, syncEnabled: false, domains: ok }), "paused");
  assert.equal(deriveShopHealth({ ...base, pausedUntil: new Date(Date.now() + 60_000).toISOString(), domains: ok }), "paused");
  assert.equal(deriveShopHealth({ ...base, domains: [d("product", "ok"), d("order", "never"), d("escrow", "never")] }), "initializing");
  assert.equal(deriveShopHealth({ ...base, domains: [...ok, d("payout", "stale")] }), "sync_stale");
  assert.equal(deriveShopHealth({ ...base, domains: [...ok, d("payout", "stale", { failed24h: 2 })] }), "failed");
  assert.equal(deriveShopHealth({ ...base, domains: [...ok.slice(1), d("product", "ok", { retrying: 1 })] }), "degraded");
});

// ================================================================ claim

test("16/89: fairness — a continued slice goes to the BACK of its priority line → round-robin across 5 shops (prod incident 2026-10-20)", async () => {
  const shops = [await shop(), await shop(), await shop(), await shop(), await shop()];
  const jobs: string[] = [];
  for (const s of shops) jobs.push((await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" })).jobId);
  const seq: string[] = [];
  for (let i = 0; i < 10; i++) {
    const j = await claimNextSyncJob(db, `fair${i}`, { maxRunning: 50, shopIds: shops, maxPerShop: 1 });
    assert.ok(j);
    seq.push(j!.shop_id);
    await new JobLease(db, j!, `fair${i}`).continueLater({}); // "time budget used, more to do"
  }
  assert.deepEqual(seq, [...shops, ...shops], "every shop gets a slice before any shop gets its second");
  await settle(shops);
});

test("15: per-shop concurrency — while a shop has a running job its other jobs wait; other shops are served", async () => {
  const [a, b] = [await shop(), await shop()];
  await requestShopeeSync(db, { shopId: a, syncType: "order", mode: "incremental" });
  await requestShopeeSync(db, { shopId: a, syncType: "product", mode: "incremental" });
  await requestShopeeSync(db, { shopId: b, syncType: "escrow", mode: "incremental" });
  const first = await claimNextSyncJob(db, "pc1", { maxRunning: 50, shopIds: [a, b], maxPerShop: 1 });
  assert.equal(first!.shop_id, a);
  assert.equal(first!.sync_type, "order");
  const second = await claimNextSyncJob(db, "pc2", { maxRunning: 50, shopIds: [a, b], maxPerShop: 1 });
  assert.equal(second!.shop_id, b, "shop A's product job waits for its running order job");
  assert.equal(await claimNextSyncJob(db, "pc3", { maxRunning: 50, shopIds: [a, b], maxPerShop: 1 }), null);
  const unlimited = await claimNextSyncJob(db, "pc4", { maxRunning: 50, shopIds: [a, b], maxPerShop: 2 });
  assert.equal(unlimited!.sync_type, "product", "a higher per-shop cap lets it run");
  await settle([a, b]);
});

test("65/66/67: paused shop — incremental jobs not claimed, manual still claimed; circuit breaker opens after N provider failures and a success closes it", async () => {
  const [p, q] = [await shop(), await shop()];
  await setShopSyncEnabled(db, p, false, null);
  await requestShopeeSync(db, { shopId: p, syncType: "order", mode: "incremental" });
  await requestShopeeSync(db, { shopId: q, syncType: "order", mode: "incremental" });
  const j1 = await claimNextSyncJob(db, "pz1", { maxRunning: 50, shopIds: [p, q], maxPerShop: 1 });
  assert.equal(j1!.shop_id, q);
  assert.equal(await claimNextSyncJob(db, "pz2", { maxRunning: 50, shopIds: [p, q], maxPerShop: 1 }), null, "disabled shop's automatic job waits");
  await requestShopeeSync(db, { shopId: p, syncType: "order", mode: "manual" }); // raises the same job to manual priority…
  await db.from("channel_sync_jobs").update({ mode: "manual" }).eq("shop_id", p).eq("status", "pending"); // …an admin click
  assert.equal((await claimNextSyncJob(db, "pz3", { maxRunning: 50, shopIds: [p, q], maxPerShop: 1 }))!.shop_id, p, "manual job of a paused shop still runs");
  await settle([p, q]);
  await setShopSyncEnabled(db, p, true, null);

  for (let i = 1; i <= 3; i++) {
    const { data } = await db.rpc("record_shop_sync_outcome", { p_shop_id: q, p_ok: false, p_error_code: "error_server", p_threshold: 3, p_cooldown_minutes: 30 });
    if (i < 3) assert.equal((data as { pause_reason: string | null }).pause_reason, null);
    else assert.equal((data as { pause_reason: string | null }).pause_reason, "circuit_breaker");
  }
  const sched = await runShopeeSyncScheduler(db, { config: { ...getSyncConfig({}), shopAllowlist: [q] }, providerMode: "fixture" });
  assert.deepEqual(sched.skippedShops.filter((x) => x.shopId === q), [{ shopId: q, reason: "circuit_breaker_cooldown" }]);
  assert.equal(sched.enqueued.length, 0, "a cooling-down shop gets no automatic jobs");
  const { data: closed } = await db.rpc("record_shop_sync_outcome", { p_shop_id: q, p_ok: true, p_error_code: null, p_threshold: 3, p_cooldown_minutes: 30 });
  assert.equal((closed as { pause_reason: string | null }).pause_reason, null);
  assert.equal((closed as { consecutive_failures: number }).consecutive_failures, 0);
  await settle([q]);
});

test("47/18: onboarding — a type that never succeeded is enqueued at catch-up priority below every healthy shop's realtime sync; auto-sync flag + disabled types", async () => {
  const [fresh, live] = [await shop(), await shop()];
  const nowIso = new Date().toISOString();
  await db.from("channel_sync_states").upsert(
    ["order", "product", "escrow", "return", "return_logistics", "failed_delivery", "income", "payout"].map((sync_type) => ({ shop_id: live, sync_type, last_success_at: new Date(Date.now() - 2 * 3600_000).toISOString() })),
    { onConflict: "shop_id,sync_type" },
  );
  const cfg = { ...getSyncConfig({}), shopAllowlist: [fresh, live] };
  const off = await runShopeeSyncScheduler(db, { config: { ...cfg, autoSyncEnabled: false }, providerMode: "fixture" });
  assert.equal(off.autoSyncDisabled, true);
  assert.equal(off.enqueued.length, 0);
  const r = await runShopeeSyncScheduler(db, { config: { ...cfg, disabledSyncTypes: ["payout"] }, providerMode: "fixture" });
  assert.ok(!r.enqueued.some((e) => e.syncType === "payout"), "disabled type never enqueued");
  const prio = async (shopId: string, type: string) => (await db.from("channel_sync_jobs").select("priority").eq("shop_id", shopId).eq("sync_type", type).eq("status", "pending").single()).data!.priority as number;
  assert.equal(await prio(live, "order"), 10);
  assert.equal(await prio(fresh, "order"), 50);
  assert.equal(await prio(fresh, "product"), 45, "a new shop's products first so orders find their listings");
  assert.ok((await prio(fresh, "product")) > (await prio(live, "product")), "onboarding never outranks a healthy shop's realtime sync");
  assert.ok(nowIso);
  await settle([fresh, live]);
});

// ================================================================ worker

test("88/89/91/93: one shop's provider outage → retry with backoff + category; other shops keep syncing; rate limit → ≥ 5 min + cooldown heartbeat", async () => {
  const [bad, rl, good] = [await shop(), await shop(), await shop()];
  for (const s of [bad, rl, good]) await catalog(s);
  const sns = [`${TAG}-W1`, `${TAG}-W2`];
  const orders = orderFixtures(sns);
  const errs = new Map<string, () => Error>([
    [bad, () => new ShopeeApiError({ apiPath: "/api/v2/order/get_order_list", errorCode: "error_server", message: "internal", httpStatus: 500 })],
    [rl, () => new ShopeeApiError({ apiPath: "/api/v2/order/get_order_list", errorCode: "too_many_request", message: "slow down", httpStatus: 429 })],
  ]);
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: [bad, rl, good], globalWorkers: 5 };
  const w = new SyncWorker({
    db,
    config,
    workerId: "h9a-iso",
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: (j) => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider(orders, { onCall: () => { const e = errs.get(j.shop_id); if (e) throw e(); } }),
        product: new FixtureShopeeProductProvider({ itemListPages: [], itemBaseInfo: { error: "", response: { item_list: [] } }, modelLists: {} }),
        payment: new FixtureShopeePaymentProvider(new Map()),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });
  const ids = { bad: "", rl: "", good: "" };
  ids.bad = (await requestShopeeSync(db, { shopId: bad, syncType: "order", mode: "incremental" })).jobId;
  ids.rl = (await requestShopeeSync(db, { shopId: rl, syncType: "order", mode: "incremental" })).jobId;
  ids.good = (await requestShopeeSync(db, { shopId: good, syncType: "order", mode: "incremental" })).jobId;
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) if (!(await w.runOne(30_000))) break;
  const [jb, jr, jg] = [await row(ids.bad), await row(ids.rl), await row(ids.good)];
  assert.equal(jg.status, "success", "healthy shop finished");
  assert.equal(jb.status, "retry");
  assert.equal((jb.metadata as Record<string, unknown>).lastErrorCategory, "PROVIDER_TEMPORARY");
  const badDelay = (new Date(jb.next_attempt_at!).getTime() - t0) / 1000;
  assert.ok(badDelay >= 55 && badDelay < 90, `5xx first retry ≈ 1 min (${badDelay}s)`);
  assert.equal(jr.status, "retry");
  assert.equal((jr.metadata as Record<string, unknown>).lastErrorCategory, "RATE_LIMIT");
  assert.ok((new Date(jr.next_attempt_at!).getTime() - t0) / 1000 >= 295, "rate limit waits ≥ 5 min (no hammering)");
  const beat = (await getHeartbeats(db, [RATE_LIMIT_HEARTBEAT])).get(RATE_LIMIT_HEARTBEAT);
  assert.ok(beat?.last_error_at && Date.now() - new Date(beat.last_error_at).getTime() < 60_000, "rate-limit cooldown marker set");
  const ctl = (await db.from("channel_shop_sync_controls").select("shop_id, consecutive_failures").in("shop_id", [bad, rl, good])).data ?? [];
  assert.equal(ctl.find((c) => c.shop_id === bad)?.consecutive_failures, 1);
  assert.equal(ctl.find((c) => c.shop_id === good)?.consecutive_failures ?? 0, 0);
  // same order_sn in two shops → two separate canonical orders
  const { data: stored } = await db.from("channel_orders").select("shop_id").in("external_order_sn", sns);
  assert.equal(stored!.filter((o) => o.shop_id === good).length, 2);
  await settle([bad, rl, good]);
});

test("97/94: 5-shop load — every shop drains, same order_sn in every shop never collides, no shop is starved", async () => {
  const shops = [await shop(), await shop(), await shop(), await shop(), await shop()];
  for (const s of shops) await catalog(s);
  const sns = Array.from({ length: 60 }, (_, i) => `${TAG}-L${i}`);
  // small slices → every job needs several slices (the condition of the prod incident)
  const { w } = worker(shops, { orders: orderFixtures(sns), config: { maxSliceApiCalls: 3, orderDetailConcurrency: 1 } });
  for (const s of shops) await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  const t0 = performance.now();
  const seq: string[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await w.runOne(30_000);
    if (!r) break;
    seq.push(r.shopId);
  }
  const ms = performance.now() - t0;
  const { data: stored } = await db.from("channel_orders").select("shop_id, external_order_sn").in("shop_id", shops);
  for (const s of shops) assert.equal(stored!.filter((o) => o.shop_id === s).length, 60, "each shop has its own 60 orders");
  const firstRound = seq.slice(0, 5);
  assert.equal(new Set(firstRound).size, 5, "the first 5 slices serve 5 different shops");
  console.log(`  5 shops × 60 orders: ${seq.length} slices, ${(ms / 1000).toFixed(1)} s`);
  await settle(shops);
});

// ================================================================ retention + health

test("54/55/56/95: retention removes only old HISTORY snapshots / old logs; the latest snapshot and canonical data stay", async () => {
  const s = await shop();
  const { data: o } = await db.from("channel_orders").insert({ shop_id: s, external_order_sn: `${TAG}-RET`, order_status: "COMPLETED", currency: "VND" }).select("id").single();
  const day = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
  const snap = (entity_type: string, id: string, api: string, at: string) => ({ shop_id: s, entity_type, entity_external_id: id, api_name: api, payload: { at }, synced_at: at, source_mode: "fixture" });
  const { error } = await db.from("channel_api_snapshots").insert([
    snap("order", "A", "v2.order.get_order_detail", day(90)), // history, old → purge
    snap("order", "A", "v2.order.get_order_detail", day(60)), // history, old → purge
    snap("order", "A", "v2.order.get_order_detail", day(45)), // latest (even if old) → keep
    snap("order", "B", "v2.order.get_order_detail", day(5)), // recent history → keep
    snap("order", "B", "v2.order.get_order_detail", day(1)),
    snap("escrow", "A", "v2.payment.get_escrow_detail", day(90)), // financial history < 180 d → keep
    snap("escrow", "A", "v2.payment.get_escrow_detail", day(200)), // financial history > 180 d → purge
    snap("escrow", "A", "v2.payment.get_escrow_detail", day(10)),
  ]);
  if (error) throw error;
  const logs = await db.from("channel_sync_logs").insert([
    { shop_id: s, sync_type: "order", started_at: day(30), status: "success" },
    { shop_id: s, sync_type: "order", started_at: day(30), status: "failed" },
    { shop_id: s, sync_type: "order", started_at: day(1), status: "success" },
  ]);
  if (logs.error) throw logs.error;
  let total = { snapshots: 0, logs: 0 };
  for (let i = 0; i < 20; i++) {
    const r = await pruneRetention(db, getSyncConfig({}));
    assert.equal(r.error, null);
    total = { snapshots: total.snapshots + r.snapshots, logs: total.logs + r.logs };
    if (r.snapshots === 0 && r.logs === 0) break;
  }
  const left = ((await db.from("channel_api_snapshots").select("entity_type, entity_external_id, synced_at").eq("shop_id", s)).data ?? []).map((x) => `${x.entity_type}:${x.entity_external_id}:${Math.round((Date.now() - new Date(x.synced_at).getTime()) / 86400_000)}`).sort();
  assert.deepEqual(left, ["escrow:A:10", "escrow:A:90", "order:A:45", "order:B:1", "order:B:5"]);
  const keptLogs = ((await db.from("channel_sync_logs").select("status, started_at").eq("shop_id", s)).data ?? []).map((l) => l.status).sort();
  assert.deepEqual(keptLogs, ["failed", "success"], "old success log purged; failure log (60 d) and recent success kept");
  assert.ok((await db.from("channel_orders").select("id").eq("id", o!.id).single()).data, "canonical order untouched");
});

test("96/40: system health — scheduler stale, worker healthy, needs_reauth, stale domain, pending age, alerts", async () => {
  const s = await shop("health shop");
  const old = new Date(Date.now() - 30 * 60_000).toISOString();
  await db.from("channel_sync_heartbeats").upsert([
    { name: SCHEDULER_HEARTBEAT, last_run_at: old, last_success_at: old, last_error_at: null, last_error: null },
    { name: WORKER_HEARTBEAT, last_run_at: new Date().toISOString(), last_success_at: new Date().toISOString(), last_error_at: null, last_error: null },
    { name: RATE_LIMIT_HEARTBEAT, last_error_at: new Date().toISOString(), last_error: "x" },
  ], { onConflict: "name" });
  await db.from("channel_sync_states").upsert(
    [
      { shop_id: s, sync_type: "product", last_success_at: new Date().toISOString() },
      { shop_id: s, sync_type: "order", last_success_at: old },
      { shop_id: s, sync_type: "escrow", last_success_at: new Date().toISOString() },
    ],
    { onConflict: "shop_id,sync_type" },
  );
  const j = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  await db.from("channel_sync_jobs").update({ created_at: new Date(Date.now() - 25 * 60_000).toISOString() }).eq("id", j.jobId);
  const config = { ...getSyncConfig({}), shopAllowlist: [s] };
  const h = await getSystemHealth(db, config, { providerMode: "fixture" });
  assert.equal(h.scheduler.status, "unhealthy");
  assert.match(h.scheduler.message, /30 phút/);
  assert.equal(h.worker.status, "healthy");
  assert.equal(h.rateLimit.coolingDown, true);
  const row0 = h.shops.find((x) => x.id === s)!;
  assert.equal(row0.domains.find((d) => d.type === "order")!.status, "stale");
  assert.equal(row0.health, "sync_stale");
  assert.ok(h.queue.oldestDueMinutes !== null && h.queue.oldestDueMinutes >= 24);
  const codes = h.alerts.map((a) => a.code);
  for (const c of ["scheduler_stale", "old_pending", "rate_limited", "stale_order"]) assert.ok(codes.includes(c), `alert ${c}`);
  assert.ok(!codes.includes("worker_stale"));
  // a live shop whose token was revoked
  await db.from("shops").update({ data_source: "live" }).eq("id", s);
  await db.from("shop_connections").insert({ shop_id: s, connection_status: "revoked" });
  const h2 = await getSystemHealth(db, config, { providerMode: "live" });
  assert.equal(h2.shops.find((x) => x.id === s)!.health, "needs_reauth");
  assert.ok(h2.alerts.some((a) => a.code === "needs_reauth" && a.shopId === s));
  await settle([s]);
});
