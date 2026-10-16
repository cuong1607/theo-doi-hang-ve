// ============================================================
// SHOPEE-5 — escrow sync, reconciliation and order P&L against the REAL
// database in .env.local (local Docker Supabase in dev) with the FIXTURE
// payment provider:
//
//   node --env-file=.env.local --test src/lib/channels/shopee/escrow-sync.integration.test.ts
//
// Each test seeds its own fixture shop + orders. Everything is deleted in
// `after` (shop cascade → orders → order_financials / components / snapshots).
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { getSyncConfig, type SyncConfig } from "../core/sync-config.ts";
import { SyncWorker } from "../core/sync-worker.ts";
import { ShopeeApiError } from "./errors.ts";
import { parseEscrowDetail } from "./escrow-adapter.ts";
import { ShopeeEscrowSyncService } from "./escrow-sync.ts";
import { FINANCIAL_CALCULATION_VERSION } from "./financial-dictionary.ts";
import { FixtureShopeeOrderProvider } from "./order-provider.ts";
import { FixtureShopeePaymentProvider, type ShopeePaymentProvider } from "./payment-provider.ts";
import { FixtureShopeeProductProvider } from "./product-provider.ts";
import { toJobFailure } from "./sync-errors.ts";
import { createShopeeRunnerFactory, requestShopeeSync } from "./sync-service.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `s5${Date.now()}`;
const shopIds: string[] = [];
let n = 0;
const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "shopee", "escrow");

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
});

async function shop(dataSource: "fixture" | "live" = "fixture"): Promise<string> {
  const { data, error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: `escrow ${n}`, currency: "VND", data_source: dataSource })
    .select("id")
    .single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

async function order(shopId: string, opts: { sn?: string; status?: string; updatedAt?: string; total?: string } = {}): Promise<{ id: string; sn: string }> {
  const sn = opts.sn ?? `${TAG}_${++n}`;
  const at = opts.updatedAt ?? new Date(Date.now() - 3600_000).toISOString();
  const { data, error } = await db
    .from("channel_orders")
    .insert({ shop_id: shopId, external_order_sn: sn, order_status: opts.status ?? "COMPLETED", currency: "VND", channel_total_amount: opts.total ?? "185000", created_at_channel: at, updated_at_channel: at })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id, sn };
}

/** A synthetic escrow envelope for `sn` (basic fixture with overrides). */
function escrow(sn: string, income: Record<string, unknown> = {}): unknown {
  const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "synthetic_basic.json"), "utf8"));
  raw.response.order_sn = sn;
  Object.assign(raw.response.order_income, income);
  return raw;
}

const fin = async (orderId: string) => (await db.from("order_financials").select("*, calculated_settlement_text:calculated_settlement::text, settlement_variance_text:settlement_variance::text, profit_after_cogs_text:profit_after_cogs::text").eq("order_id", orderId).maybeSingle()).data as Record<string, string | null> | null;
const components = async (orderId: string) =>
  ((await db.from("order_financial_components").select("*").eq("order_id", orderId).order("component_key")).data ?? []) as Array<Record<string, string | boolean | null>>;
const orderRow = async (orderId: string) => (await db.from("channel_orders").select("financial_status").eq("id", orderId).single()).data as { financial_status: string };
const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

function service(bySn: Map<string, unknown>, onCall?: () => void) {
  return new ShopeeEscrowSyncService({ db, provider: new FixtureShopeePaymentProvider(bySn, { onCall }) });
}

/** apply_order_escrow with hand-built components (reconciliation math independent of dictionary flags). */
async function applyRaw(orderId: string, fields: Record<string, string | null>, comps: Array<{ key: string; amount: string; included: boolean; unverified?: boolean }>, fingerprint = `fp-${Math.random()}`) {
  const { data, error } = await db
    .rpc("apply_order_escrow", {
      p_order_id: orderId,
      p_fields: fields,
      p_components: comps.map((c) => ({
        component_key: c.key,
        component_type: c.key,
        provider_field: c.key,
        category: "platform_fee",
        amount: c.amount,
        currency: "VND",
        funded_by: "seller",
        included_in_settlement: c.included,
        metadata: { unverified: c.unverified ?? false },
      })),
      p_fingerprint: fingerprint,
      p_synced_at: new Date().toISOString(),
      p_version: FINANCIAL_CALCULATION_VERSION,
    })
    .single<{ changed: boolean; reconciliation_status: string | null; financial_status: string | null }>();
  if (error) throw error;
  return data!;
}

// ================================================================ SYNC ONE ORDER

test("1. sync stores escrow columns, signed components, snapshot without buyer identity, settlement_available", async () => {
  const s = await shop();
  const o = await order(s);
  const r = await service(new Map([[o.sn, escrow(o.sn)]])).syncOrder(o.id);
  assert.equal(r.status, "applied");
  assert.equal(r.financialStatus, "settlement_available");
  const f = (await fin(o.id))!;
  assert.equal(num(f.escrow_amount), 151000);
  assert.equal(num(f.actual_shopee_income), 151000, "after_adjustment ?? escrow");
  assert.equal(num(f.commission_fee), 9000);
  assert.equal(f.calculation_version, FINANCIAL_CALCULATION_VERSION);
  assert.equal(num(f.calculated_settlement), 151000, "verified formula members");
  assert.equal(num(f.settlement_variance), 0);
  assert.equal(f.reconciliation_status, "matched");
  assert.equal(f.unverified_component_amount, null, "nothing unverified in this payload");
  assert.equal(f.internal_cogs, null);
  assert.equal(f.profit_after_cogs, null, "no COGS → no profit (unknown ≠ 0)");
  const c = await components(o.id);
  assert.equal(c.find((x) => x.component_key === "commission_fee")!.amount, -9000);
  assert.equal(c.find((x) => x.component_key === "commission_fee")!.included_in_settlement, true);
  assert.equal(c.find((x) => x.component_key === "credit_card_transaction_fee")!.included_in_settlement, false, "duplicate of seller_transaction_fee");
  assert.equal((await orderRow(o.id)).financial_status, "settlement_available");
  const { data: snaps } = await db.from("channel_api_snapshots").select("payload, entity_type").eq("shop_id", s).eq("entity_type", "escrow");
  assert.equal(snaps!.length, 1);
  assert.equal(JSON.stringify(snaps![0].payload).includes("buyer_user_name"), false);
});

test("2. idempotent: same payload → unchanged, no duplicate components / snapshots", async () => {
  const s = await shop();
  const o = await order(s);
  const sync = service(new Map([[o.sn, escrow(o.sn)]]));
  await sync.syncOrder(o.id);
  const before = await components(o.id);
  const r2 = await sync.syncOrder(o.id);
  assert.equal(r2.status, "unchanged");
  const after2 = await components(o.id);
  assert.equal(after2.length, before.length);
  assert.deepEqual(after2.map((c) => c.id), before.map((c) => c.id), "rows kept, not re-inserted");
  const { count } = await db.from("channel_api_snapshots").select("id", { count: "exact", head: true }).eq("shop_id", s).eq("entity_type", "escrow");
  assert.equal(count, 1);
});

test("3. changed payload updates in place; vanished components are removed", async () => {
  const s = await shop();
  const o = await order(s);
  const bySn = new Map<string, unknown>([[o.sn, escrow(o.sn)]]);
  const sync = service(bySn);
  await sync.syncOrder(o.id);
  bySn.set(o.sn, escrow(o.sn, { seller_transaction_fee: 0, service_fee: 7000, escrow_amount: 150000, escrow_amount_after_adjustment: 150000 }));
  const r = await sync.syncOrder(o.id);
  assert.equal(r.status, "applied");
  const c = await components(o.id);
  assert.equal(c.find((x) => x.component_key === "seller_transaction_fee"), undefined, "now zero → row removed");
  assert.equal(c.find((x) => x.component_key === "service_fee")!.amount, -7000);
  assert.equal(num((await fin(o.id))!.transaction_fee), 0);
  assert.equal(num((await fin(o.id))!.actual_shopee_income), 150000);
});

test("4. adjustments: separate rows, final income uses escrow_amount_after_adjustment", async () => {
  const s = await shop();
  const o = await order(s);
  const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "synthetic_adjusted.json"), "utf8"));
  raw.response.order_sn = o.sn;
  await service(new Map([[o.sn, raw]])).syncOrder(o.id);
  const f = (await fin(o.id))!;
  assert.equal(num(f.escrow_amount), 100000);
  assert.equal(num(f.escrow_amount_after_adjustment), 97000);
  assert.equal(num(f.actual_shopee_income), 97000);
  assert.equal(num(f.total_adjustment_amount), -3000);
  const adj = (await components(o.id)).filter((c) => c.provider_field === "order_adjustment");
  assert.deepEqual(adj.map((a) => num(a.amount as string)).sort(), [-5000, 2000]);
});

test("5. not-ready answer is recorded (back-off), order stays without settlement", async () => {
  const s = await shop();
  const o = await order(s);
  const r = await service(new Map()).syncOrder(o.id);
  assert.equal(r.status, "not_ready");
  const f = (await fin(o.id))!;
  assert.equal(f.escrow_last_error_code, "error_not_found");
  assert.equal(f.escrow_synced_at, null);
  assert.equal((await orderRow(o.id)).financial_status, "pending");
  const { data: cand } = await db.rpc("get_orders_needing_escrow_sync", { p_shop_id: s, p_limit: 10 });
  assert.equal((cand as unknown[]).length, 0, "inside error back-off → not a candidate");
  const { data: later } = await db.rpc("get_orders_needing_escrow_sync", { p_shop_id: s, p_limit: 10, p_now: new Date(Date.now() + 7 * 3600_000).toISOString() });
  assert.equal((later as unknown[]).length, 1, "after back-off → candidate again");
});

test("6. ineligible status is not fetched; data-source guard refuses fixture data into a live shop", async () => {
  const s = await shop();
  const o = await order(s, { status: "SHIPPED" });
  let calls = 0;
  const r = await service(new Map([[o.sn, escrow(o.sn)]]), () => void calls++).syncOrder(o.id);
  assert.equal(r.status, "ineligible");
  assert.equal(calls, 0);
  const live = await shop("live");
  const lo = await order(live);
  await assert.rejects(service(new Map([[lo.sn, escrow(lo.sn)]])).syncOrder(lo.id), /fixture/i);
});

test("7. job-level provider errors (rate limit) propagate — not recorded as a per-order failure", async () => {
  const s = await shop();
  const o = await order(s);
  const provider: ShopeePaymentProvider = {
    mode: "fixture",
    getEscrowDetail: async () => {
      throw new ShopeeApiError({ apiPath: "/api/v2/payment/get_escrow_detail", errorCode: "error_too_many_request", message: "rate limit", httpStatus: 429 });
    },
  };
  await assert.rejects(new ShopeeEscrowSyncService({ db, provider }).syncOrder(o.id));
  assert.equal((await fin(o.id))?.escrow_last_error_code ?? null, null);
});

// ================================================================ RECONCILIATION

test("8. reconciliation: matched / warning / mismatch by documented tolerance; unverified never summed", async () => {
  const s = await shop();
  const cases: Array<[string, string]> = [
    ["151005", "matched"], // |5| ≤ 10
    ["151500", "warning"], // |500| ≤ 1000
    ["160000", "mismatch"],
  ];
  for (const [calcBase, expected] of cases) {
    const o = await order(s);
    const r = await applyRaw(o.id, { escrow_amount: "151000" }, [
      { key: "base", amount: calcBase, included: true },
      { key: "unverified_fee", amount: "-99999", included: false, unverified: true },
    ]);
    assert.equal(r.reconciliation_status, expected, calcBase);
    const f = (await fin(o.id))!;
    assert.equal(num(f.calculated_settlement), Number(calcBase), "unverified row not in the sum");
    assert.equal(num(f.unverified_component_amount), -99999);
    assert.equal(num(f.settlement_variance), 151000 - Number(calcBase));
    assert.equal(num(f.settlement_tolerance), 10);
    assert.equal((await orderRow(o.id)).financial_status, expected === "mismatch" ? "mismatch" : "settlement_available");
  }
});

test("9. released / return_adjusted are never downgraded by escrow sync", async () => {
  const s = await shop();
  const o = await order(s);
  await db.from("channel_orders").update({ financial_status: "released" }).eq("id", o.id);
  const r = await applyRaw(o.id, { escrow_amount: "100" }, []);
  assert.equal(r.financial_status, "released");
});

// ================================================================ P&L

test("10. profit_after_cogs only when income AND COGS exist; COGS change recomputes; escrow never touches internal_cogs", async () => {
  const s = await shop();
  const o = await order(s);
  // COGS first (cost engine writes internal_cogs), escrow later
  await db.from("order_financials").insert({ order_id: o.id, internal_cogs: "90000" });
  assert.equal((await fin(o.id))!.profit_after_cogs, null, "COGS without income → no profit");
  await service(new Map([[o.sn, escrow(o.sn)]])).syncOrder(o.id);
  let f = (await fin(o.id))!;
  assert.equal(num(f.internal_cogs), 90000, "escrow did not overwrite internal_cogs");
  assert.equal(num(f.profit_after_cogs), 61000);
  assert.equal(num(f.actual_profit), 61000);
  assert.equal(f.contribution_profit, null, "other costs unknown → null, not = profit");
  assert.equal(f.actual_margin, null, "margin denominator not defined yet");
  // COGS changes → profit follows (trigger)
  await db.from("order_financials").update({ internal_cogs: "160000" }).eq("order_id", o.id);
  f = (await fin(o.id))!;
  assert.equal(num(f.profit_after_cogs), -9000, "loss is signed");
  // COGS becomes unknown → profit unknown
  await db.from("order_financials").update({ internal_cogs: null }).eq("order_id", o.id);
  assert.equal((await fin(o.id))!.profit_after_cogs, null);
});

test("11. refund does not reverse COGS (financial only)", async () => {
  const s = await shop();
  const o = await order(s);
  await db.from("order_financials").insert({ order_id: o.id, internal_cogs: "50000" });
  await service(new Map([[o.sn, escrow(o.sn, { seller_return_refund: 100000, escrow_amount: 51000, escrow_amount_after_adjustment: 51000 })]])).syncOrder(o.id);
  const f = (await fin(o.id))!;
  assert.equal(num(f.refund_amount), 100000);
  assert.equal(num(f.internal_cogs), 50000);
  assert.equal(num(f.profit_after_cogs), 1000);
});

test("12. NUMERIC exactness: decimal amounts survive without float drift", async () => {
  const s = await shop();
  const o = await order(s);
  await db.from("order_financials").insert({ order_id: o.id, internal_cogs: "0.30" });
  await applyRaw(o.id, { escrow_amount: "0.10", escrow_amount_after_adjustment: "0.40" }, [{ key: "a", amount: "0.10", included: true }, { key: "b", amount: "0.20", included: true }]);
  const f = (await fin(o.id))!;
  assert.equal(f.calculated_settlement_text, "0.30");
  assert.equal(f.settlement_variance_text, "0.10");
  assert.equal(f.profit_after_cogs_text, "0.10");
});

// ================================================================ CANDIDATES + JOB

test("13. candidate query: never synced → yes; fresh → no; provider changed order → yes; old stable → no", async () => {
  const s = await shop();
  const fresh = await order(s);
  const old = await order(s, { updatedAt: new Date(Date.now() - 40 * 86400_000).toISOString() });
  const shipped = await order(s, { status: "SHIPPED" });
  const ids = async (now = new Date()) =>
    new Set(((await db.rpc("get_orders_needing_escrow_sync", { p_shop_id: s, p_limit: 50, p_now: now.toISOString() })).data as Array<{ order_id: string }>).map((r) => r.order_id));
  let c = await ids();
  assert.ok(c.has(fresh.id) && c.has(old.id));
  assert.equal(c.has(shipped.id), false);
  const sync = service(new Map([[fresh.sn, escrow(fresh.sn)], [old.sn, escrow(old.sn)]]));
  await sync.syncOrder(fresh.id);
  await sync.syncOrder(old.id);
  c = await ids();
  assert.equal(c.size, 0, "just synced → nothing due");
  const in2days = new Date(Date.now() + 2 * 86400_000);
  c = await ids(in2days);
  assert.ok(c.has(fresh.id), "inside refresh window, older than refresh interval → refresh");
  assert.equal(c.has(old.id), false, "outside the refresh window → stable, not refetched");
  await db.from("channel_orders").update({ updated_at_channel: new Date(Date.now() + 60_000).toISOString() }).eq("id", old.id);
  assert.ok((await ids(new Date(Date.now() + 120_000))).has(old.id), "provider changed the order → refetch");
});

test("14. escrow job through the queue: bounded batches, checkpointed stats, repair scope", async () => {
  const s = await shop();
  const orders = [];
  for (let i = 0; i < 5; i++) orders.push(await order(s));
  const pending = await order(s); // no fixture → not ready
  const bySn = new Map<string, unknown>(orders.map((o) => [o.sn, escrow(o.sn)]));
  const calls: string[] = [];
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: [s], escrowBatchSize: 2 };
  const worker = new SyncWorker({
    db,
    config,
    workerId: `t5-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: () => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider({ listPages: [], ordersBySn: new Map() }),
        product: new FixtureShopeeProductProvider({ listPages: [], itemBaseInfo: {}, modelLists: new Map() } as never),
        payment: new FixtureShopeePaymentProvider(bySn, { onCall: (c) => void calls.push((c.input as { orderSn: string }).orderSn) }),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });
  const job = await requestShopeeSync(db, { shopId: s, syncType: "escrow", mode: "manual" });
  for (let i = 0; i < 10; i++) if (!(await worker.runOne(30_000))) break;
  const { data: j } = await db.from("channel_sync_jobs").select("status, metadata, records_fetched").eq("id", job.jobId).single();
  assert.equal(j!.status, "success", JSON.stringify(j));
  const stats = (j!.metadata as { stats: Record<string, number> }).stats;
  assert.equal(stats.escrowFetched, 5);
  assert.equal(stats.notReady, 1);
  assert.equal(stats.missingCogs, 5);
  assert.equal(stats.settlementAvailable, 5);
  assert.equal(calls.length, 6, "each order fetched once (not-ready backs off, no loop)");
  assert.equal(calls.filter((sn) => sn === pending.sn).length, 1);
  const { data: logs } = await db.from("channel_sync_logs").select("status").eq("shop_id", s).eq("sync_type", "escrow");
  assert.ok((logs ?? []).length >= 1, "sync log written");

  // repair: explicit order list, forced refetch even though recently synced
  calls.length = 0;
  const repair = await requestShopeeSync(db, { shopId: s, syncType: "escrow", mode: "repair", orderSns: [orders[0].sn] });
  for (let i = 0; i < 5; i++) if (!(await worker.runOne(30_000))) break;
  assert.equal((await db.from("channel_sync_jobs").select("status").eq("id", repair.jobId).single()).data!.status, "success");
  assert.deepEqual(calls, [orders[0].sn]);
  // backfill is not a thing for escrow
  await assert.rejects(requestShopeeSync(db, { shopId: s, syncType: "escrow", mode: "backfill", backfillDays: 10 }));
});

test("PERF-2 23 + 24 + 25. 98-order escrow backlog drains over several bounded worker runs (≤ escrowConcurrency in flight); stable old order skipped", async () => {
  const s = await shop();
  const backlog = [];
  for (let i = 0; i < 98; i++) backlog.push(await order(s));
  // stable: completed 40 days ago and already synced → outside the refresh window
  const stable = await order(s, { updatedAt: new Date(Date.now() - 40 * 86400_000).toISOString() });
  const bySn = new Map<string, unknown>([...backlog, stable].map((o) => [o.sn, escrow(o.sn)]));
  await service(bySn).syncOrder(stable.id);

  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fixture = new FixtureShopeePaymentProvider(bySn);
  const payment: ShopeePaymentProvider = {
    mode: "fixture",
    async getEscrowDetail(ctx, input) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(input.orderSn);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await fixture.getEscrowDetail(ctx, input);
      } finally {
        inFlight--;
      }
    },
  };
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: [s] };
  assert.equal(config.escrowConcurrency, 2);
  assert.equal(config.maxSliceApiCalls, 30);
  const worker = new SyncWorker({
    db,
    config,
    workerId: `t5b-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: () => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider({ listPages: [], ordersBySn: new Map() }),
        product: new FixtureShopeeProductProvider({ listPages: [], itemBaseInfo: {}, modelLists: new Map() } as never),
        payment,
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });

  // enqueued ONCE (as the scheduler would) — no further clicks
  const job = await requestShopeeSync(db, { shopId: s, syncType: "escrow", mode: "incremental" });
  assert.equal((await db.from("channel_sync_jobs").select("priority").eq("id", job.jobId).single()).data!.priority, 20);
  const runs = [];
  const remainingSeen: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await worker.runOne(30_000);
    if (!r) break;
    runs.push(r);
    const { data: j } = await db.from("channel_sync_jobs").select("status, metadata").eq("id", job.jobId).single();
    const m = j!.metadata as { stats: Record<string, number>; continuationReason?: string };
    if (r.status === "pending") {
      assert.equal(j!.status, "pending", "normal continuation is pending — not success / retry / failed");
      assert.equal(m.continuationReason, "batch_limit");
      assert.equal(r.continuationReason, "batch_limit");
      assert.ok(r.apiCalls <= config.maxSliceApiCalls, `slice made ${r.apiCalls} calls`);
      remainingSeen.push(m.stats.remaining);
    }
  }
  assert.equal(runs.at(-1)!.status, "success");
  assert.ok(runs.length >= 4, `bounded: ${runs.length} worker runs for 98 orders at ${config.maxSliceApiCalls} calls/slice`);
  assert.ok(runs.slice(0, -1).every((r) => r.status === "pending"));
  assert.deepEqual([...remainingSeen].sort((a, b) => b - a), remainingSeen, "remaining only goes down");
  const { data: done } = await db.from("channel_sync_jobs").select("status, metadata, finished_at").eq("id", job.jobId).single();
  const stats = (done!.metadata as { stats: Record<string, number>; continuationReason?: string }).stats;
  assert.equal(stats.eligible, 98, "eligible counted at start (the stable old order is not)");
  assert.equal(stats.ordersChecked, 98);
  assert.equal(stats.escrowFetched, 98);
  assert.equal(stats.remaining, 0);
  assert.equal((done!.metadata as Record<string, unknown>).continuationReason, undefined, "cleared once finished");
  assert.ok(done!.finished_at);
  assert.equal(new Set(calls).size, 98, "each backlog order fetched exactly once");
  assert.equal(calls.length, 98);
  assert.equal(calls.includes(stable.sn), false, "stable old financial record skipped");
  assert.ok(maxInFlight <= config.escrowConcurrency && maxInFlight >= 2, `max in flight ${maxInFlight}`);
  const { count } = await db.from("order_financials").select("order_id", { count: "exact", head: true }).in("order_id", backlog.map((o) => o.id)).not("escrow_synced_at", "is", null);
  assert.equal(count, 98);
  const { data: st } = await db.from("channel_sync_states").select("last_success_at").eq("shop_id", s).eq("sync_type", "escrow").single();
  assert.ok(st!.last_success_at, "clean escrow job advances the escrow sync state");
});

test("PATCH estimated profit: order value − COGS in NUMERIC; null / zero handling; state filter; actual profit untouched", async () => {
  const s = await shop();
  const profit = await order(s, { total: "100000" }); // COGS 70000 → +30000, 30.0 %
  const loss = await order(s, { total: "80000" }); // COGS 90000 → -10000, -12.5 %
  const noCogs = await order(s, { total: "50000" }); // COGS unknown
  const zero = await order(s, { total: "0" }); // COGS 0 → 0, no margin
  const exact = await order(s, { total: "12345678901234.33" }); // beyond float precision
  await db.from("order_financials").insert([
    { order_id: profit.id, internal_cogs: "70000" },
    { order_id: loss.id, internal_cogs: "90000" },
    { order_id: zero.id, internal_cogs: "0" },
    { order_id: exact.id, internal_cogs: "0.11" },
  ]);
  const { data } = await db
    .from("v_channel_order_summary")
    .select("order_id, estimated_profit, estimated_margin_pct, estimated_profit_state, profit_after_cogs, internal_cogs")
    .eq("shop_id", s);
  const by = new Map((data ?? []).map((r) => [r.order_id as string, r]));
  assert.deepEqual(
    { p: by.get(profit.id)!.estimated_profit, m: by.get(profit.id)!.estimated_margin_pct, st: by.get(profit.id)!.estimated_profit_state },
    { p: "30000.00", m: "30.0", st: "profit" },
  );
  assert.deepEqual(
    { p: by.get(loss.id)!.estimated_profit, m: by.get(loss.id)!.estimated_margin_pct, st: by.get(loss.id)!.estimated_profit_state },
    { p: "-10000.00", m: "-12.5", st: "loss" },
  );
  assert.equal(by.get(noCogs.id)!.estimated_profit, null, "COGS unknown → not calculated (never 0)");
  assert.equal(by.get(noCogs.id)!.estimated_margin_pct, null);
  assert.equal(by.get(noCogs.id)!.estimated_profit_state, "insufficient");
  assert.equal(Number(by.get(zero.id)!.estimated_profit), 0);
  assert.equal(by.get(zero.id)!.estimated_margin_pct, null, "total 0 → no division, margin —");
  assert.equal(by.get(zero.id)!.estimated_profit_state, "profit", "0 counts as ≥ 0");
  assert.equal(by.get(exact.id)!.estimated_profit, "12345678901234.22", "NUMERIC exact, no float drift");
  // actual profit still needs Shopee income
  for (const o of [profit, loss, zero]) assert.equal(by.get(o.id)!.profit_after_cogs, null);

  // the summary RPC follows the new filter
  const count = async (state: string) =>
    Number(((await db.rpc("get_channel_order_financial_summary", { p_shop_id: s, p_estimated_state: state }).single()).data as { order_count: number }).order_count);
  assert.equal(await count("profit"), 3);
  assert.equal(await count("loss"), 1);
  assert.equal(await count("insufficient"), 1);
});

// ================================================================ VIEW / SUMMARY / SECURITY

test("15. list view + DB summary: null vs zero, totals only add known values, profit state", async () => {
  const s = await shop();
  const a = await order(s); // income + COGS → profit
  const b = await order(s); // income, no COGS
  const c = await order(s); // nothing
  const d = await order(s); // break-even
  await db.from("order_financials").insert([{ order_id: a.id, internal_cogs: "100000" }, { order_id: d.id, internal_cogs: "151000" }]);
  const sync = service(new Map([[a.sn, escrow(a.sn)], [b.sn, escrow(b.sn)], [d.sn, escrow(d.sn)]]));
  for (const o of [a, b, d]) await sync.syncOrder(o.id);
  const { data: rows } = await db.from("v_channel_order_summary").select("order_id, shopee_net_income, internal_cogs, profit_after_cogs, settlement_state, profit_state").eq("shop_id", s);
  const byId = new Map((rows ?? []).map((r) => [r.order_id as string, r]));
  assert.equal(byId.get(a.id)!.profit_state, "profit");
  assert.equal(byId.get(d.id)!.profit_state, "break_even");
  assert.equal(byId.get(b.id)!.profit_after_cogs, null);
  assert.equal(byId.get(b.id)!.profit_state, null);
  assert.equal(byId.get(c.id)!.shopee_net_income, null);
  assert.equal(byId.get(c.id)!.settlement_state, "missing");
  const { data: sum } = await db.rpc("get_channel_order_financial_summary", { p_shop_id: s }).single<Record<string, string | number>>();
  assert.equal(Number(sum!.order_count), 4);
  assert.equal(Number(sum!.with_income), 3);
  assert.equal(Number(sum!.income_sum), 453000);
  assert.equal(Number(sum!.with_profit), 2);
  assert.equal(Number(sum!.profit_sum), 51000);
  assert.equal(Number(sum!.missing_settlement), 1);
  assert.equal(Number(sum!.missing_cogs), 2);
  const { data: lossOnly } = await db.rpc("get_channel_order_financial_summary", { p_shop_id: s, p_profit_state: "profit" }).single<Record<string, string | number>>();
  assert.equal(Number(lossOnly!.order_count), 1);
  // "Thiếu giá vốn" filter = internal_cogs unknown, consistent with missing_cogs
  const { data: cogsMissing } = await db.rpc("get_channel_order_financial_summary", { p_shop_id: s, p_cogs_missing: true, p_settlement_state: "available" }).single<Record<string, string | number>>();
  assert.equal(Number(cogsMissing!.order_count), 1, "only b: has income, COGS unknown");
});

test("16. security: anon / authenticated cannot run escrow RPCs or read raw escrow snapshots", async () => {
  const anon = createClient(url!, anonKey!, { auth: { autoRefreshToken: false, persistSession: false } });
  const s = await shop();
  const o = await order(s);
  await service(new Map([[o.sn, escrow(o.sn)]])).syncOrder(o.id);
  const r1 = await anon.rpc("apply_order_escrow", { p_order_id: o.id, p_fields: {}, p_components: [], p_fingerprint: "x", p_synced_at: new Date().toISOString(), p_version: "x" });
  assert.ok(r1.error, "anon cannot apply escrow");
  const r2 = await anon.rpc("get_orders_needing_escrow_sync", { p_shop_id: s, p_limit: 1 });
  assert.ok(r2.error);
  const r3 = await anon.from("channel_api_snapshots").select("id").eq("shop_id", s);
  assert.ok(r3.error || (r3.data ?? []).length === 0, "raw snapshots not readable");
  const r4 = await anon.from("order_financial_components").select("id").eq("order_id", o.id);
  assert.ok(r4.error || (r4.data ?? []).length === 0);
});

test("18. real returned order: negative settlement stored signed, matched, loss when COGS is known", async () => {
  const s = await shop();
  const o = await order(s);
  const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "realvn_returned.json"), "utf8"));
  raw.response.order_sn = o.sn;
  await db.from("order_financials").insert({ order_id: o.id, internal_cogs: "0" });
  const r = await service(new Map([[o.sn, raw]])).syncOrder(o.id);
  assert.equal(r.reconciliationStatus, "matched");
  const f = (await fin(o.id))!;
  assert.equal(num(f.actual_shopee_income), -2700, "seller owes 2700 — not +2700");
  assert.equal(num(f.calculated_settlement), -2700);
  assert.equal(num(f.profit_after_cogs), -2700);
  const { data: v } = await db.from("v_channel_order_summary").select("profit_state").eq("order_id", o.id).single();
  assert.equal(v!.profit_state, "loss");
});

test("19. calculation version bump: synced orders become candidates again ('version_changed') and are recalculated", async () => {
  const s = await shop();
  const o = await order(s, { updatedAt: new Date(Date.now() - 40 * 86400_000).toISOString() }); // outside the refresh window
  await service(new Map([[o.sn, escrow(o.sn)]])).syncOrder(o.id);
  const cands = async (version: string | null) =>
    ((await db.rpc("get_orders_needing_escrow_sync", { p_shop_id: s, p_limit: 10, p_calculation_version: version })).data ?? []) as Array<{ order_id: string; reason: string }>;
  assert.equal((await cands(FINANCIAL_CALCULATION_VERSION)).length, 0, "current version → stable");
  await db.from("order_financials").update({ calculation_version: "shopee-fin-v1" }).eq("order_id", o.id);
  const c = await cands(FINANCIAL_CALCULATION_VERSION);
  assert.deepEqual(c.map((x) => x.reason), ["version_changed"]);
  assert.equal((await cands(null)).length, 0, "no version passed → old behaviour");
  // re-sync recomputes even though Shopee's payload is identical (fingerprint carries the version)
  await db.from("order_financials").update({ escrow_fingerprint: "old-v1-fingerprint" }).eq("order_id", o.id);
  const r = await service(new Map([[o.sn, escrow(o.sn)]])).syncOrder(o.id);
  assert.equal(r.status, "applied");
  assert.equal((await fin(o.id))!.calculation_version, FINANCIAL_CALCULATION_VERSION);
});

test("17. parse → apply round trip keeps component sum consistent with the stored payload", async () => {
  const s = await shop();
  const o = await order(s);
  const raw = escrow(o.sn);
  const parsed = parseEscrowDetail(raw, { currency: "VND" });
  await service(new Map([[o.sn, raw]])).syncOrder(o.id);
  const stored = await components(o.id);
  assert.equal(stored.length, parsed.components.length);
  assert.equal((await fin(o.id))!.escrow_fingerprint, parsed.fingerprint);
});
