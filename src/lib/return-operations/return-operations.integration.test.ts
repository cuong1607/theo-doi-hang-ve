// ============================================================
// SHOPEE-6B — daily return operations against the REAL database in
// .env.local (local Docker Supabase in dev):
//
//   node --env-file=.env.local --test src/lib/return-operations/return-operations.integration.test.ts
//
// Logistics sync goes through the real queue worker + runner with fixture
// providers; summaries / lists / notifications through the same services the
// page and the scheduler use. Notifications use an injected fake sender —
// nothing is ever sent to Zalo from this file.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { getSyncConfig } from "../channels/core/sync-config.ts";
import { SyncWorker } from "../channels/core/sync-worker.ts";
import { FixtureShopeeOrderProvider } from "../channels/shopee/order-provider.ts";
import { FixtureShopeePaymentProvider } from "../channels/shopee/payment-provider.ts";
import { FixtureShopeeProductProvider } from "../channels/shopee/product-provider.ts";
import { emptyReturnLogisticsFixtures, FixtureShopeeReturnLogisticsProvider, type ReturnLogisticsFixtureSet } from "../channels/shopee/return-logistics-provider.ts";
import { FixtureShopeeReturnProvider } from "../channels/shopee/return-provider.ts";
import { toJobFailure } from "../channels/shopee/sync-errors.ts";
import { createShopeeRunnerFactory, requestShopeeSync } from "../channels/shopee/sync-service.ts";
import { classifyReturnOperation } from "./classify.ts";
import { runReturnNotificationTick, type NotificationSender } from "./notifications.ts";
import { getDailyReturnOperationsList, getDailyReturnOperationsSummary, loadDeliveryWindows } from "./queries.ts";
import { addQuantities } from "./summary.ts";
import { assignWindow, resolveWindowSet } from "./windows.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `s6b${Date.now()}`;
const CAR3 = `${TAG} SPX`; // carrier with 3 windows
const CAR2 = `${TAG} JT`; // carrier with 2 windows
const shopIds: string[] = [];
const settingIds: string[] = [];
let savedCutoff: string | null = null;
let n = 0;
const vn = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const D = "2034-03-15"; // isolated business date (no real data there)

before(async () => {
  savedCutoff = ((await db.from("channel_sync_settings").select("orders_from").eq("id", true).single()).data?.orders_from as string | null) ?? null;
  await db.from("channel_sync_settings").update({ orders_from: null }).eq("id", true);
  const w = await db.from("return_delivery_windows").insert([
    { carrier: CAR3, name: "Ca sáng", start_time: "08:00", end_time: "11:59", sort_order: 1 },
    { carrier: CAR3, name: "Ca chiều", start_time: "12:00", end_time: "16:59", sort_order: 2 },
    { carrier: CAR3, name: "Ca tối", start_time: "17:00", end_time: "21:00", sort_order: 3 },
    { carrier: CAR2, name: "Đợt 1", start_time: "09:00", end_time: "12:59", sort_order: 1 },
    { carrier: CAR2, name: "Đợt 2", start_time: "13:00", end_time: "18:00", sort_order: 2 },
  ]);
  if (w.error) throw w.error;
});

after(async () => {
  await db.from("channel_sync_settings").update({ orders_from: savedCutoff }).eq("id", true);
  if (settingIds.length) {
    await db.from("return_notification_runs").delete().in("setting_id", settingIds);
    await db.from("return_notification_settings").delete().in("id", settingIds);
  }
  if (shopIds.length) {
    await db.from("return_notification_runs").delete().in("shop_id", shopIds);
    await db.from("channel_api_snapshots").delete().in("shop_id", shopIds);
    await db.from("shops").delete().in("id", shopIds);
  }
  await db.from("return_delivery_windows").delete().in("carrier", [CAR3, CAR2]);
});

// ------------------------------------------------------------------ helpers

async function shop(): Promise<string> {
  const { data, error } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: `ops ${n}`, currency: "VND", data_source: "fixture" }).select("id").single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

async function order(shopId: string, opts: { sn?: string; status?: string; pickup?: string | null; logistics?: string | null; carrier?: string; lines?: Array<{ qty: number; model?: string }> } = {}) {
  const sn = opts.sn ?? `${TAG}O${++n}`;
  const { data: o, error } = await db
    .from("channel_orders")
    .insert({
      shop_id: shopId,
      external_order_sn: sn,
      order_status: opts.status ?? "COMPLETED",
      currency: "VND",
      shipping_carrier: opts.carrier ?? CAR3,
      pickup_done_at_channel: opts.pickup === undefined ? new Date(Date.now() - 3 * 86400_000).toISOString() : opts.pickup,
      logistics_status: opts.logistics ?? null,
      created_at_channel: new Date(Date.now() - 4 * 86400_000).toISOString(),
      updated_at_channel: new Date(Date.now() - 86400_000).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  const lines = opts.lines ?? [{ qty: 1 }];
  const items = lines.map((l, i) => ({ order_id: o!.id, provider_line_key: `k${i}`, external_item_id: String(100 + i), external_model_id: l.model ?? null, item_name: `Sản phẩm ${i + 1}`, model_name: l.model ? `Màu ${l.model}` : null, model_sku: `SKU-${i + 1}`, quantity: l.qty }));
  const { error: e } = await db.from("channel_order_items").insert(items);
  if (e) throw e;
  return { orderId: o!.id as string, sn };
}

async function customerReturn(shopId: string, orderId: string, returnSn: string, items: Array<{ itemId: string; qty: number; model?: string }>, status = "PROCESSING") {
  const { data, error } = await db.rpc("apply_channel_return", {
    p_shop_id: shopId,
    p_order_id: orderId,
    p_return: { external_return_sn: returnSn, status, needs_logistics: true, tracking_number: `BUY-${returnSn}`, created_at_channel: new Date(Date.now() - 2 * 86400_000).toISOString(), updated_at_channel: new Date().toISOString(), is_terminal: false },
    p_items: items.map((i) => ({ external_item_id: i.itemId, external_model_id: i.model ?? null, quantity: i.qty, item_name: "x" })),
    p_synced_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return (data as { return_id: string }).return_id;
}

/** Direct observation through the same DB function the sync uses. */
async function applyOp(shopId: string, op: Record<string, unknown>, events: unknown[] = []) {
  const { data, error } = await db.rpc("apply_return_operation", { p_shop_id: shopId, p_op: op, p_events: events, p_synced_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  return data as { id: string; created: boolean; delivered_changed: boolean; business_date: string | null };
}

const deliveredFd = (shopId: string, orderId: string, at: string) => applyOp(shopId, { operation_type: "failed_delivery_return", channel_order_id: orderId, tracking_number: `T-${orderId.slice(0, 6)}`, canonical_status: "delivered_to_seller", source_segment: "failed_delivery_rts", delivered_to_seller_at: at, delivered_at_source: "tracking_event", last_status_at: at });

function worker(shopId: string, fixtures: ReturnLogisticsFixtureSet) {
  const calls: string[] = [];
  const config = { ...getSyncConfig({}), shopAllowlist: [shopId] };
  const w = new SyncWorker({
    db,
    config,
    workerId: `ops-${Math.random().toString(16).slice(2, 8)}`,
    createRunner: createShopeeRunnerFactory({
      db,
      config,
      providers: () => ({
        mode: "fixture",
        order: new FixtureShopeeOrderProvider({ listPages: [], ordersBySn: new Map() }),
        product: new FixtureShopeeProductProvider({ itemListPages: [], itemBaseInfo: { error: "", response: { item_list: [] } }, modelLists: {} }),
        payment: new FixtureShopeePaymentProvider(new Map()),
        return: new FixtureShopeeReturnProvider({ returnsBySn: new Map() }),
        returnLogistics: new FixtureShopeeReturnLogisticsProvider(fixtures, { onCall: (c) => void calls.push(c.apiName) }),
      }),
    }),
    classifyError: toJobFailure,
    logger: () => {},
  });
  const run = async (syncType: "return_logistics" | "failed_delivery", focusDate?: string) => {
    await requestShopeeSync(db, { shopId, syncType, mode: "manual", focusDate });
    const reports = [];
    for (let i = 0; i < 20; i++) {
      const r = await w.runOne(30_000);
      if (!r) break;
      reports.push(r);
    }
    return reports;
  };
  return { run, calls };
}

const opsOf = async (shopId: string) => ((await db.from("channel_return_operations").select("*").eq("shop_id", shopId).order("created_at")).data ?? []) as Array<Record<string, unknown>>;
const countOf = async (table: string, col: string, ids: string[]) => (await db.from(table).select("*", { count: "exact", head: true }).in(col, ids)).count ?? 0;

async function sideEffectFingerprint() {
  const tables = ["inventory_cost_ledger", "product_cost_state", "channel_return_restocks", "order_financials", "payout_orders", "order_income_releases"];
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = (await db.from(t).select("*", { count: "exact", head: true })).count;
  out.stock = ((await db.from("product_cost_state").select("quantity_on_hand::text, moving_average_cost::text").order("product_id")).data ?? []).map((r) => `${r.quantity_on_hand}|${r.moving_average_cost}`).join(",");
  return out;
}

// ================================================================ HOÀN TRẢ

test("70/63/76: Hoàn Trả via the return_logistics job — delivered event time, RTS tracking, business date, window; re-sync idempotent; late sync keeps the window", async () => {
  const s = await shop();
  const o = await order(s, { lines: [{ qty: 3 }, { qty: 1, model: "M2" }] });
  const returnId = await customerReturn(s, o.orderId, `${TAG}R1`, [{ itemId: "100", qty: 2 }, { itemId: "101", qty: 1, model: "M2" }]);
  const delivered = vn("2026-10-20", "10:15");
  const fx = emptyReturnLogisticsFixtures();
  fx.reverseBySn.set(`${TAG}R1`, {
    return_sn: `${TAG}R1`,
    tracking_number: `BUY-${TAG}R1`,
    reverse_logistics_status: "LOGISTICS_DELIVERY_DONE",
    post_return_logistics_status: "LOGISTICS_DELIVERY_DONE",
    post_return_logistics_update_time: unix(vn("2026-10-20", "14:05")),
    rts_tracking_number: "RTS-001",
    post_return_logistics_tracking_info: [
      { update_time: unix(vn("2026-10-20", "07:00")), tracking_description: "Lấy hàng tại kho", logistics_status: "LOGISTICS_PICKUP_DONE" },
      { update_time: unix(delivered), tracking_description: "Giao thành công", logistics_status: "LOGISTICS_DELIVERY_DONE" },
    ],
  });
  const w = worker(s, fx);
  // fingerprint AFTER the SHOPEE-6 return exists (storing a return is that phase's job) — only the logistics sync is measured
  const before = await sideEffectFingerprint();
  const reports = await w.run("return_logistics", "2026-10-20");
  assert.equal(reports.at(-1)?.status, "success");
  const [op] = await opsOf(s);
  assert.equal(op.operation_type, "customer_return");
  assert.equal(op.return_id, returnId);
  assert.equal(op.return_sn, `${TAG}R1`);
  assert.equal(new Date(op.delivered_to_seller_at as string).toISOString(), delivered, "delivered EVENT time (10:15), not the status update (14:05)");
  assert.equal(op.delivered_at_source, "tracking_event");
  assert.equal(op.business_date, "2026-10-20");
  assert.equal(op.rts_tracking_number, "RTS-001");
  assert.equal(op.logistics_provider, CAR3, "carrier falls back to the order's carrier");
  const items = (await db.from("channel_return_operation_items").select("item_name_snapshot, model_name_snapshot, sku_snapshot, quantity::text").eq("return_operation_id", op.id as string).order("sku_snapshot")).data!;
  assert.deepEqual(items.map((i) => [i.sku_snapshot, i.model_name_snapshot, i.quantity]), [["SKU-1", null, "2.0000"], ["SKU-2", "Màu M2", "1.0000"]], "returned quantities, product snapshot from the order line");

  const list = await getDailyReturnOperationsList(db, { date: "2026-10-20", shopId: s });
  const windows = await loadDeliveryWindows(db);
  assert.equal(windows.find((x) => x.id === list.rows[0].windowId)?.name, "Ca sáng");

  // re-sync: nothing duplicated (operation, items, events)
  const evBefore = await countOf("channel_return_logistics_events", "return_operation_id", [op.id as string]);
  assert.equal(evBefore, 2);
  await w.run("return_logistics", "2026-10-20");
  assert.equal((await opsOf(s)).length, 1);
  assert.equal(await countOf("channel_return_operation_items", "return_operation_id", [op.id as string]), 2);
  assert.equal(await countOf("channel_return_logistics_events", "return_operation_id", [op.id as string]), 2);
  const again = await getDailyReturnOperationsList(db, { date: "2026-10-20", shopId: s });
  assert.equal(again.rows[0].windowId, list.rows[0].windowId, "late sync (14:xx) never moves it out of Ca sáng");
  assert.ok(new Date(again.rows[0].lastSyncedAt) > new Date(list.rows[0].lastSyncedAt));
  assert.ok(w.calls.every((c) => c === "v2.returns.get_reverse_tracking_info"));
  const snap = await db.from("channel_api_snapshots").select("id", { count: "exact", head: true }).eq("shop_id", s).eq("entity_type", "return_logistics");
  assert.ok((snap.count ?? 0) >= 1, "raw payload kept as audit snapshot");

  assert.deepEqual(await sideEffectFingerprint(), before, "78: no inventory / COGS / financial / payout side effect");
});

// ================================================================ HOÀN HỦY + classification parity

test("68: Hoàn Hủy via the failed_delivery job — only cancelled-after-pickup orders without a return; tracking number fetched once; whole parcel quantities; SQL rule = TS rule", async () => {
  const s = await shop();
  const fd = await order(s, { status: "CANCELLED", logistics: "LOGISTICS_DELIVERY_FAILED", lines: [{ qty: 2 }, { qty: 1 }] });
  await order(s, { status: "CANCELLED", pickup: null, logistics: "LOGISTICS_READY" }); // cancelled before shipping
  await order(s, { status: "COMPLETED" }); // normal
  const withReturn = await order(s, { status: "CANCELLED" });
  await customerReturn(s, withReturn.orderId, `${TAG}RX`, [{ itemId: "100", qty: 1 }], "CANCELLED");
  const fx = emptyReturnLogisticsFixtures();
  fx.trackingNumberByOrderSn.set(fd.sn, "SPXVN0001");
  fx.trackingByOrderSn.set(fd.sn, {
    order_sn: fd.sn,
    logistics_status: "LOGISTICS_DELIVERY_FAILED",
    tracking_info: [
      { update_time: unix(vn("2026-10-19", "09:00")), description: "Giao thất bại", logistics_status: "FAILED_DELIVERED" },
      { update_time: unix(vn("2026-10-20", "14:30")), description: "Đã hoàn cho người bán", logistics_status: "RETURNED" },
    ],
  });
  const w = worker(s, fx);
  const reports = await w.run("failed_delivery");
  assert.equal(reports.at(-1)?.status, "success");
  const ops = await opsOf(s);
  assert.equal(ops.length, 1, "only the cancelled-after-pickup order becomes Hoàn Hủy");
  assert.equal(ops[0].operation_type, "failed_delivery_return");
  assert.equal(ops[0].channel_order_id, fd.orderId);
  assert.equal(ops[0].tracking_number, "SPXVN0001");
  assert.equal(ops[0].business_date, "2026-10-20");
  assert.equal(ops[0].return_sn, null);
  const qty = (await db.from("channel_return_operation_items").select("quantity::text").eq("return_operation_id", ops[0].id as string)).data!.map((r) => r.quantity as string);
  assert.equal(addQuantities(...qty), "3", "all order lines (2 + 1) — not one unit per order");
  await w.run("failed_delivery");
  assert.equal(w.calls.filter((c) => c === "v2.logistics.get_tracking_number").length, 1, "tracking number fetched once, then reused");
  assert.equal((await opsOf(s)).length, 1);

  // parity: SQL candidate rule = classifyReturnOperation
  const cases = [
    { orderStatus: "CANCELLED", pickupDoneAt: "2026-10-18T00:00:00Z", packageLogisticsStatus: null, returns: [] },
    { orderStatus: "CANCELLED", pickupDoneAt: null, packageLogisticsStatus: "LOGISTICS_COD_REJECTED", returns: [] },
    { orderStatus: "CANCELLED", pickupDoneAt: null, packageLogisticsStatus: "LOGISTICS_READY", returns: [] },
    { orderStatus: "CANCELLED", pickupDoneAt: null, packageLogisticsStatus: null, returns: [] },
    { orderStatus: "COMPLETED", pickupDoneAt: "2026-10-18T00:00:00Z", packageLogisticsStatus: "LOGISTICS_DELIVERY_DONE", returns: [] },
    { orderStatus: "TO_RETURN", pickupDoneAt: "2026-10-18T00:00:00Z", packageLogisticsStatus: null, returns: [] },
    { orderStatus: "CANCELLED", pickupDoneAt: "2026-10-18T00:00:00Z", packageLogisticsStatus: null, returns: [{ status: "CANCELLED", needsLogistics: true }] },
  ];
  for (const c of cases) {
    const { data, error } = await db.rpc("return_failed_delivery_candidate", { p_order_status: c.orderStatus, p_pickup_done_at: c.pickupDoneAt, p_package_status: c.packageLogisticsStatus, p_has_returns: c.returns.length > 0 });
    if (error) throw error;
    assert.equal(data, classifyReturnOperation(c) === "failed_delivery_return", JSON.stringify(c));
  }
});

// ================================================================ windows parity

test("72: SQL window assignment = TS (3-window and 2-window carriers, boundaries, outside, unknown carrier → global)", async () => {
  const windows = await loadDeliveryWindows(db);
  const s = await shop();
  for (const [carrier, times] of [
    [CAR3, ["07:59:59", "08:00:00", "11:59:59", "12:00:00", "16:59:30", "17:00:00", "21:00:59", "21:01:00", "23:59:00"]],
    [CAR2, ["08:59:00", "09:00:00", "12:59:59", "13:00:00", "18:00:00", "18:01:00"]],
    [null, ["10:00:00", "22:00:00"]],
  ] as const) {
    const set = resolveWindowSet(windows, s, carrier);
    for (const t of times) {
      const { data, error } = await db.rpc("return_assign_window", { p_shop_id: s, p_carrier: carrier, p_local: t });
      if (error) throw error;
      assert.equal(data ?? null, assignWindow(set, t)?.id ?? null, `${carrier} ${t}`);
    }
  }
});

// ================================================================ summary / reconciliation / history

test("73/55/25: daily summary — carrier groups × windows + outside reconcile to the day; filters; historical day independent", async () => {
  const s = await shop();
  const mk = async (carrier: string, hhmm: string, date = D, type: "cr" | "fd" = "fd", qty = 1) => {
    const o = await order(s, { status: type === "fd" ? "CANCELLED" : "COMPLETED", carrier, lines: [{ qty }] });
    if (type === "fd") return deliveredFd(s, o.orderId, vn(date, hhmm));
    const rid = await customerReturn(s, o.orderId, `${TAG}R${++n}`, [{ itemId: "100", qty }]);
    return applyOp(s, { operation_type: "customer_return", channel_order_id: o.orderId, return_id: rid, return_sn: `${TAG}R${n}`, canonical_status: "delivered_to_seller", delivered_to_seller_at: vn(date, hhmm), delivered_at_source: "tracking_event" });
  };
  await mk(CAR3, "08:00", D, "cr", 2);
  await mk(CAR3, "11:59", D, "fd", 1);
  await mk(CAR3, "12:00", D, "cr", 1);
  await mk(CAR3, "17:45", D, "fd", 3);
  await mk(CAR3, "22:30", D, "fd", 1); // outside
  await mk(CAR2, "13:30", D, "cr", 1);
  await mk(CAR3, "23:59", "2034-03-14", "fd", 1); // previous day, last minute
  await mk(CAR3, "00:01", "2034-03-16", "fd", 1); // next day, first minute

  const sum = await getDailyReturnOperationsSummary(db, { date: D, shopId: s });
  assert.equal(sum.total.orderCount, 6);
  assert.equal(sum.total.itemQuantity, "9");
  for (const g of sum.carrierGroups) {
    assert.equal(g.deliveryWindows.reduce((a, w) => a + w.total.orderCount, 0), g.total.orderCount, `${g.label}: windows + outside = day`);
    assert.equal(addQuantities(...g.deliveryWindows.map((w) => w.total.itemQuantity)), g.total.itemQuantity);
  }
  const spx = sum.carrierGroups.find((g) => g.carrier === CAR3)!;
  assert.deepEqual(spx.deliveryWindows.map((w) => `${w.name}:${w.customerReturn.orderCount}/${w.failedDeliveryReturn.orderCount}`), ["Ca sáng:1/1", "Ca chiều:1/0", "Ca tối:0/1", "Khác / Ngoài ca:0/1"]);
  const jt = sum.carrierGroups.find((g) => g.carrier === CAR2)!;
  assert.deepEqual(jt.deliveryWindows.map((w) => `${w.name}:${w.total.orderCount}`), ["Đợt 1:0", "Đợt 2:1"]);

  const onlyCr = await getDailyReturnOperationsSummary(db, { date: D, shopId: s, operationType: "customer_return" });
  assert.equal(onlyCr.total.orderCount, 3);
  const outside = await getDailyReturnOperationsSummary(db, { date: D, shopId: s, deliveryWindowId: "outside" });
  assert.equal(outside.total.orderCount, 1);
  const byCarrier = await getDailyReturnOperationsSummary(db, { date: D, shopId: s, carrier: CAR2.toUpperCase() });
  assert.equal(byCarrier.total.orderCount, 1, "carrier filter is case-insensitive");
  assert.equal((await getDailyReturnOperationsSummary(db, { date: "2034-03-14", shopId: s })).total.orderCount, 1, "23:59 VN stays on its day");
  assert.equal((await getDailyReturnOperationsSummary(db, { date: "2034-03-16", shopId: s })).total.orderCount, 1, "00:01 VN is the next day");

  const page1 = await getDailyReturnOperationsList(db, { date: D, shopId: s, page: 1, pageSize: 4 });
  const page2 = await getDailyReturnOperationsList(db, { date: D, shopId: s, page: 2, pageSize: 4 });
  assert.equal(page1.total, 6);
  assert.equal(page1.rows.length, 4);
  assert.equal(page2.rows.length, 2);
  const times = [...page1.rows, ...page2.rows].map((r) => r.deliveredToSellerAt!);
  assert.deepEqual(times, [...times].sort(), "sorted by delivered time ASC");
  const found = await getDailyReturnOperationsList(db, { date: D, shopId: s, search: page1.rows[1].externalOrderSn });
  assert.equal(found.total, 1);
});

// ================================================================ correction + notifications

test("75/47/49/54: notifications — one run per slot, duplicate tick creates nothing, exact delta by membership, first run 'đầu ngày', failed send not a delta base, provider correction does not rewrite history", async () => {
  const s = await shop();
  const { data: st, error } = await db.from("return_notification_settings").insert({ shop_id: s, name: TAG, enabled: true, carrier_filter: CAR3, include_delta: true, include_detail: true, presync_minutes: 10 }).select("id").single();
  if (error) throw error;
  settingIds.push(st.id);
  await db.from("return_notification_schedules").insert(["10:30", "14:30", "18:30"].map((t, i) => ({ setting_id: st.id, time_of_day: t, sort_order: i })));

  const sent: Array<{ message: string; dedupeKey: string }> = [];
  let failNext = false;
  const send: NotificationSender = async (m) => {
    sent.push(m);
    if (failNext) {
      failNext = false;
      return { totalRecipients: 1, sentCount: 0, failedCount: 1 };
    }
    return { totalRecipients: 2, sentCount: 2, failedCount: 0 };
  };
  const presync: Array<{ shopIds: string[]; focusDate: string }> = [];
  const tick = (hhmm: string) => runReturnNotificationTick(db, { send, enqueuePresync: async (x) => (presync.push(x), 3), now: new Date(vn(D, hhmm)) });
  const runsOf = async () => ((await db.from("return_notification_runs").select("*").eq("setting_id", st.id).order("scheduled_time")).data ?? []) as Array<Record<string, unknown>>;

  // morning deliveries (2), one other carrier (excluded by the setting's filter)
  const m1 = await deliveredFd(s, (await order(s, { status: "CANCELLED" })).orderId, vn(D, "09:10"));
  const m2 = await deliveredFd(s, (await order(s, { status: "CANCELLED", lines: [{ qty: 2 }] })).orderId, vn(D, "10:05"));
  await deliveredFd(s, (await order(s, { status: "CANCELLED", carrier: CAR2 })).orderId, vn(D, "10:06"));

  const pre = await tick("10:22");
  assert.equal(pre.generated.length, 0);
  assert.equal(presync.length, 1, "pre-sync enqueued before the 10:30 slot");
  assert.deepEqual(presync[0], { shopIds: [s], focusDate: D });

  const r1 = await tick("10:31");
  assert.equal(r1.generated.length, 1);
  assert.equal(r1.generated[0].status, "sent");
  assert.equal(r1.generated[0].totalOrders, 2);
  assert.equal(r1.generated[0].newOrders, null);
  assert.match(sent.at(-1)!.message, /Phát sinh từ đầu ngày:\n2 đơn \/ 3 SP/);
  assert.equal((await tick("10:35")).generated.length, 0, "duplicate tick in the same slot → no second run");
  assert.equal((await tick("11:20")).generated.length, 0, "past the grace → nothing back-filled");

  // afternoon: 2 new deliveries; one morning op corrected by the provider 10:05 → 10:20 (same set, not "new")
  await deliveredFd(s, (await order(s, { status: "CANCELLED" })).orderId, vn(D, "12:40"));
  await deliveredFd(s, (await order(s, { status: "CANCELLED", lines: [{ qty: 4 }] })).orderId, vn(D, "13:55"));
  const m2Order = (await db.from("channel_return_operations").select("channel_order_id").eq("id", m2.id).single()).data!.channel_order_id as string;
  const corrected = await deliveredFd(s, m2Order, vn(D, "10:20"));
  assert.equal(corrected.delivered_changed, true);

  const r2 = await tick("14:31");
  assert.equal(r2.generated[0].totalOrders, 4);
  assert.equal(r2.generated[0].newOrders, 2, "exact membership delta (+2), not count − count");
  assert.match(sent.at(-1)!.message, /Mới từ thông báo trước \(10:30\):\n\+2 đơn \/ 5 SP/);
  assert.match(sent.at(-1)!.message, /Ca chiều đến hiện tại/);

  // the 18:30 send fails → not a delta base
  await deliveredFd(s, (await order(s, { status: "CANCELLED" })).orderId, vn(D, "17:10"));
  failNext = true;
  const r3 = await tick("18:31");
  assert.equal(r3.generated[0].status, "failed");
  const runs = await runsOf();
  assert.deepEqual(runs.map((r) => `${String(r.scheduled_time).slice(0, 5)}:${r.status}:${r.total_order_count}:${r.new_order_count}`), ["10:30:sent:2:null", "14:30:sent:4:2", "18:30:failed:5:1"]);
  assert.equal(new Set(sent.map((x) => x.dedupeKey)).size, sent.length, "each run has its own dedupe key");

  // provider correction moves an op to ANOTHER day: today's summary changes, the 10:30 snapshot does not
  await deliveredFd(s, m2Order, vn("2034-03-16", "08:30"));
  const membership = await countOf("return_notification_run_operations", "notification_run_id", [runs[0].id as string]);
  assert.equal(membership, 2, "history snapshot keeps its membership");
  assert.equal((await runsOf())[0].total_order_count, 2);
  const now = await getDailyReturnOperationsSummary(db, { date: D, shopId: s, carrier: CAR3 });
  assert.equal(now.total.orderCount, 4, "live summary follows the correction");
  assert.ok(m1.id);

  // next business day: delta resets
  const nextDay = await runReturnNotificationTick(db, { send, enqueuePresync: async () => 0, now: new Date(vn("2034-03-16", "10:31")) });
  assert.equal(nextDay.generated[0].newOrders, null);
  assert.match(sent.at(-1)!.message, /Phát sinh từ đầu ngày/);
});

// ================================================================ confirmation / attention / multi-shop

test("31/32/64: 'Đã nhận' clears delivered-but-not-confirmed; tracking_missing for Hoàn Hủy; same order / return identifiers in two shops never collide", async () => {
  const s1 = await shop();
  const s2 = await shop();
  const o1 = await order(s1, { sn: `${TAG}SAME`, status: "CANCELLED" });
  const o2 = await order(s2, { sn: `${TAG}SAME`, status: "CANCELLED" });
  const old = new Date(Date.now() - 30 * 3600_000).toISOString();
  const a = await deliveredFd(s1, o1.orderId, old);
  const b = await deliveredFd(s2, o2.orderId, old);
  assert.notEqual(a.id, b.id);
  const r1 = await customerReturn(s1, o1.orderId, `${TAG}RSAME`, [{ itemId: "100", qty: 1 }]);
  const r2 = await customerReturn(s2, o2.orderId, `${TAG}RSAME`, [{ itemId: "100", qty: 1 }]);
  const c1 = await applyOp(s1, { operation_type: "customer_return", channel_order_id: o1.orderId, return_id: r1, return_sn: `${TAG}RSAME`, canonical_status: "pending" });
  const c2 = await applyOp(s2, { operation_type: "customer_return", channel_order_id: o2.orderId, return_id: r2, return_sn: `${TAG}RSAME`, canonical_status: "pending" });
  assert.notEqual(c1.id, c2.id);
  await assert.rejects(applyOp(s1, { operation_type: "customer_return", channel_order_id: o1.orderId, return_id: r2, return_sn: "x" }), /không thuộc/, "a return of another shop is refused");

  const get = async (id: string) => (await db.from("channel_return_operations").select("needs_attention, attention_reason, received_confirmed_at").eq("id", id).single()).data!;
  assert.deepEqual(await get(a.id), { needs_attention: true, attention_reason: "delivered_but_not_confirmed", received_confirmed_at: null });
  const before = await sideEffectFingerprint();
  const { error } = await db.rpc("confirm_return_operation_received", { p_operation_id: a.id, p_by: null, p_confirm: true });
  if (error) throw error;
  const after1 = await get(a.id);
  assert.equal(after1.needs_attention, false);
  assert.ok(after1.received_confirmed_at);
  assert.deepEqual(await sideEffectFingerprint(), before, "confirmation never touches stock / cost / money");

  const o3 = await order(s1, { status: "CANCELLED" });
  const t = await applyOp(s1, { operation_type: "failed_delivery_return", channel_order_id: o3.orderId, canonical_status: "pending" });
  await db.from("channel_return_operations").update({ created_at: new Date(Date.now() - 3 * 86400_000).toISOString() }).eq("id", t.id);
  await db.rpc("refresh_return_operation_attention", { p_shop_id: s1, p_operation_id: null });
  assert.equal((await get(t.id)).attention_reason, "tracking_missing");
});

// ================================================================ volume

test("74/62: 500 operations / day with multi-item orders — summary aggregated in SQL stays fast, list is server-paginated", async () => {
  const s = await shop();
  const orders = Array.from({ length: 500 }, (_, i) => ({ shop_id: s, external_order_sn: `${TAG}V${i}`, order_status: "CANCELLED", currency: "VND", shipping_carrier: i % 3 === 0 ? CAR2 : CAR3 }));
  const { data: os, error } = await db.from("channel_orders").insert(orders).select("id, external_order_sn");
  if (error) throw error;
  const ops = os!.map((o, i) => {
    const minute = 7 * 60 + Math.floor((i * 15 * 60) / 500); // 07:00 → 22:00 VN
    const at = vn(D, `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);
    return { shop_id: s, channel_order_id: o.id, operation_type: "failed_delivery_return", identity_key: `fd:${o.external_order_sn}`, canonical_status: "delivered_to_seller", delivered_to_seller_at: at, business_date: D, logistics_provider: i % 3 === 0 ? CAR2 : CAR3 };
  });
  const { data: inserted, error: e2 } = await db.from("channel_return_operations").insert(ops).select("id");
  if (e2) throw e2;
  const items = inserted!.flatMap((op, i) => Array.from({ length: (i % 3) + 1 }, (_, k) => ({ return_operation_id: op.id, provider_item_id: String(k), item_name_snapshot: `SP ${k}`, quantity: k + 1 })));
  for (let i = 0; i < items.length; i += 500) {
    const { error: e3 } = await db.from("channel_return_operation_items").insert(items.slice(i, i + 500));
    if (e3) throw e3;
  }
  const expectedItems = addQuantities(...items.map((x) => String(x.quantity)));

  const t0 = performance.now();
  const sum = await getDailyReturnOperationsSummary(db, { date: D, shopId: s });
  const summaryMs = performance.now() - t0;
  const t1 = performance.now();
  const page = await getDailyReturnOperationsList(db, { date: D, shopId: s, page: 3, pageSize: 50 });
  const listMs = performance.now() - t1;
  assert.equal(sum.total.orderCount, 500);
  assert.equal(sum.total.itemQuantity, expectedItems);
  for (const g of sum.carrierGroups) assert.equal(g.deliveryWindows.reduce((a, w) => a + w.total.orderCount, 0), g.total.orderCount);
  assert.equal(page.total, 500);
  assert.equal(page.rows.length, 50);
  assert.ok(page.rows.every((r) => r.items.length >= 1));
  console.log(`  500 ops/day: summary ${summaryMs.toFixed(0)} ms, list page ${listMs.toFixed(0)} ms`);
  assert.ok(summaryMs < 2000, `summary ${summaryMs} ms`);
  assert.ok(listMs < 2000, `list ${listMs} ms`);
});
