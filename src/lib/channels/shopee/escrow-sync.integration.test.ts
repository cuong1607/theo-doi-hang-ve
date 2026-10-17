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
import { test, before, after } from "node:test";
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

/** 00055 orders-sync cutoff: these tests build orders days in the past — run without it, restore after. */
let savedCutoff: string | null = null;
const setCutoff = async (value: string | null) => {
  const { error } = await db.from("channel_sync_settings").update({ orders_from: value }).eq("id", true);
  if (error) throw error;
};

before(async () => {
  savedCutoff = ((await db.from("channel_sync_settings").select("orders_from").eq("id", true).single()).data?.orders_from as string | null) ?? null;
  await setCutoff(null);
});

after(async () => {
  await setCutoff(savedCutoff);
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

test("PATCH cutoff (00055): orders created before channel_sync_settings.orders_from are no settlement / estimate candidates", async () => {
  const s = await shop();
  const oldDone = await order(s, { updatedAt: new Date(Date.now() - 5 * 86400_000).toISOString() });
  const newDone = await order(s);
  const oldOpen = await order(s, { status: "SHIPPED", updatedAt: new Date(Date.now() - 5 * 86400_000).toISOString() });
  const newOpen = await order(s, { status: "SHIPPED" });
  const settle = async () =>
    new Set(((await db.rpc("get_orders_needing_escrow_sync", { p_shop_id: s, p_limit: 50 })).data as Array<{ order_id: string }>).map((r) => r.order_id));
  const estimate = async () =>
    new Set(((await db.rpc("get_orders_needing_escrow_estimate", { p_shop_id: s, p_limit: 50 })).data as Array<{ order_id: string }>).map((r) => r.order_id));
  assert.deepEqual([(await settle()).has(oldDone.id), (await estimate()).has(oldOpen.id)], [true, true], "no cutoff → everything");
  await setCutoff(new Date(Date.now() - 86400_000).toISOString());
  try {
    const [st, es] = [await settle(), await estimate()];
    assert.deepEqual([st.has(oldDone.id), st.has(newDone.id)], [false, true]);
    assert.deepEqual([es.has(oldOpen.id), es.has(newOpen.id)], [false, true]);
    assert.equal(Number((await db.rpc("count_orders_needing_escrow_estimate", { p_shop_id: s })).data), 1, "the count follows the same rule");
  } finally {
    await setCutoff(null);
  }
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

// ================================================================ PATCH: ESTIMATED REVENUE / PROFIT

const estimate = (orderId: string, amount: string) => db.rpc("apply_order_estimated_revenue", { p_order_id: orderId, p_amount: amount, p_synced_at: new Date().toISOString() });

test("PATCH 1 + 8: open order → Shopee escrow_amount stored as estimated revenue ONLY (no components, no actual income, status unchanged); buyer payment ignored", async () => {
  const s = await shop();
  const o = await order(s, { status: "SHIPPED", total: "118400" });
  const bySn = new Map<string, unknown>([[o.sn, escrow(o.sn, { escrow_amount: 74694, escrow_amount_after_adjustment: 74694, buyer_total_amount: 118400 })]]);
  const r = await service(bySn).syncEstimate(o.id);
  assert.equal(r.status, "applied");
  assert.equal(r.estimatedRevenue, "74694");
  const f = (await fin(o.id))!;
  assert.equal(num(f.estimated_order_revenue), 74694);
  assert.equal(f.estimated_revenue_source, "escrow_estimate");
  assert.ok(f.estimated_revenue_synced_at);
  for (const col of ["escrow_amount", "escrow_amount_after_adjustment", "actual_shopee_income", "escrow_synced_at", "calculated_settlement", "commission_fee"]) assert.equal(f[col], null, `${col} stays unknown`);
  assert.equal((await components(o.id)).length, 0, "no settlement components from an estimate");
  assert.equal((await orderRow(o.id)).financial_status, "pending", "financial status untouched");
  const { count } = await db.from("channel_api_snapshots").select("id", { count: "exact", head: true }).eq("entity_external_id", o.sn).eq("entity_type", "escrow");
  assert.equal(count, 1, "raw payload kept for audit");
  // same payload again → unchanged
  assert.equal((await service(bySn).syncEstimate(o.id)).status, "unchanged");
  // a completed order is not estimated through this path
  const done = await order(s, { status: "COMPLETED" });
  assert.equal((await service(new Map([[done.sn, escrow(done.sn)]])).syncEstimate(done.id)).status, "ineligible");
});

test("PATCH 2–6 + 9: estimated profit = estimated revenue − COGS; margin over channel_total_amount; null / zero / exact NUMERIC; filter", async () => {
  const s = await shop();
  const seller = await order(s, { status: "SHIPPED", total: "118400" }); // Seller Center example: 74.694 − 32.000 = 42.694 / 118.400 = 36,06 %
  const loss = await order(s, { status: "SHIPPED", total: "100000" }); // 60.000 − 65.000 = −5.000, −5,0 %
  const noCogs = await order(s, { status: "SHIPPED", total: "50000" });
  const noRevenue = await order(s, { status: "SHIPPED", total: "40000" });
  const zero = await order(s, { status: "SHIPPED", total: "0" });
  const exact = await order(s, { status: "SHIPPED", total: "20000000000000" });
  await db.from("order_financials").insert([
    { order_id: seller.id, internal_cogs: "32000" },
    { order_id: loss.id, internal_cogs: "65000" },
    { order_id: noRevenue.id, internal_cogs: "10000" },
    { order_id: zero.id, internal_cogs: "0" },
    { order_id: exact.id, internal_cogs: "0.11" },
  ]);
  for (const [o, amount] of [[seller, "74694"], [loss, "60000"], [noCogs, "50000"], [zero, "0"], [exact, "12345678901234.33"]] as const) assert.equal((await estimate(o.id, amount)).error, null);

  const { data } = await db
    .from("v_channel_order_summary")
    .select("order_id, estimated_order_revenue, estimated_profit, estimated_margin_pct, estimated_profit_state, profit_after_cogs")
    .eq("shop_id", s);
  const by = new Map((data ?? []).map((r) => [r.order_id as string, r]));
  const view = (id: string) => ({ rev: by.get(id)!.estimated_order_revenue, p: by.get(id)!.estimated_profit, m: by.get(id)!.estimated_margin_pct, st: by.get(id)!.estimated_profit_state });
  assert.deepEqual(view(seller.id), { rev: "74694.00", p: "42694.00", m: "36.1", st: "profit" }, "uses Shopee's estimated revenue, NOT the order total (118.400)");
  assert.deepEqual(view(loss.id), { rev: "60000.00", p: "-5000.00", m: "-5.0", st: "loss" });
  assert.deepEqual(view(noCogs.id), { rev: "50000.00", p: null, m: null, st: "insufficient" }, "COGS unknown → Chưa tính (never 0)");
  assert.deepEqual(view(noRevenue.id), { rev: null, p: null, m: null, st: "insufficient" }, "estimated revenue unknown → Chưa có / Chưa tính");
  assert.deepEqual(view(zero.id), { rev: "0.00", p: "0.00", m: null, st: "profit" }, "total 0 → no division");
  assert.equal(view(exact.id).p, "12345678901234.22", "NUMERIC exact, no float drift");
  // stored copy of the estimated profit follows the same rule (trigger)
  assert.equal(num((await fin(seller.id))!.estimated_profit), 42694);
  assert.equal((await fin(noCogs.id))!.estimated_profit, null);
  // actual profit still needs Shopee's settlement
  for (const o of [seller, loss, zero]) assert.equal(by.get(o.id)!.profit_after_cogs, null);

  const count = async (state: string) =>
    Number(((await db.rpc("get_channel_order_financial_summary", { p_shop_id: s, p_estimated_state: state }).single()).data as { order_count: number }).order_count);
  assert.equal(await count("profit"), 3);
  assert.equal(await count("loss"), 1);
  assert.equal(await count("insufficient"), 2);
});

test("PATCH 7: estimate and actual stay separate — settlement never overwrites an estimate; no estimate → settlement escrow_amount fills it; late estimate ignored", async () => {
  const s = await shop();
  const o = await order(s, { status: "SHIPPED", total: "185000" });
  await db.from("order_financials").insert({ order_id: o.id, internal_cogs: "100000" });
  assert.equal((await estimate(o.id, "152000")).data, "applied");
  await db.from("channel_orders").update({ order_status: "COMPLETED" }).eq("id", o.id);
  await service(new Map([[o.sn, escrow(o.sn)]])).syncOrder(o.id); // settlement escrow_amount 151000
  let f = (await fin(o.id))!;
  assert.deepEqual([num(f.estimated_order_revenue), f.estimated_revenue_source, num(f.actual_shopee_income)], [152000, "escrow_estimate", 151000]);
  assert.deepEqual([num(f.estimated_profit), num(f.actual_profit), num(f.profit_variance)], [52000, 51000, -1000], "actual − estimated");
  assert.equal((await estimate(o.id, "999999")).data, "settled", "a late estimate after settlement is ignored");
  assert.equal(num((await fin(o.id))!.estimated_order_revenue), 152000);

  const direct = await order(s, { status: "COMPLETED" });
  await service(new Map([[direct.sn, escrow(direct.sn)]])).syncOrder(direct.id);
  f = (await fin(direct.id))!;
  assert.deepEqual([num(f.estimated_order_revenue), f.estimated_revenue_source], [151000, "escrow_settlement"], "first known at settlement");
});

test("PATCH estimate candidates + missing escrow_amount: open orders without settlement only; refresh / order change / back-off", async () => {
  const s = await shop();
  const now = new Date();
  const open = await order(s, { status: "TO_CONFIRM_RECEIVE" });
  const unpaid = await order(s, { status: "UNPAID" });
  const completed = await order(s, { status: "COMPLETED" });
  const noAmount = await order(s, { status: "SHIPPED" });
  const ids = async () =>
    (((await db.rpc("get_orders_needing_escrow_estimate", { p_shop_id: s, p_limit: 50, p_now: now.toISOString(), p_refresh_interval_hours: 12, p_error_backoff_hours: 6 })).data ?? []) as Array<{ order_id: string; reason: string }>).map((r) => `${r.order_id}:${r.reason}`);
  assert.deepEqual((await ids()).sort(), [`${open.id}:never_estimated`, `${noAmount.id}:never_estimated`].sort(), "UNPAID / COMPLETED are not estimate candidates");
  assert.ok(!(await ids()).some((x) => x.startsWith(unpaid.id) || x.startsWith(completed.id)));

  const payload = escrow(noAmount.sn) as { response: { order_income: Record<string, unknown> } };
  delete payload.response.order_income.escrow_amount;
  const r = await service(new Map([[noAmount.sn, payload]])).syncEstimate(noAmount.id);
  assert.equal(r.status, "not_ready");
  assert.equal((await fin(noAmount.id))!.estimated_order_revenue, null, "unknown stays NULL, never 0");
  assert.equal((await fin(noAmount.id))!.estimate_last_error_code, "no_estimated_revenue");

  await estimate(open.id, "1000");
  assert.deepEqual(await ids(), [], "fresh estimate + back-off → nothing to do");
  const later = new Date(now.getTime() + 13 * 3600_000).toISOString();
  const after13h = (((await db.rpc("get_orders_needing_escrow_estimate", { p_shop_id: s, p_limit: 50, p_now: later, p_refresh_interval_hours: 12, p_error_backoff_hours: 6 })).data ?? []) as Array<{ order_id: string; reason: string }>).map((x) => `${x.order_id}:${x.reason}`);
  assert.deepEqual(after13h.sort(), [`${open.id}:refresh_interval`, `${noAmount.id}:never_estimated`].sort(), "stale estimate refreshed; failed one retried after back-off");
  await db.from("channel_orders").update({ updated_at_channel: new Date(now.getTime() + 60_000).toISOString() }).eq("id", open.id);
  assert.deepEqual(await ids(), [`${open.id}:order_changed`]);
  assert.equal(Number((await db.rpc("count_orders_needing_escrow_estimate", { p_shop_id: s, p_now: now.toISOString() })).data), 1);
});

test("PATCH escrow job: settlements first, then estimates of open orders — one job, bounded, counted", async () => {
  const s = await shop();
  const completed = [await order(s), await order(s)];
  const open = [await order(s, { status: "SHIPPED" }), await order(s, { status: "READY_TO_SHIP" }), await order(s, { status: "TO_CONFIRM_RECEIVE" })];
  const bySn = new Map<string, unknown>([...completed, ...open].map((o) => [o.sn, escrow(o.sn)]));
  const calls: string[] = [];
  const config: SyncConfig = { ...getSyncConfig({}), shopAllowlist: [s], escrowBatchSize: 2 };
  const worker = new SyncWorker({
    db,
    config,
    workerId: `t5e-${Math.random().toString(16).slice(2, 8)}`,
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
  const { data: j } = await db.from("channel_sync_jobs").select("status, metadata").eq("id", job.jobId).single();
  assert.equal(j!.status, "success", JSON.stringify(j));
  const stats = (j!.metadata as { stats: Record<string, number> }).stats;
  assert.equal(stats.eligible, 5, "settlement + estimate candidates");
  assert.equal(stats.escrowFetched, 2);
  assert.equal(stats.estimatesFetched, 3);
  assert.equal(stats.remaining, 0);
  assert.deepEqual(calls.slice(0, 2).sort(), completed.map((o) => o.sn).sort(), "settlements first");
  for (const o of open) {
    const f = (await fin(o.id))!;
    assert.deepEqual([num(f.estimated_order_revenue), f.actual_shopee_income], [151000, null]);
  }
  for (const o of completed) assert.equal(num((await fin(o.id))!.actual_shopee_income), 151000);
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
