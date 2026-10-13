// ============================================================
// PRE-SHOPEE-3 — mapping history protection (migration 00041) against the
// REAL database in .env.local:
//
//   node --env-file=.env.local --test src/lib/channels/core/mapping-guard.integration.test.ts
//
// Writes go both through the app helpers AND straight to the table with the
// service-role client, proving the DB itself refuses — not just the UI.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { autoMapChannelModels, changeChannelModelMappingControlled, mapChannelModelToProduct, unmapChannelModel } from "./sku-mapping.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Chạy với `node --env-file=.env.local --test ...`.");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = `mg${Date.now()}`;
const shopIds: string[] = [];
const productIds: string[] = [];
let supplierId = "";
let userId = "";
let n = 0;

before(async () => {
  supplierId = (await db.from("suppliers").select("id").limit(1).single()).data!.id;
  userId = (await db.from("profiles").select("id").limit(1).single()).data!.id;
});

after(async () => {
  if (shopIds.length) await db.from("shops").delete().in("id", shopIds);
  if (productIds.length) await db.from("products").delete().in("id", productIds);
});

async function product(label: string) {
  const { data, error } = await db.from("products").insert({ sku: `${TAG}_${label}_${++n}`, name: label, unit: "chiec", supplier_id: supplierId }).select("id").single();
  if (error) throw error;
  productIds.push(data.id);
  return data.id as string;
}

/** Shop + listing + one sellable unit mapped to `productId`; optionally an order line resolved through it. */
async function scenario(productId: string, withOrder: boolean) {
  const { data: shop } = await db.from("shops").insert({ channel: "shopee", external_shop_id: `FIXTURE_SHOP_${TAG}_${++n}`, shop_name: "guard", data_source: "fixture" }).select("id").single();
  shopIds.push(shop!.id);
  const { data: cp } = await db.from("channel_products").insert({ shop_id: shop!.id, external_item_id: "1", item_name: "x" }).select("id").single();
  const { data: model } = await db
    .from("channel_product_models")
    .insert({ channel_product_id: cp!.id, external_model_id: "11", model_sku: "x", internal_product_id: productId, mapping_status: "manual_mapped", mapped_by: userId })
    .select("id")
    .single();
  let orderItemId: string | null = null;
  if (withOrder) {
    const { data: order } = await db.from("channel_orders").insert({ shop_id: shop!.id, external_order_sn: `SN${n}`, order_status: "COMPLETED", currency: "VND" }).select("id").single();
    const { data: item, error } = await db
      .from("channel_order_items")
      .insert({ order_id: order!.id, external_item_id: "1", external_model_id: "11", item_name: "x", quantity: 1, internal_product_id: productId, channel_model_id: model!.id })
      .select("id")
      .single();
    if (error) throw error;
    orderItemId = item!.id;
  }
  return { shopId: shop!.id as string, modelId: model!.id as string, orderItemId };
}

const modelRow = async (id: string) => (await db.from("channel_product_models").select("internal_product_id, mapping_status").eq("id", id).single()).data!;

test("unused mapping: unmap and remap are free, and every change is recorded in history", async () => {
  const a = await product("A");
  const b = await product("B");
  const s = await scenario(a, false);
  assert.deepEqual(await mapChannelModelToProduct(db, { channelModelId: s.modelId, internalProductId: b, mappedBy: userId }), { ok: true });
  assert.deepEqual(await unmapChannelModel(db, { channelModelId: s.modelId }), { ok: true });
  const { data: history } = await db.from("channel_model_mapping_history").select("change_kind, old_internal_product_id, new_internal_product_id").eq("channel_model_id", s.modelId).order("changed_at");
  assert.deepEqual(history!.map((h) => h.change_kind), ["remap", "unmap"]);
  assert.equal(history![0].old_internal_product_id, a);
  assert.equal(history![0].new_internal_product_id, b);
});

test("used by an order: unmap is refused (app helper AND direct table write) — CM001", async () => {
  const a = await product("A");
  const s = await scenario(a, true);
  const viaApp = await unmapChannelModel(db, { channelModelId: s.modelId });
  assert.equal(viaApp.ok, false);
  assert.equal(!viaApp.ok && viaApp.code, "used_by_orders_unmap");

  const direct = await db.from("channel_product_models").update({ internal_product_id: null, mapping_status: "unmapped" }).eq("id", s.modelId);
  assert.equal(direct.error?.code, "CM001", "database refuses even the service role");
  assert.deepEqual(await modelRow(s.modelId), { internal_product_id: a, mapping_status: "manual_mapped" });
});

test("used by an order: silent remap refused — CM002; deleting the mapped product refused", async () => {
  const a = await product("A");
  const b = await product("B");
  const s = await scenario(a, true);
  const viaApp = await mapChannelModelToProduct(db, { channelModelId: s.modelId, internalProductId: b, mappedBy: userId });
  assert.equal(!viaApp.ok && viaApp.code, "used_by_orders_remap");
  const direct = await db.from("channel_product_models").update({ internal_product_id: b }).eq("id", s.modelId);
  assert.equal(direct.error?.code, "CM002");
  assert.equal((await modelRow(s.modelId)).internal_product_id, a);

  const del = await db.from("products").delete().eq("id", a);
  assert.ok(del.error, "product referenced by order history cannot be deleted");
  assert.ok((await db.from("products").select("id").eq("id", a).maybeSingle()).data, "product still there");
});

test("controlled remap: needs product + reason; future mapping changes, order history keeps its snapshot; audited", async () => {
  const a = await product("A");
  const b = await product("B");
  const s = await scenario(a, true);

  const noReason = await changeChannelModelMappingControlled(db, { channelModelId: s.modelId, internalProductId: b, reason: "  ", changedBy: userId });
  assert.equal(!noReason.ok && noReason.code, "invalid");
  const noProduct = await db.rpc("change_channel_model_mapping", { p_channel_model_id: s.modelId, p_internal_product_id: null, p_reason: "nhập nhầm SKU", p_changed_by: userId });
  assert.equal(noProduct.error?.code, "CM003", "controlled flow can never unmap");
  const missing = await changeChannelModelMappingControlled(db, { channelModelId: s.modelId, internalProductId: "00000000-0000-0000-0000-000000000000", reason: "nhập nhầm SKU", changedBy: userId });
  assert.equal(!missing.ok && missing.code, "not_found");
  assert.equal((await modelRow(s.modelId)).internal_product_id, a, "failed attempts change nothing");

  const ok = await changeChannelModelMappingControlled(db, { channelModelId: s.modelId, internalProductId: b, reason: "Shopee đổi SKU, ghép nhầm ban đầu", changedBy: userId });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(await modelRow(s.modelId), { internal_product_id: b, mapping_status: "manual_mapped" });

  const { data: orderItem } = await db.from("channel_order_items").select("internal_product_id").eq("id", s.orderItemId!).single();
  assert.equal(orderItem!.internal_product_id, a, "historical order line still points at the product it was resolved to");

  const { data: history } = await db.from("channel_model_mapping_history").select("*").eq("channel_model_id", s.modelId).eq("change_kind", "controlled_remap");
  assert.equal(history!.length, 1);
  assert.deepEqual(
    [history![0].old_internal_product_id, history![0].new_internal_product_id, history![0].reason, history![0].changed_by, history![0].order_items_at_change],
    [a, b, "Shopee đổi SKU, ghép nhầm ban đầu", userId, 1],
  );

  // The controlled marker is transaction-local: a later plain write is guarded again.
  const after = await db.from("channel_product_models").update({ internal_product_id: a }).eq("id", s.modelId);
  assert.equal(after.error?.code, "CM002");
});

test("auto-map never touches a used mapping; deleting the whole shop still cascades cleanly", async () => {
  const a = await product("A");
  const s = await scenario(a, true);
  await autoMapChannelModels(db, s.shopId);
  assert.equal((await modelRow(s.modelId)).internal_product_id, a);

  const { error } = await db.from("shops").delete().eq("id", s.shopId);
  assert.equal(error, null, "shop delete cascades orders + units in one statement");
  shopIds.splice(shopIds.indexOf(s.shopId), 1);
  assert.equal((await db.from("channel_product_models").select("id").eq("id", s.modelId).maybeSingle()).data, null);
});
