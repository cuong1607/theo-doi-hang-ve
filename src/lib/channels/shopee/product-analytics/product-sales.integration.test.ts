// ============================================================
// PRODUCT-ANALYTICS-2 — product sales facts + canonical metrics against the
// LOCAL database (migration 00070):
//
//   node --env-file=.env.local --test src/lib/channels/shopee/product-analytics/product-sales.integration.test.ts
//
// isolated job product_sales_facts_read through the REAL queue / worker with a
// fixture reader → facts (idempotent, restatement, stale-skip, cancelled kept,
// multi-item, cross-midnight VN, cross-shop same item id) → NUMERIC money →
// daily view / summary / list / baseline RPCs → Ads join (single-item
// campaigns only, never across shops) → product identity for Ads and non-Ads
// products → checkpoint / resume → extra-info snapshots → agent tools
// (authorization, compact payload, no PII / SQL) → page reads = 0 provider calls.
// Test shops / users are created and deleted here; nothing else is touched.
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { getSyncConfig } from "../../core/sync-config.ts";
import { SyncWorker, type SliceReport } from "../../core/sync-worker.ts";
import { ApiCallMeter } from "../sync-instrumentation.ts";
import { toJobFailure } from "../sync-errors.ts";
import { getProductAnalyticsSyncConfig, type ProductAnalyticsSyncConfig } from "../../../product-analytics/config.ts";
import { resolveProductPeriod } from "../../../product-analytics/periods.ts";
import { loadProductDetail, loadProductList, resolveProductById } from "../../../product-analytics/read-model.ts";
import { compare_product_periods, get_product_ads_performance, get_product_baseline, get_product_overview, get_product_sales_summary, get_product_signals, ProductToolAccessError } from "../../../product-analytics/agent-tools.ts";
import { FixtureProductSalesReader, MeteredProductSalesReader } from "./sales-reader.ts";
import { createProductAnalyticsRunner, enqueueProductAnalyticsJob, PRODUCT_ANALYTICS_SYNC_TYPES, upsertProductSalesFacts } from "./sales-sync.ts";
import { runProductAnalyticsSchedulerTick } from "./sales-schedule.ts";
import { mapOrderToSalesFacts } from "../../../product-analytics/sales-facts.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("Test tích hợp Product Analytics chỉ chạy với DB local.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `pa2${Date.now()}`;
const NOW = new Date("2026-10-30T08:00:00Z"); // 15:00 VN
let clock = NOW;
const shopIds: string[] = [];
const users: string[] = [];
let CONFIG: ProductAnalyticsSyncConfig = { ...getProductAnalyticsSyncConfig({ PRODUCT_SALES_SYNC_ENABLED: "true", PRODUCT_EXTRA_INFO_SYNC_ENABLED: "true" }) };

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
  for (const id of users) await db.auth.admin.deleteUser(id);
});

async function newShop(n: number) {
  const { data, error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: `${Date.now()}${n}`, shop_name: `${TAG} shop ${n}`, currency: "VND", data_source: "live", region: "VN", is_active: true })
    .select("id")
    .single();
  if (error) throw error;
  shopIds.push(data.id);
  await db.from("shop_connections").insert({ shop_id: data.id, connection_status: "connected" });
  await db.from("product_analytics_shop_settings").insert({ shop_id: data.id, sales_sync_enabled: true, extra_info_enabled: true });
  return data.id as string;
}

const vn = (iso: string) => Math.floor(Date.parse(`${iso}+07:00`) / 1000);

function line(lineId: number, itemId: number, qty: number, price: number | string, extra: Record<string, unknown> = {}) {
  return { line_item_id: lineId, order_item_id: lineId, item_id: itemId, model_id: 0, model_quantity_purchased: qty, cancelled_qty: 0, returned_qty: 0, model_original_price: price, model_discounted_price: price, item_name: `Sản phẩm ${itemId}`, item_sku: `SKU-${itemId}`, ...extra };
}

function ord(sn: string, status: string, createdVn: string, lines: unknown[], updatedVn = createdVn) {
  return { order_sn: sn, order_status: status, create_time: vn(createdVn), update_time: vn(updatedVn), currency: "VND", message_to_seller: "gọi 0901234567", recipient_address: { phone: "0901234567" }, item_list: lines };
}

function worker(onlyShops: string[], reader: FixtureProductSalesReader) {
  const config = { ...getSyncConfig(), shopAllowlist: onlyShops, globalWorkers: 10, maxRunningPerShop: 1, sliceTimeBudgetMs: 120_000, maxSliceApiCalls: 200 };
  return new SyncWorker({
    db,
    config,
    workerId: `test-${TAG}`,
    syncTypes: PRODUCT_ANALYTICS_SYNC_TYPES,
    classifyError: toJobFailure,
    now: () => clock,
    logger: () => {},
    maxRunningAds: null,
    createRunner: (job, budget) => {
      const meter = new ApiCallMeter(budget);
      return { meter, runner: createProductAnalyticsRunner(job, { db, reader: new MeteredProductSalesReader(reader, meter), config: CONFIG }) };
    },
  });
}

async function drain(onlyShops: string[], reader: FixtureProductSalesReader, max = 200): Promise<SliceReport[]> {
  const w = worker(onlyShops, reader);
  const out: SliceReport[] = [];
  for (let i = 0; i < max; i++) {
    const r = await w.runOne(120_000);
    if (!r) break;
    out.push(r);
  }
  return out;
}

async function facts(shopId: string) {
  const { data, error } = await db.from("shopee_product_sales_facts").select("*").eq("shop_id", shopId).order("provider_order_id").order("provider_line_item_id");
  if (error) throw error;
  return data ?? [];
}

let A = "";
let B = "";
const ordersA = new Map<string, Record<string, unknown>>();
const ordersB = new Map<string, Record<string, unknown>>();
const readerA = new FixtureProductSalesReader({ orders: ordersA, pageSize: 2, extraInfo: new Map([["111", { item_id: 111, sale: 270508, views: 13892, likes: 50, rating_star: 4.9, comment_count: 1200 }]]) });
const readerB = new FixtureProductSalesReader({ orders: ordersB });

test("PA2 / §4 §17 §66. backfill through the real queue: facts per line, cancelled kept, multi-item, no PII persisted", async () => {
  A = await newShop(1);
  B = await newShop(2);
  for (const o of [
    ord("A-001", "SHIPPED", "2026-10-29T10:00:00", [line(1, 111, 2, 199999.5), line(2, 222, 1, 50000)]),
    ord("A-002", "CANCELLED", "2026-10-29T11:00:00", [line(3, 111, 1, 199999.5, { cancelled_qty: 1 })]),
    ord("A-003", "COMPLETED", "2026-10-28T09:00:00", [line(4, 111, 3, "33333.33"), line(5, 111, 1, 0, { promotion_type: "add_on_free_gift_sub" })]),
    // cross-midnight VN: 23:30 on 27/10 and 00:30 on 28/10
    ord("A-004", "COMPLETED", "2026-10-27T23:30:00", [line(6, 333, 1, "0.1")]),
    ord("A-005", "COMPLETED", "2026-10-28T00:30:00", [line(7, 333, 1, "0.2")]),
    ord("A-006", "UNPAID", "2026-10-30T09:00:00", [line(8, 111, 1, 199999.5)]),
    // older than the 30-day backfill window → never read
    ord("A-OLD", "COMPLETED", "2026-09-01T10:00:00", [line(9, 111, 1, 1)]),
  ]) ordersA.set(o.order_sn, o);
  ordersB.set("B-001", ord("B-001", "SHIPPED", "2026-10-29T10:00:00", [line(1, 111, 5, 1000)]));

  await enqueueProductAnalyticsJob(db, { shopId: A, syncType: "product_sales_facts_read", strategy: "backfill", now: clock });
  await enqueueProductAnalyticsJob(db, { shopId: B, syncType: "product_sales_facts_read", strategy: "backfill", now: clock });
  const slicesA = await drain([A], readerA);
  await drain([B], readerB);
  assert.ok(slicesA.every((s) => s.status !== "failed"), JSON.stringify(slicesA));
  const fa = await facts(A);
  assert.equal(fa.length, 8, "8 lines in 6 orders inside the window (A-OLD not read)");
  assert.ok(!fa.some((f) => f.provider_order_id === "A-OLD"));
  const cancelled = fa.find((f) => f.provider_order_id === "A-002")!;
  assert.equal(cancelled.is_cancelled, true);
  assert.equal(cancelled.valid_quantity, 0);
  assert.equal(Object.keys(fa[0]).some((k) => /buyer|recipient|phone|address|message/.test(k)), false);
  assert.ok(!JSON.stringify(fa).includes("0901234567"), "no buyer data stored");
  const { data: settings } = await db.from("product_analytics_shop_settings").select("sales_backfill_done_at").eq("shop_id", A).single();
  assert.ok(settings!.sales_backfill_done_at, "backfill marker set after a clean run");
  // cross-midnight
  assert.equal(fa.find((f) => f.provider_order_id === "A-004")!.report_date, "2026-10-27");
  assert.equal(fa.find((f) => f.provider_order_id === "A-005")!.report_date, "2026-10-28");
  // provider calls per shop: create_time windows × pages + detail batches
  const calls = readerA.calls.reduce<Record<string, number>>((a, c) => ({ ...a, [c.api]: (a[c.api] ?? 0) + 1 }), {});
  assert.ok(calls["v2.order.get_order_list"] >= 3 && calls["v2.order.get_order_detail"] >= 3, JSON.stringify(calls));
});

test("PA2 / §9 §66. idempotent: re-running the same read creates / updates nothing", async () => {
  const before = await facts(A);
  await enqueueProductAnalyticsJob(db, { shopId: A, syncType: "product_sales_facts_read", strategy: "backfill", now: clock });
  await drain([A], readerA);
  const afterRows = await facts(A);
  assert.equal(afterRows.length, before.length);
  assert.deepEqual(afterRows.map((f) => f.updated_at), before.map((f) => f.updated_at), "unchanged rows are not rewritten");
});

test("PA2 / §19 §66. restatement: SHIPPED → CANCELLED (newer update_time) flips the fact; an OLDER read never overwrites", async () => {
  clock = new Date("2026-10-30T09:00:00Z");
  ordersA.set("A-001", ord("A-001", "CANCELLED", "2026-10-29T10:00:00", [line(1, 111, 2, 199999.5, { cancelled_qty: 2 }), line(2, 222, 1, 50000, { cancelled_qty: 1 })], "2026-10-30T15:30:00"));
  await enqueueProductAnalyticsJob(db, { shopId: A, syncType: "product_sales_facts_read", strategy: "hot", now: clock });
  await drain([A], readerA);
  const l1 = (await facts(A)).find((f) => f.provider_line_item_id === "1")!;
  assert.equal(l1.order_status, "CANCELLED");
  assert.equal(l1.is_valid_for_sales, false);
  // a late / replayed OLD payload (SHIPPED, older update_time) is skipped
  const old = mapOrderToSalesFacts(ord("A-001", "SHIPPED", "2026-10-29T10:00:00", [line(1, 111, 2, 199999.5), line(2, 222, 1, 50000)], "2026-10-29T10:05:00"));
  assert.ok("rows" in old);
  const r = await upsertProductSalesFacts(db, A, old.rows);
  assert.deepEqual([r.inserted, r.updated, r.skippedStale], [0, 0, 2]);
  assert.equal((await facts(A)).find((f) => f.provider_line_item_id === "1")!.order_status, "CANCELLED");
});

test("PA2 / §14 §15 §67. daily metrics in NUMERIC: distinct orders, Σ units, Σ GMV exact (0.1 + 0.2 = 0.3; 3 × 33333.33)", async () => {
  const { data } = await db.from("shopee_product_daily_metrics").select("*").eq("shop_id", A).order("report_date").order("provider_item_id");
  const byKey = new Map((data ?? []).map((r) => [`${r.provider_item_id}|${r.report_date}`, r]));
  const d28 = byKey.get("111|2026-10-28")!;
  assert.equal(Number(d28.orders), 1);
  assert.equal(Number(d28.units_sold), 3, "free gift line not counted");
  assert.equal(String(d28.sales_gmv), "99999.99");
  const { data: sum } = await db.rpc("pa_sales_window", { p_shop_id: A, p_item_id: "333", p_from: "2026-10-27", p_to: "2026-10-28" });
  assert.equal(String(sum![0].gmv), "0.3", "NUMERIC sum: exactly 0.3 (a JS float sum would give 0.30000000000000004)");
  assert.notEqual(0.1 + 0.2, 0.3, "control: JS floats are not exact");
  assert.equal(Number(sum![0].orders), 2);
  const d29 = byKey.get("111|2026-10-29")!;
  assert.equal(Number(d29.orders), 0, "both orders of 29/10 cancelled");
  assert.equal(Number(d29.cancelled_orders), 2);
});

test("PA2 / §23 §24 §25 §48 §49 §68. identity for Ads + non-Ads products; Ads join = same shop + single-item campaigns only", async () => {
  // Ads in A: single-item campaign (111), shared (111 + 222), single-item for an item with NO sales (444); B: single-item for 111
  const camp = async (shopId: string, pid: string, items: string[], expense: number, gmv: number) => {
    const { data, error } = await db.from("shopee_ads_campaigns").insert({ shop_id: shopId, provider_campaign_id: pid, campaign_name: `c${pid}`, provider_status: "ongoing", last_synced_at: clock.toISOString() }).select("id").single();
    if (error) throw error;
    for (const i of items) await db.from("shopee_ads_campaign_products").insert({ shop_id: shopId, campaign_id: data.id, provider_item_id: i });
    for (const d of ["2026-10-27", "2026-10-28", "2026-10-29"]) {
      const { error: e } = await db.from("shopee_ads_campaign_daily_performance").insert({ shop_id: shopId, campaign_id: data.id, report_date: d, expense, impression: 1000, clicks: 40, direct_order: 1, broad_order: 2, direct_gmv: gmv / 2, broad_gmv: gmv, direct_item_sold: 1, broad_item_sold: 2, last_synced_at: clock.toISOString() });
      if (e) throw e;
    }
    return data.id as string;
  };
  await camp(A, "9001", ["111"], 100000, 300000);
  await camp(A, "9002", ["111", "222"], 999999, 999999);
  await camp(A, "9003", ["444"], 50000, 0);
  await camp(B, "9101", ["111"], 777777, 777777);
  await db.from("shopee_ads_products").insert({ shop_id: A, provider_item_id: "111", product_name: "Thảm lông xù (Ads)", item_sku: "TLX", provider_status: "NORMAL", enrichment_status: "enriched", last_enriched_at: clock.toISOString(), last_checked_at: clock.toISOString() });

  const { data: prods } = await db.from("shopee_products").select("provider_item_id, name, metadata_source, first_seen_source").eq("shop_id", A).order("provider_item_id");
  assert.deepEqual(prods!.map((p) => p.provider_item_id), ["111", "222", "333", "444"], "orders-only (333) and Ads-only (444) products both have identity");
  const p111 = prods!.find((p) => p.provider_item_id === "111")!;
  assert.equal(p111.name, "Thảm lông xù (Ads)", "Ads enrichment (current) wins over the order-line name");
  assert.equal(p111.metadata_source, "ads_enrichment");
  assert.equal(prods!.find((p) => p.provider_item_id === "333")!.metadata_source, "order_line");

  const period = { preset: "custom" as const, from: "2026-10-27", to: "2026-10-29", prevFrom: "2026-10-24", prevTo: "2026-10-26", partialToday: false, hourCutoff: null };
  const { data: s } = await db.rpc("product_analytics_summary", { p_shop_id: A, p_item_id: "111", p_from: period.from, p_to: period.to, p_prev_from: period.prevFrom, p_prev_to: period.prevTo, p_hour_cutoff: null });
  assert.equal(Number(s.ads.spend.current), 300000, "only the single-item campaign; never B's same item id, never the shared one");
  assert.equal(s.ads.shared_campaigns_excluded, 1);
  assert.equal(Number(s.ads.broad_roas.current), 3);
  assert.equal(Number(s.ads.cpc.current), 2500, "true CPC = Σ spend / Σ clicks");
  assert.equal(Number(s.ads.ctr.current), 0.04);
  assert.equal(s.ads.organic_gmv, undefined);

  const list = await loadProductList(db, [A], period);
  const ids = list.map((r) => r.item_id).sort();
  assert.deepEqual(ids, ["111", "222", "333", "444"]);
  const r444 = list.find((r) => r.item_id === "444")!;
  assert.equal(r444.gmv, 0, "Ads product without sales facts is listed (zero), not hidden");
  assert.equal(r444.campaigns, 1);
  const r333 = list.find((r) => r.item_id === "333")!;
  assert.equal(r333.campaigns, 0, "non-Ads product listed with its sales");
  const all = await loadProductList(db, [A, B], period);
  assert.equal(all.filter((r) => r.item_id === "111").length, 2, "same item id in two shops = two products (never merged)");
  assert.equal(all.find((r) => r.item_id === "111" && r.shop_id === B)!.spend, 777777 * 3);
});

test("PA2 / §29 §30 §35 §41. summary: previous period deltas in SQL; today same-time cut at the completed hour", async () => {
  const today = resolveProductPeriod({ preset: "today" }, new Date("2026-10-30T03:30:00Z")); // 10:30 VN → cutoff 10
  assert.equal(today.hourCutoff, 10);
  ordersA.set("A-007", ord("A-007", "SHIPPED", "2026-10-30T09:15:00", [line(10, 111, 1, 1000)]));
  ordersA.set("A-008", ord("A-008", "SHIPPED", "2026-10-29T09:45:00", [line(11, 111, 2, 1000)]));
  ordersA.set("A-009", ord("A-009", "SHIPPED", "2026-10-29T14:00:00", [line(12, 111, 7, 1000)]));
  await enqueueProductAnalyticsJob(db, { shopId: A, syncType: "product_sales_facts_read", strategy: "manual", now: clock });
  await drain([A], readerA);
  const { data: s } = await db.rpc("product_analytics_summary", { p_shop_id: A, p_item_id: "111", p_from: today.from, p_to: today.to, p_prev_from: today.prevFrom, p_prev_to: today.prevTo, p_hour_cutoff: today.hourCutoff });
  assert.equal(Number(s.sales.units.current), 1);
  assert.equal(Number(s.sales.units.previous), 2, "yesterday only up to 10:00 (14:00 order excluded)");
  assert.equal(Number(s.sales.units.pct), -50);
  assert.equal(Number(s.sales.gmv.abs), -1000);
});

test("PA2 / §63. checkpoint / resume: a 1-call-per-slice budget finishes over many slices with the same result", async () => {
  const C = await newShop(3);
  const orders = new Map<string, Record<string, unknown>>();
  for (let i = 1; i <= 7; i++) orders.set(`C-${i}`, ord(`C-${i}`, "COMPLETED", `2026-10-2${i % 9}T10:00:00`, [line(i, 500 + i, 1, 1000)]));
  const reader = new FixtureProductSalesReader({ orders, pageSize: 2 });
  CONFIG = { ...CONFIG, callsPerSlice: 1 };
  await enqueueProductAnalyticsJob(db, { shopId: C, syncType: "product_sales_facts_read", strategy: "backfill", now: clock });
  const slices = await drain([C], reader);
  CONFIG = { ...CONFIG, callsPerSlice: 20 };
  assert.ok(slices.length > 5, `resumed over ${slices.length} slices`);
  assert.ok(slices.slice(0, -1).every((s) => s.status === "pending"), "continuation, never retry / failed");
  assert.equal(slices.at(-1)!.status, "success");
  assert.equal((await facts(C)).length, 7);
});

test("PA2 / §26 §27 §34. extra info = snapshot only (no daily fact, no period delta); retention bounded", async () => {
  await db.from("shopee_product_extra_snapshots").insert({ shop_id: A, provider_item_id: "111", captured_at: "2026-07-01T00:00:00Z", sale: 1, views: 1 });
  await enqueueProductAnalyticsJob(db, { shopId: A, syncType: "product_extra_info_read", strategy: "extra", now: clock });
  await drain([A], readerA);
  const { data: snaps } = await db.from("shopee_product_extra_snapshots").select("provider_item_id, sale, views, captured_at").eq("shop_id", A);
  assert.deepEqual(snaps!.map((x) => [x.provider_item_id, Number(x.sale), Number(x.views)]), [["111", 270508, 13892]], "90-day retention removed the July snapshot");
  const { data: s } = await db.rpc("product_analytics_summary", { p_shop_id: A, p_item_id: "111", p_from: "2026-10-27", p_to: "2026-10-29", p_prev_from: "2026-10-24", p_prev_to: "2026-10-26", p_hour_cutoff: null });
  assert.deepEqual(Object.keys(s.snapshot).sort(), ["captured_at", "comment_count", "likes", "rating_star", "sale", "views"], "current values only — no delta / previous");
  const { data: daily } = await db.from("shopee_product_daily_metrics").select("*").eq("shop_id", A).limit(1);
  assert.ok(!Object.keys(daily![0]).some((k) => /views|sale$/.test(k)), "views / sale never become daily facts");
});

test("PA2 / §52 §53 §58 §70. agent tools: backend authorization, compact payload, no raw rows / PII / SQL", async () => {
  const mk = async (name: string, role: string) => {
    const { data, error } = await db.auth.admin.createUser({ email: `pa2+${TAG}-${name}@example.test`, password: `Pw-${TAG}-x!`, email_confirm: true, app_metadata: { provisioned_by_admin: true } });
    if (error) throw error;
    users.push(data.user.id);
    await db.from("profiles").update({ role, is_active: true }).eq("id", data.user.id);
    return data.user.id;
  };
  const admin = await mk("admin", "admin");
  const staff = await mk("staff", "staff");
  await db.from("ai_user_shop_access").insert([{ internal_user_id: admin, shop_id: A }, { internal_user_id: staff, shop_id: A }]);
  const { data: p } = await db.from("shopee_products").select("id").eq("shop_id", A).eq("provider_item_id", "111").single();
  const { data: pB } = await db.from("shopee_products").select("id").eq("shop_id", B).eq("provider_item_id", "111").single();
  const scope = { internal_user_id: admin, shop_id: A, product_id: p!.id };
  const period = { period: { from: "2026-10-27", to: "2026-10-29" } };

  const calls0 = readerA.calls.length;
  const outs = [
    await get_product_overview(db, scope, period, clock),
    await compare_product_periods(db, scope, period, clock),
    await get_product_sales_summary(db, scope, period, clock),
    await get_product_ads_performance(db, scope, period, clock),
    await get_product_baseline(db, scope, { days: 28 }, clock),
    await get_product_signals(db, scope, period, clock),
  ];
  assert.equal(readerA.calls.length, calls0, "tools read the DB only");
  for (const o of outs) {
    const text = JSON.stringify(o);
    // PA-3: typical product analysis context < 8 KB (each tool well below)
    assert.ok(text.length < 6000, `${o.tool}: compact (${text.length} bytes)`);
    // (the explicit negative warning "… NOT the part of sales caused by Ads … NOT organic" is the only allowed mention)
    const withoutWarning = JSON.stringify({ ...o, attribution_warning: undefined });
    assert.ok(!/organic|contribution|caused by|root_cause/i.test(withoutWarning), `${o.tool}: no causal / organic wording`);
    assert.ok(!/provider_order_id|line_item_id|0901234567|recipient|buyer|message_to_seller/.test(text), `${o.tool}: no raw order rows / PII`);
    assert.ok(!/\bselect\b.*\bfrom\b|insert into|execute_sql/i.test(text), `${o.tool}: no SQL text`);
    // 2P: every tool carries freshness / backfill state and source + confidence per metric
    assert.ok("data_quality" in o && "metric_meta" in o, `${o.tool}: data_quality + metric_meta present`);
  }
  assert.equal(outs[3].tool, "get_product_ads_performance");
  assert.match((outs[3] as Awaited<ReturnType<typeof get_product_ads_performance>>).attribution_warning, /NOT organic/);
  assert.ok((outs[0] as Awaited<ReturnType<typeof get_product_overview>>).metric_meta.views_snapshot.semantic_confidence === "UNKNOWN");
  assert.ok((outs[0] as Awaited<ReturnType<typeof get_product_overview>>).metric_meta.sales_gmv.semantic_confidence === "HIGH");
  // PA-3 get_product_signals: health + signals with evidence + confidence + data quality, no raw facts
  const sig = outs[5] as Awaited<ReturnType<typeof get_product_signals>>;
  assert.equal(sig.tool, "get_product_signals");
  assert.ok(sig.health.label && sig.health.rule && sig.health.confidence);
  assert.ok(Array.isArray(sig.signals) && sig.signals.every((x) => "change_pct" in x && "previous" in x && "confidence" in x));
  assert.ok(Array.isArray(sig.data_quality_signals));
  assert.ok(typeof sig.attention.score === "number");
  assert.ok(JSON.stringify(outs.slice(0, 2).concat(outs[5])).length < 8000, "overview + compare + signals together < 8 KB");

  const denied = async (s: typeof scope, code: string) => assert.rejects(() => get_product_overview(db, s, period, clock), (e: unknown) => e instanceof ProductToolAccessError && e.code === code);
  await denied({ ...scope, internal_user_id: staff }, "user_not_allowed");
  await denied({ ...scope, shop_id: B, product_id: pB!.id }, "shop_not_granted");
  await denied({ ...scope, product_id: pB!.id }, "product_not_found");
  await denied({ ...scope, product_id: "not-a-uuid" }, "invalid_scope");
});

test("PA2 / §64. page reads (list + detail) make 0 provider calls; scheduler disabled by default", async () => {
  const before = readerA.calls.length;
  const period = resolveProductPeriod({ preset: "7d" }, clock);
  await loadProductList(db, [A, B], period);
  const { data: p } = await db.from("shopee_products").select("id").eq("shop_id", A).eq("provider_item_id", "111").single();
  const ref = await resolveProductById(db, p!.id);
  const d = await loadProductDetail(db, ref!, period, clock);
  assert.ok(d && d.daily.length === 7);
  assert.equal(readerA.calls.length, before);
  const off = await runProductAnalyticsSchedulerTick(db, { config: getProductAnalyticsSyncConfig({}), now: clock });
  assert.equal(off.disabled, true);
  assert.equal(off.enqueued.length, 0);
});

test("PA2 / §20 §21. scheduler ON: slots claimed once, jobs in pa_* lanes below Ads HOT priority", async () => {
  const D = await newShop(4);
  await db.from("product_analytics_shop_settings").update({ extra_info_enabled: false }).eq("shop_id", D);
  const r1 = await runProductAnalyticsSchedulerTick(db, { config: CONFIG, now: clock });
  const mine = r1.enqueued.filter((e) => e.shopId === D).map((e) => e.kind).sort();
  assert.deepEqual(mine, ["backfill", "hot"]);
  const r2 = await runProductAnalyticsSchedulerTick(db, { config: CONFIG, now: new Date(clock.getTime() + 60_000) });
  assert.equal(r2.enqueued.filter((e) => e.shopId === D).length, 0, "same slot never scheduled twice");
  const { data: jobs } = await db.from("channel_sync_jobs").select("sync_type, lane, priority, mode").eq("shop_id", D);
  for (const j of jobs ?? []) {
    assert.equal(j.sync_type, "product_sales_facts_read");
    assert.match(j.lane, /^pa_/);
    assert.ok(j.priority > 5);
  }
  const { count } = await db.from("channel_sync_jobs").select("id", { count: "exact", head: true }).in("shop_id", shopIds).in("sync_type", ["order", "product", "escrow", "return", "income", "payout"]);
  assert.equal(count, 0, "no legacy job was ever enqueued");
});
