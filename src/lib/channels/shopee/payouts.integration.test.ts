// ============================================================
// SHOPEE-7 — income release + payout reconciliation against the REAL
// database in .env.local (local Docker Supabase in dev):
//
//   node --env-file=.env.local --test src/lib/channels/shopee/payouts.integration.test.ts
//
// Income / payout jobs run through the real queue worker + runners with
// fixture providers (raw provider field names); every formula is the SQL of
// migration 00058.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { hasPermission } from "../../auth/permissions.ts";
import { getCashflowSummary, getOrderIncomeStatus, getPayout, getPayoutAdjustments, getPayoutOrders, PayoutReconciliationError, resolvePayoutMismatch } from "../core/payouts.ts";
import { getSyncConfig } from "../core/sync-config.ts";
import { SyncWorker } from "../core/sync-worker.ts";
import { FixtureShopeeIncomeProvider, type IncomeFixtureData } from "./income-provider.ts";
import { FixtureShopeeOrderProvider } from "./order-provider.ts";
import { FixtureShopeePaymentProvider } from "./payment-provider.ts";
import { FixtureShopeeProductProvider } from "./product-provider.ts";
import { toJobFailure } from "./sync-errors.ts";
import { createShopeeRunnerFactory, requestShopeeSync } from "./sync-service.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `s7${Date.now()}`;
const NOW = Math.floor(Date.now() / 1000);
const shopIds: string[] = [];
let savedCutoff: string | null = null;
let n = 0;

before(async () => {
  savedCutoff = ((await db.from("channel_sync_settings").select("orders_from").eq("id", true).single()).data?.orders_from as string | null) ?? null;
  await db.from("channel_sync_settings").update({ orders_from: null }).eq("id", true);
});

after(async () => {
  await db.from("channel_sync_settings").update({ orders_from: savedCutoff }).eq("id", true);
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
});

// ------------------------------------------------------------------ helpers

async function shop(currency = "VND", externalId?: string): Promise<string> {
  const { data, error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: externalId ?? `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: `payout ${n}`, currency, data_source: "fixture" })
    .select("id")
    .single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

/** A stored order with its final Shopee income (escrow after adjustment); income null = escrow not synced. */
async function order(shopId: string, sn: string, opts: { status?: string; income?: string | null; currency?: string; completedAgoDays?: number } = {}) {
  const updated = new Date((NOW - (opts.completedAgoDays ?? 1) * 86400) * 1000).toISOString();
  const { data, error } = await db
    .from("channel_orders")
    .insert({ shop_id: shopId, external_order_sn: sn, order_status: opts.status ?? "COMPLETED", currency: opts.currency ?? "VND", created_at_channel: updated, updated_at_channel: updated })
    .select("id")
    .single();
  if (error) throw error;
  if (opts.income !== null) {
    const { error: e } = await db.from("order_financials").insert({ order_id: data.id, escrow_amount: opts.income ?? "100000", escrow_amount_after_adjustment: opts.income ?? "100000" });
    if (e) throw e;
  }
  return data.id as string;
}

const setIncome = async (orderId: string, income: string) => {
  const { error } = await db.from("order_financials").update({ escrow_amount_after_adjustment: income }).eq("order_id", orderId);
  if (error) throw error;
};

function harness(shopId: string, data: IncomeFixtureData, orders: Map<string, unknown> = new Map()) {
  const calls: string[] = [];
  const config = { ...getSyncConfig({}), shopAllowlist: [shopId] };
  const worker = new SyncWorker({
    db,
    config,
    workerId: `po-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: () => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider({ listPages: [], ordersBySn: orders }, { onCall: (c) => void calls.push(c.apiName) }),
        product: new FixtureShopeeProductProvider({ itemListPages: [], itemBaseInfo: { error: "", response: { item_list: [] } }, modelLists: {} }),
        payment: new FixtureShopeePaymentProvider(new Map()),
        income: new FixtureShopeeIncomeProvider(data, { onCall: (c) => void calls.push(c.apiName) }),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });
  const run = async (syncType: "income" | "payout") => {
    await requestShopeeSync(db, { shopId, syncType, mode: "manual" });
    const reports = [];
    for (let i = 0; i < 20; i++) {
      const r = await worker.runOne(30_000);
      if (!r) break;
      reports.push(r);
    }
    return reports;
  };
  return { run, calls };
}

const release = (sn: string, amount: number | string, agoSeconds = 3600) => ({ order_sn: sn, payout_amount: amount, escrow_release_time: NOW - agoSeconds });
const incomeOf = async (orderId: string) => (await getOrderIncomeStatus(db, orderId))!;
const payoutBy = async (shopId: string, providerId?: string) => {
  let q = db.from("payout_batches").select("id").eq("shop_id", shopId);
  if (providerId) q = q.eq("provider_payout_id", providerId);
  const { data } = await q.order("payout_time");
  return (data ?? []).map((r) => r.id as string);
};

// ================================================================ INCOME

test("SHOPEE-7 50: income — pending / released matches / mismatch / missing escrow / timestamps / not_available", async () => {
  const s = await shop();
  const okId = await order(s, `${TAG}OK`, { income: "74694" });
  const badId = await order(s, `${TAG}BAD`, { income: "50000" });
  const noEscrowId = await order(s, `${TAG}NOESC`, { income: null });
  const pendingId = await order(s, `${TAG}PEND`, { income: "30000", completedAgoDays: 2 });
  const staleId = await order(s, `${TAG}STALE`, { income: "30000", completedAgoDays: 30 });
  const openId = await order(s, `${TAG}OPEN`, { status: "SHIPPED", income: null });

  const h = harness(s, {
    releasedEscrows: [release(`${TAG}OK`, 74694, 7200), release(`${TAG}BAD`, 49000), release(`${TAG}NOESC`, 20000)],
    overview: { total_income: { pending_amount: 60000, released_amount: 143694 } },
  });
  const [r] = await h.run("income");
  assert.equal(r.status, "success");

  const ok = await incomeOf(okId);
  assert.deepEqual([ok.incomeStatus, ok.releasedAmount, ok.expectedAmount, ok.differenceAmount], ["reconciled", "74694.00", "74694.00", "0.00"]);
  assert.equal(ok.actualPayoutTime && new Date(ok.actualPayoutTime).getTime() / 1000, NOW - 7200, "actual_payout_time = escrow_release_time");
  assert.ok(ok.completedAtChannel, "completion time recorded, not overwritten by the release");
  assert.ok(ok.daysToRelease !== null && Number(ok.daysToRelease) > 0.5, "days_to_release derived");

  const bad = await incomeOf(badId);
  assert.deepEqual([bad.incomeStatus, bad.differenceAmount], ["mismatch", "-1000.00"], "released − expected");
  const noEsc = await incomeOf(noEscrowId);
  assert.deepEqual([noEsc.incomeStatus, noEsc.differenceAmount], ["released", null], "release confirmed, nothing to compare yet");
  assert.deepEqual([(await incomeOf(pendingId)).incomeStatus, (await incomeOf(pendingId)).releaseStale], ["pending", false]);
  assert.deepEqual([(await incomeOf(staleId)).incomeStatus, (await incomeOf(staleId)).releaseStale], ["pending", true], "completed > release_stale_days ago, still pending");
  assert.equal((await incomeOf(openId)).incomeStatus, "not_available", "not completed → never 'released' by assumption");

  // order P&L untouched: financial_status / actual income unchanged
  const fin = (await db.from("channel_orders").select("financial_status").eq("id", okId).single()).data!;
  assert.equal(fin.financial_status, "pending", "release never rewrites the financial lifecycle");

  // escrow arrives later → comparison follows automatically
  await db.from("order_financials").insert({ order_id: noEscrowId, escrow_amount: "20000", escrow_amount_after_adjustment: "20000" });
  assert.equal((await incomeOf(noEscrowId)).incomeStatus, "reconciled");

  // overview vs local aggregate (monitoring)
  const ov = (await db.from("channel_income_overviews").select("pending_amount::text, local_pending_amount::text, local_pending_orders, released_amount::text, local_released_amount::text, released_difference::text").eq("shop_id", s).single()).data!;
  assert.deepEqual(ov, { pending_amount: "60000.00", local_pending_amount: "60000.00", local_pending_orders: 2, released_amount: "143694.00", local_released_amount: "143694.00", released_difference: "0.00" });
  assert.ok(h.calls.includes("v2.payment.get_income_overview"));
});

test("SHOPEE-7 50 + 53: recently completed recheck, retry after a broken window, idempotent re-sync, release before the order is stored", async () => {
  const s = await shop();
  const id = await order(s, `${TAG}RE`, { income: "10000" });
  const data: IncomeFixtureData = { releasedEscrows: [] };
  const h = harness(s, data);
  await h.run("income");
  assert.equal((await incomeOf(id)).incomeStatus, "pending");

  // a broken page → partial, checkpoint not advanced
  data.releasedEscrows = [{ order_sn: `${TAG}RE`, payout_amount: "not-a-number", escrow_release_time: NOW - 600 }];
  const [broken] = await h.run("income");
  assert.equal(broken.status, "success");
  const job = (await db.from("channel_sync_jobs").select("records_failed").eq("id", broken.jobId).single()).data!;
  assert.equal(job.records_failed, 1);
  assert.equal((await incomeOf(id)).incomeStatus, "pending", "a bad entry is never stored as a guess");

  // next run: Shopee now reports it → released (the recheck)
  data.releasedEscrows = [release(`${TAG}RE`, 10000, 600), release(`${TAG}NOTYET`, 5000, 600)];
  await h.run("income");
  assert.equal((await incomeOf(id)).incomeStatus, "reconciled");
  const unlinked = (await db.from("order_income_releases").select("order_id").eq("shop_id", s).eq("external_order_sn", `${TAG}NOTYET`).single()).data!;
  assert.equal(unlinked.order_id, null, "release of an order not stored yet is kept, unlinked");

  // idempotent
  await h.run("income");
  assert.equal((await db.from("order_income_releases").select("id").eq("shop_id", s)).data!.length, 2);
  assert.equal((await db.from("channel_api_snapshots").select("id").eq("shop_id", s).eq("entity_type", "income")).data!.length, 2, "audit snapshot only on change");

  // the order arrives → linked + reconciled by trigger
  const late = await order(s, `${TAG}NOTYET`, { income: "5000" });
  assert.equal((await incomeOf(late)).incomeStatus, "reconciled");
});

// ================================================================ PAYOUT (cross-border payout_detail)

const payoutRaw = (time: number, amount: number | string, orders: Array<[string, number | string]>, adjustments: Array<[number | string, string]> = [], currency = "VND") => ({
  payout_info: { from_currency: currency, payout_currency: currency, from_amount: amount, payout_amount: amount, exchange_rate: 1, payout_time: time, pay_service: "bank", payee_id: "P1" },
  escrow_list: orders.map(([sn, a]) => ({ order_sn: sn, escrow_amount: a, currency })),
  offline_adjustment_list: adjustments.map(([a, scenario]) => ({ adjustment_amount: a, module: "finance", scenario, remark: `${scenario} remark`, adjustment_level: "shop" })),
});

test("SHOPEE-7 51 + 53: payout_detail — one order / many orders + ± adjustments matched, mismatch, idempotent, amount immutable", async () => {
  const s = await shop();
  const a = await order(s, `${TAG}PA`, { income: "100000" });
  await order(s, `${TAG}PB`, { income: "50000" });
  await order(s, `${TAG}PC`, { income: "25000" });
  const data: IncomeFixtureData = {
    payouts: [
      payoutRaw(NOW - 7200, 100000, [[`${TAG}PA`, 100000]]),
      // 50.000 + 25.000 + 3.000 compensation − 1.500 fee correction = 76.500
      payoutRaw(NOW - 3600, 76500, [[`${TAG}PB`, 50000], [`${TAG}PC`, 25000]], [[3000, "seller_compensation"], [-1500, "fee_correction"]]),
      payoutRaw(NOW - 1800, 999, []),
    ],
  };
  const h = harness(s, data);
  const [r] = await h.run("payout");
  assert.equal(r.status, "success");
  assert.equal((await db.from("shops").select("payout_source").eq("id", s).single()).data!.payout_source, "payout_detail");

  const ids = await payoutBy(s);
  assert.equal(ids.length, 3);
  const one = (await getPayout(db, ids[0]))!;
  assert.deepEqual([one.reconciliationStatus, one.expectedAmount, one.differenceAmount, one.orderCount], ["matched", "100000.00", "0.00", 1]);
  const many = (await getPayout(db, ids[1]))!;
  assert.deepEqual([many.reconciliationStatus, many.ordersReleasedTotal, many.adjustmentsTotal, many.expectedAmount, many.differenceAmount, many.adjustmentCount], [
    "matched",
    "75000.00",
    "1500.00",
    "76500.00",
    "0.00",
    2,
  ]);
  const adj = await getPayoutAdjustments(db, ids[1]);
  assert.deepEqual(adj.map((x) => [x.adjustmentType, x.amount]).sort(), [["fee_correction", "-1500.00"], ["seller_compensation", "3000.00"]], "adjustments stored separately, signed");
  const mis = (await getPayout(db, ids[2]))!;
  assert.deepEqual([mis.reconciliationStatus, mis.expectedAmount, mis.differenceAmount], ["mismatch", "0.00", "999.00"]);
  // the payout's orders are releases too
  assert.equal((await incomeOf(a)).incomeStatus, "reconciled");
  assert.equal((await incomeOf(a)).providerPayoutId, one.providerPayoutId);

  // idempotent
  await h.run("payout");
  assert.equal((await payoutBy(s)).length, 3);
  assert.equal((await getPayoutOrders(db, ids[1])).length, 2);
  assert.equal((await getPayoutAdjustments(db, ids[1])).length, 2);

  // provider amount immutable
  const { error } = await db.from("payout_batches").update({ payout_amount: 1 }).eq("id", ids[0]);
  assert.equal(error?.code, "PO001");
});

test("SHOPEE-7 20 + 51: payout with an order not stored → fetched first; still missing → incomplete (never a false mismatch); arrives → matched", async () => {
  const s = await shop();
  const fetchable = `${TAG}FETCH`;
  const remote = {
    order_sn: fetchable,
    order_status: "COMPLETED",
    create_time: NOW - 7200,
    update_time: NOW - 3600,
    currency: "VND",
    total_amount: 40000,
    item_list: [{ order_item_id: 1, item_id: 1, item_name: "x", item_sku: "", model_id: 0, model_sku: "", model_original_price: 40000, model_discounted_price: 40000, model_quantity_purchased: 1 }],
  };
  const h = harness(s, { payouts: [payoutRaw(NOW - 3600, 70000, [[fetchable, 40000], [`${TAG}GHOST`, 30000]])] }, new Map([[fetchable, remote]]));
  await h.run("payout");
  assert.ok(h.calls.includes("v2.order.get_order_detail"), "missing payout order fetched through the order sync");
  const [pid] = await payoutBy(s);
  let p = (await getPayout(db, pid))!;
  assert.deepEqual([p.reconciliationStatus, p.incompleteReason, p.missingOrderCount, p.differenceAmount], ["incomplete", "orders_missing", 1, "0.00"]);
  const orders = await getPayoutOrders(db, pid);
  assert.ok(orders.find((o) => o.externalOrderSn === fetchable)?.orderId, "fetched order linked");

  await order(s, `${TAG}GHOST`, { income: "30000" });
  p = (await getPayout(db, pid))!;
  assert.equal(p.reconciliationStatus, "matched", "order stored later → payout re-reconciled by trigger");
});

// ================================================================ WALLET (local shops)

let tx = 0;
const wtx = (type: string, amount: number | string, balance: number | string, ago: number, extra: Record<string, unknown> = {}) => ({
  transaction_id: `${TAG}T${++tx}`,
  status: "COMPLETED",
  transaction_type: type,
  amount,
  current_balance: balance,
  create_time: NOW - ago,
  buyer_name: "pii",
  ...extra,
});

test("SHOPEE-7 14 + 21 + 22 + 23 + 52: wallet withdrawals = payouts; late return adjustment in the NEXT payout, original immutable; no double counting", async () => {
  const s = await shop();
  const a = await order(s, `${TAG}WA`, { income: "100000" });
  const b = await order(s, `${TAG}WB`, { income: "60000" });
  const data: IncomeFixtureData = {
    releasedEscrows: [release(`${TAG}WA`, 100000, 9000), release(`${TAG}WB`, 60000, 8900)],
    walletTransactions: [
      wtx("ESCROW_VERIFIED_ADD", 100000, 105000, 9000, { order_sn: `${TAG}WA` }), // opening 5.000
      wtx("ESCROW_VERIFIED_ADD", 60000, 165000, 8900, { order_sn: `${TAG}WB` }),
      wtx("ADJUSTMENT_ADD", 2000, 167000, 8800, { description: "seller compensation" }),
      wtx("WITHDRAWAL_CREATED", -167000, 0, 8000, { withdrawal_id: "W1" }),
      wtx("WITHDRAWAL_COMPLETED", 0, 0, 7900, { withdrawal_id: "W1" }),
    ],
  };
  const h = harness(s, data);
  await h.run("income");
  const [r] = await h.run("payout");
  assert.equal(r.status, "success");
  assert.equal((await db.from("shops").select("payout_source").eq("id", s).single()).data!.payout_source, "wallet", "local shop: payout_detail is cross-border only");
  const [w1] = await payoutBy(s, "W1");
  let p1 = (await getPayout(db, w1))!;
  // 5.000 opening + 160.000 releases + 2.000 adjustment − 0 closing = 167.000
  assert.deepEqual([p1.payoutStatus, p1.payoutAmount, p1.openingBalance, p1.ordersReleasedTotal, p1.adjustmentsTotal, p1.expectedAmount, p1.reconciliationStatus], [
    "completed",
    "167000.00",
    "5000.00",
    "160000.00",
    "2000.00",
    "167000.00",
    "matched",
  ]);
  const snap = (await db.from("channel_wallet_transactions").select("payload").eq("shop_id", s).limit(1).single()).data!;
  assert.equal((snap.payload as Record<string, unknown>).buyer_name, undefined, "buyer name stripped");

  // 3 days later: a return refund deducted from the wallet for order WA, then the next withdrawal
  data.walletTransactions!.push(
    wtx("ESCROW_VERIFIED_ADD", 40000, 40000, 3000, { order_sn: `${TAG}WC` }),
    wtx("ADJUSTMENT_MINUS", 15000, 25000, 2500, { order_sn: `${TAG}WA`, description: "return refund" }), // unsigned → sign from type
    wtx("WITHDRAWAL_CREATED", 25000, 0, 2000, { withdrawal_id: "W2", status: "PENDING" }), // unsigned → negative
  );
  await order(s, `${TAG}WC`, { income: "40000" });
  // escrow after adjustment reflects the refund (SHOPEE-6 / escrow re-sync)
  await setIncome(a, "85000");
  await h.run("payout");

  p1 = (await getPayout(db, w1))!;
  assert.deepEqual([p1.payoutAmount, p1.expectedAmount, p1.reconciliationStatus], ["167000.00", "167000.00", "matched"], "historical payout untouched");
  const [w2] = await payoutBy(s, "W2");
  const p2 = (await getPayout(db, w2))!;
  assert.deepEqual([p2.payoutStatus, p2.payoutAmount, p2.ordersReleasedTotal, p2.adjustmentsTotal, p2.reconciliationStatus], ["pending", "25000.00", "40000.00", "-15000.00", "pending"], "withdrawal not completed yet → pending");
  const adj = await getPayoutAdjustments(db, w2);
  assert.deepEqual(adj.map((x) => [x.externalOrderSn, x.amount]), [[`${TAG}WA`, "-15000.00"]]);

  // order WA: released 100.000 + later −15.000 = 85.000 = actual income after the return → reconciled, counted once
  const wa = await incomeOf(a);
  assert.deepEqual([wa.incomeStatus, wa.releasedAmount, wa.laterAdjustmentAmount, wa.differenceAmount], ["reconciled", "100000.00", "-15000.00", "0.00"]);
  assert.equal((await incomeOf(b)).incomeStatus, "reconciled");

  // completion of W2 → matched
  data.walletTransactions!.push(wtx("WITHDRAWAL_COMPLETED", 0, 0, 1000, { withdrawal_id: "W2" }));
  await h.run("payout");
  assert.equal((await getPayout(db, w2))!.reconciliationStatus, "matched");
  // idempotent wallet ledger
  await h.run("payout");
  assert.equal((await db.from("channel_wallet_transactions").select("id").eq("shop_id", s)).data!.length, 9);
  assert.equal((await payoutBy(s)).length, 2);
});

test("SHOPEE-7 52: refund before release → expected reflects the final income, no double deduction; compensation is its own adjustment", async () => {
  const s = await shop();
  // return refund already netted in escrow_amount_after_adjustment before Shopee released
  const id = await order(s, `${TAG}RF`, { income: "70000" });
  const h = harness(s, { releasedEscrows: [release(`${TAG}RF`, 70000)], payouts: [payoutRaw(NOW - 600, 75000, [[`${TAG}RF`, 70000]], [[5000, "seller_compensation"]])] });
  await h.run("income");
  await h.run("payout");
  const inc = await incomeOf(id);
  assert.deepEqual([inc.incomeStatus, inc.differenceAmount, inc.laterAdjustmentAmount], ["reconciled", "0.00", "0.00"], "compensation not linked to the order is never added to it");
  const [pid] = await payoutBy(s);
  assert.deepEqual([(await getPayout(db, pid))!.reconciliationStatus, (await getPayout(db, pid))!.adjustmentsTotal], ["matched", "5000.00"]);
});

// ================================================================ MULTI SHOP + DECIMAL + RESOLUTION

test("SHOPEE-7 54: two shops with the same order_sn / payout identity stay isolated", async () => {
  const s1 = await shop();
  const s2 = await shop();
  const sn = `${TAG}SAME`;
  const o1 = await order(s1, sn, { income: "10000" });
  const o2 = await order(s2, sn, { income: "20000" });
  const same = [payoutRaw(NOW - 600, 10000, [[sn, 10000]])];
  await harness(s1, { releasedEscrows: [release(sn, 10000)], payouts: same }).run("income");
  await harness(s1, { payouts: same }).run("payout");
  // shop 2 gets the identical payout payload (same derived payout id) with ITS amount
  await harness(s2, { payouts: [payoutRaw(NOW - 600, 10000, [[sn, 10000]])] }).run("payout");
  assert.equal((await incomeOf(o1)).incomeStatus, "reconciled");
  assert.equal((await incomeOf(o2)).incomeStatus, "mismatch", "shop 2's order compared with shop 2's payout only (10.000 ≠ 20.000)");
  const p1 = (await getPayoutOrders(db, (await payoutBy(s1))[0]))[0];
  const p2 = (await getPayoutOrders(db, (await payoutBy(s2))[0]))[0];
  assert.equal(p1.orderId, o1);
  assert.equal(p2.orderId, o2, "never linked to the other shop's order");
  assert.notEqual((await payoutBy(s1))[0], (await payoutBy(s2))[0]);
});

test("SHOPEE-7 9 + 55: decimal-exact comparison with the centralized tolerance (no float drift)", async () => {
  const s = await shop("SGD");
  const ids = await Promise.all([
    order(s, `${TAG}D1`, { income: "30.30", currency: "SGD" }),
    order(s, `${TAG}D2`, { income: "30.30", currency: "SGD" }),
    order(s, `${TAG}D3`, { income: "0.3", currency: "SGD" }),
  ]);
  // 10.10 + 20.20 in JS is 30.299999999999997 — the payout sum is NUMERIC in SQL
  await harness(s, {
    releasedEscrows: [release(`${TAG}D1`, "30.30"), release(`${TAG}D2`, "30.28"), release(`${TAG}D3`, 0.3)],
    payouts: [payoutRaw(NOW - 600, "30.30", [[`${TAG}D1`, "10.10"]], [["20.20", "correction"]], "SGD")],
  }).run("income");
  await harness(s, { payouts: [payoutRaw(NOW - 600, "30.30", [[`${TAG}D1`, "10.10"]], [["20.20", "correction"]], "SGD")] }).run("payout");
  assert.equal((await incomeOf(ids[2])).incomeStatus, "reconciled", "0.3 vs 0.30");
  assert.deepEqual([(await incomeOf(ids[1])).incomeStatus, (await incomeOf(ids[1])).differenceAmount], ["mismatch", "-0.02"], "beyond one minor unit");
  const [pid] = await payoutBy(s);
  assert.deepEqual([(await getPayout(db, pid))!.expectedAmount, (await getPayout(db, pid))!.differenceAmount, (await getPayout(db, pid))!.reconciliationStatus], ["30.30", "0.00", "matched"]);
  const { data: tol } = await db.rpc("money_match_tolerance", { p_currency: "VND" });
  assert.equal(String(tol), "1");
});

test("SHOPEE-7 31 + 32 + 48 + 49: manual note + resolution keep the original difference; permissions; dashboard metrics", async () => {
  const s = await shop();
  await harness(s, { payouts: [payoutRaw(NOW - 600, 1234, [])] }).run("payout");
  const [pid] = await payoutBy(s);
  await assert.rejects(resolvePayoutMismatch(db, { payoutId: pid, note: "ok", resolutionStatus: "accepted", resolutionReason: "", by: null }), (e: unknown) => e instanceof PayoutReconciliationError && e.code === "PO012");
  await resolvePayoutMismatch(db, { payoutId: pid, note: "đang kiểm tra với Shopee", resolutionStatus: "investigating", by: null });
  await resolvePayoutMismatch(db, { payoutId: pid, note: "Shopee xác nhận phí ngoài hệ thống", resolutionStatus: "accepted", resolutionReason: "phí ngoài", by: null });
  const p = (await getPayout(db, pid))!;
  assert.deepEqual([p.reconciliationStatus, p.differenceAmount, p.resolutionStatus, p.resolutionReason], ["mismatch", "1234.00", "accepted", "phí ngoài"], "numbers never rewritten to zero");
  const notes = (await db.from("payout_reconciliation_notes").select("difference_at_note::text").eq("payout_id", pid)).data!;
  assert.deepEqual(notes.map((x) => x.difference_at_note), ["1234.00", "1234.00"]);

  assert.equal(hasPermission("admin", "payout:reconcile"), true);
  assert.equal(hasPermission("staff", "payout:reconcile"), false);
  assert.equal(hasPermission("viewer", "payout:reconcile"), false);
  assert.equal(hasPermission("viewer", "channel:view"), true);

  const m = await getCashflowSummary(db, { shopId: s });
  assert.deepEqual([m.payoutsMismatch, m.payoutPeriodCount, m.payoutPeriodAmount], [0, 1, "1234.00"], "accepted mismatch no longer counted as open");
});
