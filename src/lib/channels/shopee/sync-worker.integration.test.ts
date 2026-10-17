// ============================================================
// SHOPEE-PERF-1 — job queue + worker against the REAL database in
// .env.local (local Docker Supabase in dev) with FIXTURE providers:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/sync-worker.integration.test.ts
//
// Every worker / scheduler here is scoped to this file's own shops
// (config.shopAllowlist), so dev data in the same DB is never claimed.
// Everything is deleted in `after` (shops cascade to jobs, orders, …).
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { getSyncConfig, type SyncConfig } from "../core/sync-config.ts";
import { cancelSyncJob, claimNextSyncJob, enqueueSyncJob, recoverStaleSyncJobs, retrySyncJob, type SyncJobRow } from "../core/sync-jobs.ts";
import { SyncWorker } from "../core/sync-worker.ts";
import { ShopeeApiError } from "./errors.ts";
import { FixtureShopeeOrderProvider, type OrderFixtureSet } from "./order-provider.ts";
import { FixtureShopeeProductProvider, type ProductFixtureSet } from "./product-provider.ts";
import { FixtureShopeePaymentProvider } from "./payment-provider.ts";
import { toJobFailure } from "./sync-errors.ts";
import { createShopeeRunnerFactory, requestShopeeSync, runShopeeSchedulerTick, runShopeeSyncScheduler } from "./sync-service.ts";
import { getHeartbeats, SCHEDULER_HEARTBEAT } from "../core/sync-heartbeat.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `perf${Date.now()}`;
const shopIds: string[] = [];
let n = 0;
const NOW = Math.floor(Date.now() / 1000);

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
});

async function shop(): Promise<string> {
  const { data, error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: `perf ${n}`, currency: "VND", data_source: "fixture" })
    .select("id")
    .single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

/** Leave no active job behind (the global running cap is shared by the whole DB). */
async function settle(ids: string[]) {
  await db.from("channel_sync_jobs").update({ status: "cancelled", lock_owner: null, locked_at: null }).in("shop_id", ids).in("status", ["pending", "running", "retry"]);
}

const job = async (id: string) => (await db.from("channel_sync_jobs").select("*").eq("id", id).single()).data as SyncJobRow;

// ------------------------------------------------------------ fixtures

type OrderSpec = { sn: string; status?: string; update?: number; items?: number[] };

function orderFixtures(orders: OrderSpec[], pageSize = 100): OrderFixtureSet {
  const ordersBySn = new Map<string, unknown>();
  for (const o of orders) {
    ordersBySn.set(o.sn, {
      order_sn: o.sn,
      order_status: o.status ?? "COMPLETED",
      create_time: (o.update ?? NOW - 3600) - 600,
      update_time: o.update ?? NOW - 3600,
      currency: "VND",
      total_amount: 100000,
      item_list: (o.items ?? [1]).map((item, i) => ({
        order_item_id: 1000 + i,
        item_id: item,
        item_name: `Item ${item}`,
        item_sku: "",
        model_id: 0,
        model_sku: "",
        model_original_price: 60000,
        model_discounted_price: 45000,
        model_quantity_purchased: 1,
      })),
    });
  }
  const listPages: unknown[] = [];
  for (let i = 0; i < Math.max(orders.length, 1); i += pageSize) {
    const more = i + pageSize < orders.length;
    listPages.push({
      error: "",
      request_id: `fx-${i}`,
      response: {
        more,
        next_cursor: more ? `c${i + pageSize}` : "",
        order_list: orders.slice(i, i + pageSize).map((o) => ({ order_sn: o.sn, order_status: o.status ?? "COMPLETED" })),
      },
    });
  }
  return { listPages, ordersBySn };
}

const env = (response: Record<string, unknown>) => ({ error: "", message: "", warning: "", request_id: `fx-${Math.random()}`, response });

type ItemSpec = { id: number; update?: number; models?: number[] };

function productFixtures(items: ItemSpec[], pageSize = 100): ProductFixtureSet {
  const pages: unknown[] = [];
  for (let i = 0; i < items.length || i === 0; i += pageSize) {
    const slice = items.slice(i, i + pageSize);
    const next = Math.min(i + pageSize, items.length);
    pages.push(env({ item: slice.map((it) => ({ item_id: it.id, item_status: "NORMAL", update_time: it.update ?? 1760000000 })), total_count: items.length, has_next_page: next < items.length, next_offset: next }));
    if (items.length === 0) break;
  }
  const itemBaseInfo = env({
    item_list: items.map((it) => ({
      item_id: it.id,
      category_id: 1,
      item_name: `Item ${it.id}`,
      item_sku: "",
      create_time: 1700000000,
      update_time: it.update ?? 1760000000,
      item_status: "NORMAL",
      has_model: !!it.models?.length,
      ...(it.models?.length ? {} : { price_info: [{ currency: "VND", original_price: 109000, current_price: 100000 }] }),
      stock_info_v2: { summary_info: { total_reserved_stock: 0, total_available_stock: 10 } },
    })),
  });
  const modelLists: Record<string, unknown> = {};
  for (const it of items.filter((x) => x.models?.length)) {
    modelLists[String(it.id)] = env({
      tier_variation: [{ name: "Size", option_list: it.models!.map((_, i) => ({ option: `S${i}` })) }],
      model: it.models!.map((m, i) => ({
        model_id: m,
        tier_index: [i],
        model_sku: "",
        model_status: "MODEL_NORMAL",
        price_info: [{ currency: "VND", original_price: 51000, current_price: 50000 }],
        stock_info_v2: { summary_info: { total_reserved_stock: 0, total_available_stock: 5 } },
      })),
    });
  }
  return { itemListPages: pages, itemBaseInfo, modelLists };
}

/** Catalog units so order lines resolve without product calls. */
async function catalog(shopId: string, items: number[]) {
  for (const item of items) {
    const { data: cp } = await db
      .from("channel_products")
      .upsert({ shop_id: shopId, external_item_id: String(item), item_name: `Item ${item}`, has_model: false }, { onConflict: "shop_id,external_item_id" })
      .select("id")
      .single();
    await db.from("channel_product_models").upsert({ channel_product_id: cp!.id, external_model_id: "NO_MODEL", is_synthetic: true }, { onConflict: "channel_product_id,external_model_id" });
  }
}

type Call = { apiName: string; input: unknown };

/** A worker scoped to `shops`, over mutable fixture sources. */
function harness(shops: string[], opts: { config?: Partial<SyncConfig>; onCall?: (c: Call) => void | Promise<void> } = {}) {
  const state = { orders: orderFixtures([]), products: productFixtures([]), escrow: new Map<string, unknown>() };
  const calls: Call[] = [];
  const hook = async (c: Call) => {
    calls.push(c);
    await opts.onCall?.(c);
  };
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: shops, ...opts.config };
  const worker = new SyncWorker({
    db,
    config,
    workerId: `test-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: () => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider(state.orders, { onCall: hook }),
        product: new FixtureShopeeProductProvider(state.products, { onCall: hook }),
        payment: new FixtureShopeePaymentProvider(state.escrow, { onCall: hook }),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });
  const drain = async (max = 50) => {
    const reports = [];
    for (let i = 0; i < max; i++) {
      const r = await worker.runOne(30_000);
      if (!r) break;
      reports.push(r);
    }
    return reports;
  };
  return { state, calls, worker, drain, config };
}

const count = (calls: Call[], api: string) => calls.filter((c) => c.apiName === api).length;

// ================================================================ QUEUE

test("1 + 2. enqueue creates a pending job; a duplicate active request returns the same job (manual raises priority)", async () => {
  const s = await shop();
  const a = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  assert.equal(a.created, true);
  assert.equal(a.status, "pending");
  assert.equal((await job(a.jobId)).priority, 10);
  const b = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "manual" });
  assert.equal(b.created, false);
  assert.equal(b.jobId, a.jobId);
  assert.equal((await job(a.jobId)).priority, 1, "manual click moved the queued job to the front");
  const { count: active } = await db.from("channel_sync_jobs").select("id", { count: "exact", head: true }).eq("shop_id", s).in("status", ["pending", "running", "retry"]);
  assert.equal(active, 1);
  // backfill is its own lane: allowed next to the incremental one, deduped itself
  const bf1 = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "backfill", backfillDays: 20 });
  const bf2 = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "backfill", backfillDays: 20 });
  assert.equal(bf1.created, true);
  assert.equal(bf2.created, false);
  await settle([s]);
});

test("3. priority: manual before incremental before backfill (lower value first)", async () => {
  const [s1, s2, s3] = [await shop(), await shop(), await shop()];
  const bf = await requestShopeeSync(db, { shopId: s1, syncType: "order", mode: "backfill", backfillDays: 5 });
  const inc = await requestShopeeSync(db, { shopId: s2, syncType: "order", mode: "incremental" });
  const man = await requestShopeeSync(db, { shopId: s3, syncType: "order", mode: "manual" });
  const order: string[] = [];
  for (let i = 0; i < 3; i++) {
    const j = await claimNextSyncJob(db, `w${i}`, { maxRunning: 10, shopIds: [s1, s2, s3] });
    order.push(j!.id);
  }
  assert.deepEqual(order, [man.jobId, inc.jobId, bf.jobId]);
  await settle([s1, s2, s3]);
});

test("4 + 5. claim is atomic: 6 concurrent workers, 1 job → exactly one claims it", async () => {
  const s = await shop();
  await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => claimNextSyncJob(db, `race${i}`, { maxRunning: 10, shopIds: [s] })));
  const claimed = results.filter(Boolean);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.status, "running");
  assert.equal(claimed[0]!.attempt_count, 1);
  await settle([s]);
});

test("6. a retry job is claimable only once next_attempt_at is due", async () => {
  const s = await shop();
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  await db.from("channel_sync_jobs").update({ status: "retry", next_attempt_at: new Date(Date.now() + 3600_000).toISOString() }).eq("id", q.jobId);
  assert.equal(await claimNextSyncJob(db, "w", { maxRunning: 10, shopIds: [s] }), null);
  await db.from("channel_sync_jobs").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", q.jobId);
  assert.equal((await claimNextSyncJob(db, "w", { maxRunning: 10, shopIds: [s] }))?.id, q.jobId);
  await settle([s]);
});

test("7 + 22. transient failures retry with backoff, then dead-letter as failed after max_attempts (log closed)", async () => {
  const s = await shop();
  const h = harness([s], {
    onCall: () => {
      throw new ShopeeApiError({ apiPath: "/api/v2/order/get_order_list", errorCode: "error_server", message: "busy", httpStatus: 503 });
    },
  });
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  const statuses: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await h.worker.runOne();
    statuses.push(r!.status);
    const j = await job(q.jobId);
    if (j.status === "retry") {
      const delay = new Date(j.next_attempt_at!).getTime() - Date.now();
      assert.ok(delay > 30_000, `backoff persisted (${delay} ms), not slept`);
      await db.from("channel_sync_jobs").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", q.jobId);
    }
  }
  assert.deepEqual(statuses, ["retry", "retry", "failed"]);
  const j = await job(q.jobId);
  assert.equal(j.status, "failed");
  assert.equal(j.error_code, "error_server");
  assert.equal(await claimNextSyncJob(db, "w", { maxRunning: 10, shopIds: [s] }), null, "failed job is never retried automatically");
  const { data: log } = await db.from("channel_sync_logs").select("status, error_code").eq("job_id", q.jobId).single();
  assert.deepEqual(log, { status: "failed", error_code: "error_server" });
});

// ================================================================= LOCK

test("8 + 9 + 10. same shop + type never runs twice; other shops and the other sync type of the same shop still run", async () => {
  const [a, b] = [await shop(), await shop()];
  await requestShopeeSync(db, { shopId: a, syncType: "order", mode: "incremental" });
  await requestShopeeSync(db, { shopId: a, syncType: "order", mode: "backfill", backfillDays: 10 });
  await requestShopeeSync(db, { shopId: a, syncType: "product", mode: "incremental" });
  await requestShopeeSync(db, { shopId: b, syncType: "order", mode: "incremental" });
  const claimed: SyncJobRow[] = [];
  for (let i = 0; i < 5; i++) {
    const j = await claimNextSyncJob(db, `w${i}`, { maxRunning: 10, shopIds: [a, b] });
    if (j) claimed.push(j);
  }
  const keys = claimed.map((j) => `${j.shop_id === a ? "A" : "B"}:${j.sync_type}:${j.mode}`).sort();
  assert.deepEqual(keys, ["A:order:incremental", "A:product:incremental", "B:order:incremental"], "A's backfill waits for A's running order job");
  await settle([a, b]);
});

test("20 (global cap). at most config.globalWorkers jobs run at once", async () => {
  const [a, b] = [await shop(), await shop()];
  await requestShopeeSync(db, { shopId: a, syncType: "order", mode: "incremental" });
  await requestShopeeSync(db, { shopId: b, syncType: "order", mode: "incremental" });
  const { count: runningElsewhere } = await db.from("channel_sync_jobs").select("id", { count: "exact", head: true }).eq("status", "running");
  const cap = (runningElsewhere ?? 0) + 1;
  assert.ok(await claimNextSyncJob(db, "w1", { maxRunning: cap, shopIds: [a, b] }));
  assert.equal(await claimNextSyncJob(db, "w2", { maxRunning: cap, shopIds: [a, b] }), null);
  await settle([a, b]);
});

// =========================================================== CHECKPOINT

test("11 + 12 + 14. bounded slices: cursor checkpointed after every page, job continues across slices to completion", async () => {
  const s = await shop();
  await catalog(s, [1]);
  const h = harness([s], { config: { maxSliceApiCalls: 3 } });
  h.state.orders = orderFixtures(Array.from({ length: 10 }, (_, i) => ({ sn: `${TAG}-CP-${i}` })), 2);
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });

  const first = await h.worker.runOne();
  assert.equal(first!.status, "pending", "budget spent → job re-queued, not finished");
  const mid = await job(q.jobId);
  assert.equal(mid.status, "pending");
  assert.ok(mid.cursor, "provider cursor persisted");
  assert.ok((mid.metadata!.checkpoint as { cursor: string }).cursor);
  assert.ok(first!.apiCalls <= 3, `slice made ${first!.apiCalls} calls`);

  const rest = await h.drain();
  assert.equal(rest.at(-1)!.status, "success");
  const done = await job(q.jobId);
  assert.ok(Number(done.metadata!.slices) >= 3, `slices=${done.metadata!.slices}`);
  const { count: stored } = await db.from("channel_orders").select("id", { count: "exact", head: true }).eq("shop_id", s);
  assert.equal(stored, 10);
  const cursors = h.calls.filter((c) => c.apiName === "v2.order.get_order_list").map((c) => (c.input as { cursor: string }).cursor);
  assert.deepEqual(cursors, ["", "c2", "c4", "c6", "c8"], "every page fetched exactly once across slices");
  const { data: st } = await db.from("channel_sync_states").select("last_success_at, last_window_to").eq("shop_id", s).eq("sync_type", "order").single();
  assert.equal(new Date(st!.last_success_at!).getTime(), new Date(done.window_to!).getTime(), "checkpoint advanced to the window end");
});

test("13. a failure mid-walk resumes from the saved cursor (earlier pages are not re-read)", async () => {
  const s = await shop();
  await catalog(s, [1]);
  let failOnce = true;
  const h = harness([s], {
    onCall: (c) => {
      if (c.apiName === "v2.order.get_order_list" && (c.input as { cursor: string }).cursor === "c4" && failOnce) {
        failOnce = false;
        throw new ShopeeApiError({ apiPath: "/x", errorCode: "timeout", message: "timeout" });
      }
    },
  });
  h.state.orders = orderFixtures(Array.from({ length: 6 }, (_, i) => ({ sn: `${TAG}-RS-${i}` })), 2);
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  assert.equal((await h.worker.runOne())!.status, "retry");
  const mid = await job(q.jobId);
  assert.equal(mid.cursor, "c4");
  await db.from("channel_sync_jobs").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", q.jobId);
  assert.equal((await h.drain()).at(-1)!.status, "success");
  const cursors = h.calls.filter((c) => c.apiName === "v2.order.get_order_list").map((c) => (c.input as { cursor: string }).cursor);
  assert.deepEqual(cursors, ["", "c2", "c4", "c4"]);
  const { count: stored } = await db.from("channel_orders").select("id", { count: "exact", head: true }).eq("shop_id", s);
  assert.equal(stored, 6);
});

// ================================================================ ORDER

test("15 + 16 + 17 + 19. re-sync skips unchanged orders; status change and new orders are fetched", async () => {
  const s = await shop();
  await catalog(s, [1]);
  const h = harness([s]);
  const specs: OrderSpec[] = [{ sn: `${TAG}-A` }, { sn: `${TAG}-B` }, { sn: `${TAG}-C`, status: "SHIPPED" }];
  h.state.orders = orderFixtures(specs);
  await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  await h.drain();
  assert.equal(count(h.calls, "v2.order.get_order_detail"), 1, "3 new orders → one detail batch");

  // unchanged re-sync: only the list page is read
  h.calls.length = 0;
  const q2 = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "manual" });
  await h.drain();
  assert.equal(count(h.calls, "v2.order.get_order_detail"), 0);
  const j2 = await job(q2.jobId);
  assert.equal((j2.metadata!.stats as Record<string, number>).detailsSkippedUnchanged, 3);
  assert.deepEqual(j2.metadata!.apiCalls, { get_order_list: 1 });

  // C delivered (status change) + D new → exactly those two fetched
  h.calls.length = 0;
  h.state.orders = orderFixtures([specs[0], specs[1], { sn: `${TAG}-C`, status: "COMPLETED" }, { sn: `${TAG}-D` }]);
  const q3 = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "manual" });
  await h.drain();
  const fetched = h.calls.filter((c) => c.apiName === "v2.order.get_order_detail").flatMap((c) => (c.input as { orderSns: string[] }).orderSns);
  assert.deepEqual(fetched.sort(), [`${TAG}-C`, `${TAG}-D`]);
  const reasons = (await job(q3.jobId)).metadata!.stats as { refreshReasons: Record<string, number> };
  assert.equal(reasons.refreshReasons.status_changed, 1);
  assert.equal(reasons.refreshReasons.new, 1);
  const { data: c } = await db.from("channel_orders").select("order_status").eq("shop_id", s).eq("external_order_sn", `${TAG}-C`).single();
  assert.equal(c!.order_status, "COMPLETED");
});

test("18. an active order seen again is refreshed once its copy is older than its status TTL", async () => {
  const s = await shop();
  await catalog(s, [1]);
  const h = harness([s]);
  h.state.orders = orderFixtures([{ sn: `${TAG}-ACT`, status: "READY_TO_SHIP" }, { sn: `${TAG}-DONE`, status: "COMPLETED" }]);
  await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  await h.drain();
  // window will start 2h10m ago; both copies are 40 min old (inside the window, older than the 30-min TTL)
  const old = new Date(Date.now() - 40 * 60_000).toISOString();
  await db.from("channel_orders").update({ last_synced_at: old }).eq("shop_id", s);
  await db.from("channel_sync_states").update({ last_success_at: new Date(Date.now() - 2 * 3600_000).toISOString() }).eq("shop_id", s).eq("sync_type", "order");
  h.calls.length = 0;
  await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "manual" });
  await h.drain();
  const fetched = h.calls.filter((c) => c.apiName === "v2.order.get_order_detail").flatMap((c) => (c.input as { orderSns: string[] }).orderSns);
  assert.deepEqual(fetched, [`${TAG}-ACT`], "active stale refreshed, completed unchanged skipped");
});

// ============================================================== PRODUCT

test("20 + 21 + 22. product re-sync skips unchanged listings; a changed listing (new model) is fetched and upserted", async () => {
  const s = await shop();
  const h = harness([s]);
  h.state.products = productFixtures([{ id: 501 }, { id: 502, models: [9001] }, { id: 503 }]);
  await requestShopeeSync(db, { shopId: s, syncType: "product", mode: "manual" });
  assert.equal((await h.drain()).at(-1)!.status, "success");
  assert.equal(count(h.calls, "v2.product.get_item_base_info"), 1);
  assert.equal(count(h.calls, "v2.product.get_model_list"), 1);

  h.calls.length = 0;
  const q2 = await requestShopeeSync(db, { shopId: s, syncType: "product", mode: "manual" });
  await h.drain();
  assert.equal(count(h.calls, "v2.product.get_item_base_info"), 0, "nothing changed → no detail calls");
  assert.equal(((await job(q2.jobId)).metadata!.stats as Record<string, number>).detailsSkippedUnchanged, 3);

  h.calls.length = 0;
  h.state.products = productFixtures([{ id: 501 }, { id: 502, models: [9001, 9002], update: 1760009999 }, { id: 503 }]);
  await requestShopeeSync(db, { shopId: s, syncType: "product", mode: "manual" });
  await h.drain();
  assert.deepEqual(h.calls.filter((c) => c.apiName === "v2.product.get_item_base_info").map((c) => (c.input as { itemIds: string[] }).itemIds), [["502"]]);
  const { data: cp } = await db.from("channel_products").select("id").eq("shop_id", s).eq("external_item_id", "502").single();
  const { data: models } = await db.from("channel_product_models").select("external_model_id").eq("channel_product_id", cp!.id).order("external_model_id");
  assert.deepEqual(models!.map((m) => m.external_model_id), ["9001", "9002"]);
});

// ============================================================== FAILURE

test("23. one malformed order → job succeeds as partial; the others are stored; checkpoint not advanced", async () => {
  const s = await shop();
  await catalog(s, [1]);
  const h = harness([s]);
  h.state.orders = orderFixtures([{ sn: `${TAG}-OK1` }, { sn: `${TAG}-BAD` }, { sn: `${TAG}-OK2` }]);
  (h.state.orders.ordersBySn.get(`${TAG}-BAD`) as Record<string, unknown>).item_list = "not-a-list";
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  const last = (await h.drain()).at(-1)!;
  assert.equal(last.status, "success");
  assert.equal(last.logStatus, "partial");
  const j = await job(q.jobId);
  assert.equal(j.records_failed, 1);
  const { count: stored } = await db.from("channel_orders").select("id", { count: "exact", head: true }).eq("shop_id", s);
  assert.equal(stored, 2);
  const { data: st } = await db.from("channel_sync_states").select("last_success_at, last_error_code").eq("shop_id", s).eq("sync_type", "order").single();
  assert.equal(st!.last_success_at, null);
  assert.equal(st!.last_error_code, "partial_failure");
});

test("24. provider auth failure stops the job at once (failed, no retry)", async () => {
  const s = await shop();
  const h = harness([s], {
    onCall: () => {
      throw new ShopeeApiError({ apiPath: "/x", errorCode: "error_auth", message: "invalid access_token", httpStatus: 403 });
    },
  });
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  assert.equal((await h.worker.runOne())!.status, "failed");
  const j = await job(q.jobId);
  assert.equal(j.attempt_count, 1);
  assert.equal(j.error_code, "error_auth");
  assert.equal(h.calls.length, 1, "stopped after the first auth error");
});

test("25. rate limit → retry scheduled (Retry-After honoured), rate-limit hit counted; detail batch failures keep pending orders", async () => {
  const s = await shop();
  await catalog(s, [1]);
  let limited = true;
  const h = harness([s], {
    onCall: (c) => {
      if (c.apiName === "v2.order.get_order_detail" && limited) {
        limited = false;
        throw new ShopeeApiError({ apiPath: "/x", errorCode: "error_too_many_request", message: "slow down", httpStatus: 429, retryAfterSeconds: 600 });
      }
    },
  });
  h.state.orders = orderFixtures([{ sn: `${TAG}-RL1` }, { sn: `${TAG}-RL2` }]);
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  assert.equal((await h.worker.runOne())!.status, "retry");
  const j = await job(q.jobId);
  const delay = (new Date(j.next_attempt_at!).getTime() - Date.now()) / 1000;
  assert.ok(delay > 550 && delay <= 600, `retry in ${delay}s`);
  assert.equal(j.metadata!.rateLimitHits, 1);
  assert.deepEqual((j.metadata!.checkpoint as { pendingSns: string[] }).pendingSns.sort(), [`${TAG}-RL1`, `${TAG}-RL2`], "orders stay queued, not marked failed");
  assert.equal(j.records_failed, 0);
  await db.from("channel_sync_jobs").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", q.jobId);
  assert.equal((await h.drain()).at(-1)!.status, "success");
  assert.equal(count(h.calls, "v2.order.get_order_list"), 1, "the list page is not re-read on resume");
});

test("26. stale running job: lease expired → retry (resumable); past max_attempts → failed with its log closed", async () => {
  const s = await shop();
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  const claimed = await claimNextSyncJob(db, "dead-worker", { maxRunning: 10, shopIds: [s] });
  await db.from("channel_sync_logs").insert({ shop_id: s, sync_type: "order", started_at: new Date().toISOString(), status: "running", job_id: claimed!.id });
  await db.from("channel_sync_jobs").update({ locked_at: new Date(Date.now() - 3600_000).toISOString() }).eq("id", q.jobId);
  const rec = await recoverStaleSyncJobs(db, 10);
  assert.ok(rec.some((r) => r.jobId === q.jobId && r.status === "retry"));
  let j = await job(q.jobId);
  assert.equal(j.lock_owner, null);
  assert.equal((j.metadata as Record<string, number>).recoveries, 1);

  // the dead worker's late write is rejected (lease lost)
  const { data: late } = await db.from("channel_sync_jobs").update({ cursor: "zombie" }).eq("id", q.jobId).eq("status", "running").eq("lock_owner", "dead-worker").select("id");
  assert.equal(late!.length, 0);

  await db.from("channel_sync_jobs").update({ status: "running", lock_owner: "dead-again", attempt_count: 3, locked_at: new Date(Date.now() - 3600_000).toISOString() }).eq("id", q.jobId);
  await recoverStaleSyncJobs(db, 10);
  j = await job(q.jobId);
  assert.equal(j.status, "failed");
  assert.equal(j.error_code, "stale_worker");
  const { data: log } = await db.from("channel_sync_logs").select("status").eq("job_id", q.jobId).single();
  assert.equal(log!.status, "failed");
});

test("cancel: pending → cancelled at once; running → stops at its next checkpoint. Thử lại resumes a cancelled job", async () => {
  const s = await shop();
  await catalog(s, [1]);
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  assert.equal(await cancelSyncJob(db, q.jobId, null), "cancelled");
  assert.equal((await job(q.jobId)).status, "cancelled");

  const h = harness([s], {
    onCall: async (c) => {
      if (c.apiName === "v2.order.get_order_list") await db.from("channel_sync_jobs").update({ cancel_requested: true }).eq("id", q2.jobId);
    },
  });
  h.state.orders = orderFixtures([{ sn: `${TAG}-X1` }], 1);
  const q2 = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  assert.equal((await h.worker.runOne())!.status, "cancelled");
  assert.equal(count(h.calls, "v2.order.get_order_detail"), 0, "stopped before the detail batch");
  const { data: log } = await db.from("channel_sync_logs").select("status").eq("job_id", q2.jobId).single();
  assert.equal(log!.status, "cancelled");

  assert.equal(await retrySyncJob(db, q2.jobId), "queued");
  const reset = await job(q2.jobId);
  assert.equal(reset.status, "pending");
  assert.equal(reset.cancel_requested, false);
  assert.ok((reset.metadata!.checkpoint as { pendingSns: string[] }).pendingSns.length === 1, "checkpoint kept → resumes, does not restart");
  await settle([s]);
});

// ========================================================== IDEMPOTENCY

test("30. repeated worker execution is safe: same data twice → no duplicates, second run creates nothing", async () => {
  const s = await shop();
  await catalog(s, [1, 2]);
  const h = harness([s]);
  h.state.orders = orderFixtures([{ sn: `${TAG}-I1`, items: [1, 2] }, { sn: `${TAG}-I2` }]);
  await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "repair", orderSns: [`${TAG}-I1`, `${TAG}-I2`] });
  await h.drain();
  const q2 = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "repair", orderSns: [`${TAG}-I1`, `${TAG}-I2`] });
  await h.drain();
  const j2 = await job(q2.jobId);
  assert.equal(j2.records_created, 0);
  assert.equal(j2.records_updated, 2, "repair forces the refetch → idempotent upserts");
  const { count: orders } = await db.from("channel_orders").select("id", { count: "exact", head: true }).eq("shop_id", s);
  const { data: ids } = await db.from("channel_orders").select("id").eq("shop_id", s);
  const { count: lines } = await db.from("channel_order_items").select("id", { count: "exact", head: true }).in("order_id", ids!.map((r) => r.id));
  assert.equal(orders, 2);
  assert.equal(lines, 3);
  // COGS path still runs per stored order (unmapped catalog → nothing posted, never guessed)
  assert.ok(((j2.metadata!.stats as { cogs?: Record<string, number> }).cogs ?? {}).unmapped! >= 1);
});

test("31. scheduler: due shops get one incremental job per type; a second run creates nothing; recent success is not due", async () => {
  const [a, b] = [await shop(), await shop()];
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: [a, b] };
  const r1 = await runShopeeSyncScheduler(db, { config, providerMode: "fixture" });
  assert.equal(r1.enqueued.length, 12, "2 shops x (order, product, escrow, return, income, payout)");
  const r2 = await runShopeeSyncScheduler(db, { config, providerMode: "fixture" });
  assert.equal(r2.enqueued.length, 0);
  assert.equal(r2.alreadyQueued.length, 12);
  await settle([a, b]);
  await db.from("channel_sync_states").upsert(
    [
      { shop_id: a, sync_type: "order", last_success_at: new Date().toISOString() },
      { shop_id: a, sync_type: "product", last_success_at: new Date().toISOString() },
      { shop_id: a, sync_type: "escrow", last_success_at: new Date().toISOString() },
      { shop_id: a, sync_type: "return", last_success_at: new Date().toISOString() },
      { shop_id: a, sync_type: "income", last_success_at: new Date().toISOString() },
      { shop_id: a, sync_type: "payout", last_success_at: new Date().toISOString() },
    ],
    { onConflict: "shop_id,sync_type" },
  );
  const r3 = await runShopeeSyncScheduler(db, { config, providerMode: "fixture" });
  assert.deepEqual(r3.enqueued.map((e) => e.shopId).sort(), [b, b, b, b, b, b]);
  assert.equal(r3.notDue, 6);
  // a live-mode scheduler never queues fixture shops
  const r4 = await runShopeeSyncScheduler(db, { config, providerMode: "live" });
  assert.equal(r4.enqueued.length, 0);
  await settle([a, b]);
});

// ============================================================ PERF-2

test("PERF-2 17. priority: manual order (1) → order incremental (10) → escrow (20) → product (30) → backfill (100)", async () => {
  const [a, b, c] = [await shop(), await shop(), await shop()];
  const bf = await requestShopeeSync(db, { shopId: a, syncType: "order", mode: "backfill", backfillDays: 3 });
  const prod = await requestShopeeSync(db, { shopId: a, syncType: "product", mode: "incremental" });
  const esc = await requestShopeeSync(db, { shopId: b, syncType: "escrow", mode: "incremental" });
  const ord = await requestShopeeSync(db, { shopId: b, syncType: "order", mode: "incremental" });
  const man = await requestShopeeSync(db, { shopId: c, syncType: "order", mode: "manual" });
  const order: string[] = [];
  for (let i = 0; i < 5; i++) order.push((await claimNextSyncJob(db, `p${i}`, { maxRunning: 50, shopIds: [a, b, c] }))!.id);
  assert.deepEqual(order, [man.jobId, ord.jobId, esc.jobId, prod.jobId, bf.jobId]);
  await settle([a, b, c]);
});

test("PERF-2 1 + 2 + 5 + 6 + 7. scheduler tick: heartbeat, per-shop due types, idempotent, no-due run creates nothing, old jobs pruned", async () => {
  const [a, b] = [await shop(), await shop()];
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: [a, b] };
  const t1 = await runShopeeSchedulerTick(db, { config, providerMode: "fixture" });
  assert.equal(t1.enqueued.length, 12, "2 shops x (order, product, escrow, return, income, payout)");
  assert.equal(t1.workDue, true);
  const beat = (await getHeartbeats(db)).get(SCHEDULER_HEARTBEAT)!;
  assert.ok(beat.last_run_at && beat.last_success_at && beat.last_success_at >= beat.last_run_at);
  assert.equal((beat.last_result as { enqueued: number }).enqueued, 12);

  const t2 = await runShopeeSchedulerTick(db, { config, providerMode: "fixture" });
  assert.equal(t2.enqueued.length, 0, "idempotent: active jobs are not duplicated");
  assert.equal(t2.alreadyQueued.length, 12);
  const { count: active } = await db.from("channel_sync_jobs").select("id", { count: "exact", head: true }).in("shop_id", [a, b]).in("status", ["pending", "running", "retry"]);
  assert.equal(active, 12);
  await settle([a, b]);

  // every type of both shops synced just now → nothing due
  const nowIso = new Date().toISOString();
  await db.from("channel_sync_states").upsert(
    [a, b].flatMap((shop_id) => ["order", "product", "escrow", "return", "income", "payout"].map((sync_type) => ({ shop_id, sync_type, last_success_at: nowIso }))),
    { onConflict: "shop_id,sync_type" },
  );
  const t3 = await runShopeeSchedulerTick(db, { config, providerMode: "fixture" });
  assert.equal(t3.enqueued.length, 0);
  assert.equal(t3.notDue, 12);

  // order due again after its 5-minute interval; product (60) / escrow (15) not yet
  const sixMinAgo = new Date(Date.now() - 6 * 60_000).toISOString();
  await db.from("channel_sync_states").update({ last_success_at: sixMinAgo }).eq("shop_id", a).eq("sync_type", "order");
  const t4 = await runShopeeSchedulerTick(db, { config, providerMode: "fixture" });
  assert.deepEqual(t4.enqueued.map((e) => `${e.shopId === a ? "A" : "B"}:${e.syncType}`), ["A:order"]);
  await settle([a, b]);

  // retention: a success job finished 40 days ago is pruned, a failed one is kept
  const { data: oldJobs } = await db
    .from("channel_sync_jobs")
    .insert([
      { shop_id: a, sync_type: "product", mode: "incremental", status: "success", finished_at: new Date(Date.now() - 40 * 86400_000).toISOString() },
      { shop_id: a, sync_type: "product", mode: "incremental", status: "failed", finished_at: new Date(Date.now() - 40 * 86400_000).toISOString() },
    ])
    .select("id, status");
  const t5 = await runShopeeSchedulerTick(db, { config, providerMode: "fixture" });
  assert.ok(t5.pruned >= 1);
  const { data: left } = await db.from("channel_sync_jobs").select("id").in("id", oldJobs!.map((j) => j.id));
  assert.deepEqual(left!.map((j) => j.id), [oldJobs!.find((j) => j.status === "failed")!.id]);
  await settle([a, b]);
});

test("PERF-2 12. soft deadline: a slice stops on its time budget → pending with continuation_reason time_budget, then finishes", async () => {
  const s = await shop();
  await catalog(s, [1]);
  let t = 0;
  const h = harness([s], { config: { sliceTimeBudgetMs: 25_000, maxSliceApiCalls: 100 } });
  // a worker on a fake clock: every provider call "takes" 10 s
  const worker = new SyncWorker({
    db,
    config: h.config,
    workerId: `deadline-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config: h.config,
      providers: () => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider(h.state.orders, {
          onCall: () => {
            t += 10_000;
          },
        }),
        product: new FixtureShopeeProductProvider(h.state.products),
        payment: new FixtureShopeePaymentProvider(h.state.escrow),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
    clock: () => t,
  });
  h.state.orders = orderFixtures(Array.from({ length: 8 }, (_, i) => ({ sn: `${TAG}-DL-${i}` })), 2);
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  const first = await worker.runOne(25_000);
  assert.equal(first!.status, "pending");
  assert.equal(first!.continuationReason, "time_budget");
  assert.equal(first!.apiCalls, 3, "stopped once the 25 s budget was spent (3 calls x 10 s), not at the call cap");
  const mid = await job(q.jobId);
  assert.equal(mid.metadata!.continuationReason, "time_budget");
  assert.equal(mid.status, "pending");
  assert.equal(mid.finished_at, null, "not finished early");
  for (let i = 0; i < 20; i++) {
    const r = await worker.runOne(25_000);
    if (!r || r.status !== "pending") break;
  }
  const done = await job(q.jobId);
  assert.equal(done.status, "success");
  const { count: stored } = await db.from("channel_orders").select("id", { count: "exact", head: true }).eq("shop_id", s);
  assert.equal(stored, 8, "success only after every page and every detail");
});

test("LOCAL-LIVE-1: slow order storing (far DB) stops on the slice budget INSIDE a detail batch — stored orders checkpointed, the rest deferred, nothing failed, all stored eventually", async () => {
  const s = await shop();
  await catalog(s, [1]);
  let t = 0;
  const h = harness([s], { config: { sliceTimeBudgetMs: 25_000, maxSliceApiCalls: 100 } });
  // every clock read "takes" 2 s — per-order budget checks make storing slow, like iad1 → Sydney
  const worker = new SyncWorker({
    db,
    config: h.config,
    workerId: `slowdb-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config: h.config,
      providers: () => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider(h.state.orders, { onCall: (c) => void h.calls.push(c) }),
        product: new FixtureShopeeProductProvider(h.state.products),
        payment: new FixtureShopeePaymentProvider(h.state.escrow),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
    clock: () => (t += 2_000),
  });
  h.state.orders = orderFixtures(Array.from({ length: 50 }, (_, i) => ({ sn: `${TAG}-SLOW-${String(i).padStart(2, "0")}` })));
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
  const storedCount = async () => (await db.from("channel_orders").select("id", { count: "exact", head: true }).eq("shop_id", s)).count ?? 0;

  const first = await worker.runOne(25_000);
  assert.equal(first!.status, "pending");
  assert.equal(first!.continuationReason, "time_budget");
  const afterFirst = await storedCount();
  assert.ok(afterFirst > 0 && afterFirst < 50, `first slice stored part of the batch (${afterFirst}/50), then checkpointed`);
  const mid = await job(q.jobId);
  const cp = mid.metadata!.checkpoint as { pendingSns: string[] };
  assert.equal(cp.pendingSns.length, 50 - afterFirst, "deferred orders stay pending (not dropped, not failed)");
  assert.equal((mid.metadata!.stats as Record<string, number>).detailsDeferred, 50 - afterFirst);

  for (let i = 0; i < 60; i++) {
    const r = await worker.runOne(25_000);
    if (!r || r.status !== "pending") break;
  }
  const done = await job(q.jobId);
  assert.equal(done.status, "success");
  assert.equal(await storedCount(), 50);
  assert.equal(done.records_failed, 0, "deferred ≠ failed");
  assert.ok(count(h.calls, "v2.order.get_order_detail") > 1, "deferred orders are fetched again in a later slice");
});

test("PATCH cutoff (00055): the order job stores only orders created on/after channel_sync_settings.orders_from; older ones are not stored and not failed", async () => {
  const s = await shop();
  await catalog(s, [1]);
  const saved = (await db.from("channel_sync_settings").select("orders_from").eq("id", true).single()).data!.orders_from as string | null;
  await db.from("channel_sync_settings").update({ orders_from: new Date((NOW - 86400) * 1000).toISOString() }).eq("id", true);
  try {
    const h = harness([s]);
    // old order (created 5 days ago, updated now — Shopee still lists it by update_time) + a new one
    h.state.orders = orderFixtures([
      { sn: `${TAG}-CUT-OLD`, update: NOW - 600 },
      { sn: `${TAG}-CUT-NEW`, update: NOW - 600 },
    ]);
    (h.state.orders.ordersBySn.get(`${TAG}-CUT-OLD`) as { create_time: number }).create_time = NOW - 5 * 86400;
    await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "incremental" });
    const [r] = await h.drain();
    assert.equal(r.status, "success");
    const { data: stored } = await db.from("channel_orders").select("external_order_sn").eq("shop_id", s);
    assert.deepEqual(stored!.map((o) => o.external_order_sn), [`${TAG}-CUT-NEW`]);
    const j = await job(r.jobId);
    assert.equal((j.metadata!.stats as Record<string, number>).skippedBeforeCutoff, 1);
    assert.equal(j.records_failed, 0, "skipped ≠ failed");
  } finally {
    await db.from("channel_sync_settings").update({ orders_from: saved }).eq("id", true);
  }
});

test("PERF-2 26 + 28. one shop's failure does not block the others; the global cap still holds", async () => {
  const [bad, good] = [await shop(), await shop()];
  await catalog(good, [1]);
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: [bad, good], globalWorkers: 1 };
  const goodOrders = orderFixtures([{ sn: `${TAG}-G1` }, { sn: `${TAG}-G2` }]);
  const worker = new SyncWorker({
    db,
    config,
    workerId: `iso-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: (j) => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider(goodOrders, {
          onCall: () => {
            if (j.shop_id === bad) throw new ShopeeApiError({ apiPath: "/x", errorCode: "error_auth", message: "revoked", httpStatus: 403 });
          },
        }),
        product: new FixtureShopeeProductProvider(productFixtures([])),
        payment: new FixtureShopeePaymentProvider(new Map()),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });
  const qb = await requestShopeeSync(db, { shopId: bad, syncType: "order", mode: "incremental" });
  const qg = await requestShopeeSync(db, { shopId: good, syncType: "order", mode: "incremental" });
  const burst = await worker.runBurst({ timeBudgetMs: 60_000 });
  assert.equal(burst.stoppedBy, "empty");
  assert.equal((await job(qb.jobId)).status, "failed", "revoked auth: no automatic retry");
  assert.equal((await job(qg.jobId)).status, "success", "the other shop still synced in the same run");
  const { count } = await db.from("channel_orders").select("id", { count: "exact", head: true }).eq("shop_id", good);
  assert.equal(count, 2);
  // the next scheduler tick still queues the failing shop's other types and the good shop
  const tick = await runShopeeSchedulerTick(db, { config, providerMode: "fixture" });
  assert.ok(tick.enqueued.some((e) => e.shopId === good));
  await settle([bad, good]);
});

test("PERF-2 16 + 19 + 21. automatic incremental: scheduler-enqueued jobs import a new order with window = last success − overlap; nothing clicked", async () => {
  const s = await shop();
  await catalog(s, [1]);
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: [s] };
  const h = harness([s], { config });
  h.state.orders = orderFixtures([{ sn: `${TAG}-AUTO-1` }]);
  await runShopeeSchedulerTick(db, { config, providerMode: "fixture" });
  await h.drain();
  const { data: st1 } = await db.from("channel_sync_states").select("last_success_at").eq("shop_id", s).eq("sync_type", "order").single();
  assert.ok(st1!.last_success_at);

  // 6 minutes later a new order appears on Shopee
  const lastSuccess = new Date(Date.now() - 6 * 60_000);
  await db.from("channel_sync_states").update({ last_success_at: lastSuccess.toISOString(), metadata: {} }).eq("shop_id", s).eq("sync_type", "order");
  h.state.orders = orderFixtures([{ sn: `${TAG}-AUTO-1` }, { sn: `${TAG}-AUTO-2`, status: "READY_TO_SHIP" }]);
  h.calls.length = 0;
  const tick = await runShopeeSchedulerTick(db, { config, providerMode: "fixture" });
  const orderJob = tick.enqueued.find((e) => e.syncType === "order");
  assert.ok(orderJob, "order job due after its interval");
  await h.drain();
  const j = await job(orderJob!.jobId);
  assert.equal(j.mode, "incremental");
  assert.equal(j.status, "success");
  assert.equal(new Date(j.window_from!).getTime(), lastSuccess.getTime() - config.orderOverlapMinutes * 60_000, "window starts at last success − overlap");
  const fetched = h.calls.filter((c) => c.apiName === "v2.order.get_order_detail").flatMap((c) => (c.input as { orderSns: string[] }).orderSns);
  assert.deepEqual(fetched, [`${TAG}-AUTO-2`], "only the new order's detail is fetched");
  assert.equal((j.metadata!.stats as Record<string, number>).detailsSkippedUnchanged, 1);
  const { data: o } = await db.from("channel_orders").select("order_status").eq("shop_id", s).eq("external_order_sn", `${TAG}-AUTO-2`).single();
  assert.equal(o!.order_status, "READY_TO_SHIP");
  await settle([s]);
});

test("guards: unknown / inactive shop refused at enqueue; fixture runner refuses a live shop (failed, no retry)", async () => {
  await assert.rejects(enqueueSyncJob(db, { shopId: "00000000-0000-0000-0000-000000000000", syncType: "order", mode: "manual", priority: 5 }), /Không tìm thấy shop/);
  const s = await shop();
  await db.from("shops").update({ is_active: false }).eq("id", s);
  await assert.rejects(requestShopeeSync(db, { shopId: s, syncType: "order", mode: "manual" }), /tạm ngưng/);
  await db.from("shops").update({ is_active: true, data_source: "live" }).eq("id", s);
  const q = await requestShopeeSync(db, { shopId: s, syncType: "order", mode: "manual" });
  const h = harness([s]);
  assert.equal((await h.worker.runOne())!.status, "failed");
  assert.equal((await job(q.jobId)).error_code, "source_mismatch");
  assert.equal(h.calls.length, 0);
});
