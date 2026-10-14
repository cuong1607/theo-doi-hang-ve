// ============================================================
// PATCH auto-map — database-only, set-based SKU auto-mapping against the
// REAL database in .env.local, at production catalog size:
//
//   node --env-file=.env.local --test src/lib/channels/core/auto-map.integration.test.ts
//
// Production shape (2026-10-14): 184 listings, 5,938 models, ~all unmapped.
// The old implementation failed there with "URI too long". Everything this
// file creates is deleted in `after`.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { autoMapChannelModels, normalizeSku, refreshMappingReviewFlags } from "./sku-mapping.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");

// Every HTTP request of this file is recorded: auto-map may only talk to Supabase.
const requestedHosts = new Set<string>();
const realFetch = globalThis.fetch;
const spyFetch: typeof fetch = (input, init) => {
  requestedHosts.add(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host);
  return realFetch(input, init);
};
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: spyFetch } });

const TAG = `am${Date.now()}`;
const shopIds: string[] = [];
const productIds: string[] = [];
let supplierId = "";
let userId = "";

before(async () => {
  supplierId = (await db.from("suppliers").select("id").limit(1).single()).data!.id;
  userId = (await db.from("profiles").select("id").limit(1).single()).data!.id;
});

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
  if (productIds.length) await db.from("products").delete().in("id", productIds);
});

async function product(sku: string, active = true): Promise<string> {
  const { data, error } = await db.from("products").insert({ sku, name: sku, unit: "chiec", current_price: 1000, supplier_id: supplierId, is_active: active }).select("id").single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id;
}

async function shop(): Promise<string> {
  const { data, error } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${shopIds.length}`, shop_name: "automap", currency: "VND", data_source: "fixture" }).select("id").single();
  if (error) throw error;
  shopIds.push(data.id);
  return data.id;
}

const statusOf = async (id: string) => (await db.from("channel_product_models").select("mapping_status, internal_product_id, mapped_at").eq("id", id).single()).data!;

test("production-size catalog (184 listings × 32 models): exact / none / conflict / synthetic; manual + existing mappings untouched; only Supabase contacted", async () => {
  const s = await shop();
  const pA = await product(`${TAG}_sku_a`);
  const pB = await product(`${TAG}_SKU_B`);
  await product(`${TAG}_dup`);
  await product(`${TAG}_DUP`); // normalized duplicate → conflict
  await product(`${TAG}_inactive`, false);
  const pManual = await product(`${TAG}_manual_target`);

  const { data: cps, error } = await db
    .from("channel_products")
    .insert(Array.from({ length: 184 }, (_, i) => ({ shop_id: s, external_item_id: `${i}`, item_name: `I${i}`, has_model: i !== 183, item_sku: i === 183 ? `  ${TAG}_SKU_A  ` : null })))
    .select("id, external_item_id");
  if (error) throw error;
  const byItem = new Map(cps!.map((c) => [c.external_item_id, c.id]));
  const models: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 183; i++) for (let m = 0; m < 32; m++) models.push({ channel_product_id: byItem.get(`${i}`), external_model_id: `${m}`, is_synthetic: false, model_sku: `NOMATCH-${i}-${m}` });
  // targeted rows on item 0
  models[0].model_sku = ` ${TAG}_SKU_A `; // exact after trim + lower → pA
  models[1].model_sku = `${TAG}_sku_b`; // case-insensitive → pB
  models[2].model_sku = `${TAG}_dup`; // two active products normalize equal → conflict
  models[3].model_sku = `${TAG}_inactive`; // only an inactive product → unmapped
  models[4].model_sku = `${TAG}_sku_a`; // will be MANUAL to another product → untouched
  models[5].model_sku = null; // blank → unmapped
  models.push({ channel_product_id: byItem.get("183"), external_model_id: "NO_MODEL", is_synthetic: true, model_sku: null }); // synthetic uses item_sku
  for (let i = 0; i < models.length; i += 1000) {
    const { error: e } = await db.from("channel_product_models").insert(models.slice(i, i + 1000));
    if (e) throw e;
  }
  const { data: ids } = await db.from("channel_product_models").select("id, external_model_id, channel_product_id").eq("channel_product_id", byItem.get("0")).in("external_model_id", ["0", "1", "2", "3", "4", "5"]).order("external_model_id");
  const id = (m: string) => ids!.find((r) => r.external_model_id === m)!.id;
  await db.from("channel_product_models").update({ internal_product_id: pManual, mapping_status: "manual_mapped", mapped_by: userId, mapped_at: new Date().toISOString() }).eq("id", id("4"));
  const { data: synthetic } = await db.from("channel_product_models").select("id").eq("channel_product_id", byItem.get("183")).single();

  requestedHosts.clear();
  const t0 = Date.now();
  const r = await autoMapChannelModels(db, s);
  const ms = Date.now() - t0;

  assert.equal(r.scanned, 5856 + 1 - 1, "every unmapped unit except the manual one");
  assert.equal(r.mapped, 3, "sku_a (trim+case), sku_b (case), synthetic via item_sku");
  assert.equal(r.conflicts, 1);
  assert.equal(r.unmapped, r.scanned - 4);
  assert.equal(r.skipped, 1, "the manual mapping");
  assert.ok(ms < 5000, `auto-map took ${ms} ms`);
  assert.deepEqual([...requestedHosts], [new URL(url).host], "no request to any host but Supabase (no Shopee API)");

  assert.equal((await statusOf(id("0"))).internal_product_id, pA);
  assert.equal((await statusOf(id("0"))).mapping_status, "auto_mapped");
  assert.ok((await statusOf(id("0"))).mapped_at);
  assert.equal((await statusOf(id("1"))).internal_product_id, pB);
  assert.deepEqual(await statusOf(id("2")), { mapping_status: "mapping_conflict", internal_product_id: null, mapped_at: null });
  assert.equal((await statusOf(id("3"))).mapping_status, "unmapped");
  assert.equal((await statusOf(id("4"))).internal_product_id, pManual, "manual mapping untouched");
  assert.equal((await statusOf(id("4"))).mapping_status, "manual_mapped");
  assert.equal((await statusOf(id("5"))).mapping_status, "unmapped");
  assert.equal((await statusOf(synthetic!.id)).internal_product_id, pA);

  // idempotent: a second run maps nothing new and rewrites nothing
  const { count: historyBefore } = await db.from("channel_model_mapping_history").select("id", { count: "exact", head: true }).in("channel_model_id", ids!.map((x) => x.id));
  const r2 = await autoMapChannelModels(db, s);
  assert.equal(r2.mapped, 0);
  assert.equal(r2.scanned, r.scanned - 3);
  const { count: historyAfter } = await db.from("channel_model_mapping_history").select("id", { count: "exact", head: true }).in("channel_model_id", ids!.map((x) => x.id));
  assert.equal(historyAfter, historyBefore, "no-op rows are not rewritten (no history noise)");
});

test("order lines: NULL snapshots of newly mapped units are filled; non-NULL history is never rewritten; other shops untouched", async () => {
  const s = await shop();
  const other = await shop();
  const pNew = await product(`${TAG}_ol_new`);
  const pOld = await product(`${TAG}_ol_old`);
  const { data: cp } = await db.from("channel_products").insert({ shop_id: s, external_item_id: "OL", item_name: "OL", has_model: true }).select("id").single();
  const { data: m } = await db.from("channel_product_models").insert({ channel_product_id: cp!.id, external_model_id: "1", model_sku: `${TAG}_ol_new` }).select("id").single();
  const { data: cpo } = await db.from("channel_products").insert({ shop_id: other, external_item_id: "OL", item_name: "OL", has_model: true }).select("id").single();
  const { data: mo } = await db.from("channel_product_models").insert({ channel_product_id: cpo!.id, external_model_id: "1", model_sku: `${TAG}_ol_new` }).select("id").single();
  const { data: order } = await db.from("channel_orders").insert({ shop_id: s, external_order_sn: `${TAG}-O1`, order_status: "UNPAID", currency: "VND" }).select("id").single();
  await db.from("channel_order_items").insert([
    { order_id: order!.id, provider_line_key: "a", external_item_id: "OL", item_name: "x", quantity: 1, channel_model_id: m!.id, internal_product_id: null },
    { order_id: order!.id, provider_line_key: "b", external_item_id: "OL", item_name: "x", quantity: 1, channel_model_id: m!.id, internal_product_id: pOld },
  ]);

  const r = await autoMapChannelModels(db, s);
  assert.equal(r.mapped, 1);
  assert.equal(r.orderLinesBackfilled, 1);
  assert.equal(r.cogsPendingOrders, 0);
  const { data: lines } = await db.from("channel_order_items").select("provider_line_key, internal_product_id").eq("order_id", order!.id).order("provider_line_key");
  assert.deepEqual(lines, [
    { provider_line_key: "a", internal_product_id: pNew },
    { provider_line_key: "b", internal_product_id: pOld },
  ]);
  assert.equal((await statusOf(mo!.id)).mapping_status, "unmapped", "other shop not touched");
});

test("review flags (set-based): auto mapping whose Shopee SKU drifted is flagged, kept, and cleared when it matches again", async () => {
  const s = await shop();
  const p = await product(`${TAG}_rv`);
  const { data: cp } = await db.from("channel_products").insert({ shop_id: s, external_item_id: "RV", item_name: "RV", has_model: true }).select("id").single();
  const { data: m } = await db.from("channel_product_models").insert({ channel_product_id: cp!.id, external_model_id: "1", model_sku: `${TAG}_rv` }).select("id").single();
  await autoMapChannelModels(db, s);
  await db.from("channel_product_models").update({ model_sku: "SOMETHING-ELSE" }).eq("id", m!.id);
  assert.equal(await refreshMappingReviewFlags(db, s), 1);
  let row = (await db.from("channel_product_models").select("mapping_review_required, internal_product_id").eq("id", m!.id).single()).data!;
  assert.deepEqual(row, { mapping_review_required: true, internal_product_id: p });
  await db.from("channel_product_models").update({ model_sku: ` ${TAG}_RV ` }).eq("id", m!.id);
  assert.equal(await refreshMappingReviewFlags(db, s), 0);
  row = (await db.from("channel_product_models").select("mapping_review_required, internal_product_id").eq("id", m!.id).single()).data!;
  assert.equal(row.mapping_review_required, false);
});

test("SQL normalize_channel_sku() and TS normalizeSku() agree", async () => {
  const samples = ["ABC", "  abc  ", "\tA-b_C\n", " sku ", "﻿X", "", "   ", "Áo Thun", "a b"];
  for (const s of samples) {
    const { data, error } = await db.rpc("normalize_channel_sku", { p_sku: s });
    assert.equal(error, null);
    assert.equal(data, normalizeSku(s), JSON.stringify(s));
  }
});
