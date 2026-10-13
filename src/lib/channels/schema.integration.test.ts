// ============================================================
// PHASE SHOPEE-0 — schema + RLS verification for migration 00038, against
// the Supabase project in .env.local (the LOCAL Docker stack in dev):
//
//   node --env-file=.env.local --test src/lib/channels/schema.integration.test.ts
//
// Data cases use the service-role client (the server path). RLS cases use
// REAL user sessions (anon key + user JWT, exactly what a browser could
// send to PostgREST). Everything created is tagged with TAG and removed in
// `after`: shops (cascade to all channel data), the test product, users.
// Admin-JWT cases only run when a real active admin already exists (the
// last-active-admin guard would otherwise block deleting the test admin).
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { hasPermission } from "../auth/permissions.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) {
  throw new Error("Thiếu biến môi trường Supabase. Chạy với `node --env-file=.env.local --test ...`.");
}
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const db = createClient(url, serviceKey, opts);
const anon = createClient(url, anonKey, opts);

const TAG = `shopee0-${Date.now()}`;
const PASSWORD = `T3st-${TAG}-pw!`;
const createdUsers: string[] = [];
const users: Record<string, { id: string; client: SupabaseClient }> = {};
let realAdminExists = false;
let productId = "";
let shopA = "";
let shopB = "";

async function makeUser(name: string, role: "admin" | "staff" | "viewer") {
  const email = `authtest+${TAG}-${name}@example.com`;
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  createdUsers.push(data.user.id);
  const { error: e } = await db.from("profiles").update({ role, is_active: true }).eq("id", data.user.id);
  if (e) throw e;
  const client = createClient(url!, anonKey!, opts);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw signInError;
  users[name] = { id: data.user.id, client };
}

async function insertShop(externalShopId: string, name = "Test shop"): Promise<string> {
  const { data, error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: externalShopId, shop_name: name, currency: "VND", region: "VN" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function insertOrder(shopId: string, orderSn: string): Promise<string> {
  const { data, error } = await db
    .from("channel_orders")
    .insert({ shop_id: shopId, external_order_sn: orderSn, order_status: "READY_TO_SHIP", currency: "VND" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

before(async () => {
  const { count } = await db
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin")
    .eq("is_active", true);
  realAdminExists = (count ?? 0) > 0;

  const { data: supplier, error: supplierError } = await db.from("suppliers").select("id").limit(1).single();
  if (supplierError) throw supplierError;
  const { data: product, error: productError } = await db
    .from("products")
    .insert({ sku: `${TAG}-sku`, name: "SHOPEE-0 test product", unit: "chiec", current_price: 1, supplier_id: supplier.id })
    .select("id")
    .single();
  if (productError) throw productError;
  productId = product.id;

  shopA = await insertShop(`${TAG}-A`, "Shop A");
  shopB = await insertShop(`${TAG}-B`, "Shop B");

  await makeUser("viewer", "viewer");
  await makeUser("staff", "staff");
  if (realAdminExists) await makeUser("admin", "admin");
});

after(async () => {
  await db.from("shops").delete().like("external_shop_id", `${TAG}-%`);
  await db.from("products").delete().eq("id", productId);
  for (const id of createdUsers) await db.auth.admin.deleteUser(id);
});

// ---------- Multi-shop uniqueness ----------

test("1. two shops on the same channel with different external_shop_id", async () => {
  const { data } = await db.from("shops").select("id").in("id", [shopA, shopB]);
  assert.equal(data!.length, 2);
});

test("2. duplicate channel + external_shop_id is rejected", async () => {
  const { error } = await db
    .from("shops")
    .insert({ channel: "shopee", external_shop_id: `${TAG}-A`, shop_name: "Shop A (dup)" });
  assert.equal(error?.code, "23505");
});

test("2b. unknown channel is rejected by CHECK", async () => {
  const { error } = await db.from("shops").insert({ channel: "lazada", external_shop_id: `${TAG}-L`, shop_name: "x" });
  assert.equal(error?.code, "23514");
});

test("3 + 4. same order_sn allowed across shops, rejected within one shop", async () => {
  await insertOrder(shopA, "2410ORDERSN01");
  await insertOrder(shopB, "2410ORDERSN01");
  const { error } = await db
    .from("channel_orders")
    .insert({ shop_id: shopA, external_order_sn: "2410ORDERSN01", order_status: "COMPLETED", currency: "VND" });
  assert.equal(error?.code, "23505");
});

test("4b. financial_status is CHECKed, order_status is free text", async () => {
  const { error: bad } = await db.from("channel_orders").insert({
    shop_id: shopA, external_order_sn: `${TAG}-fs`, order_status: "ANY_NEW_SHOPEE_STATUS", currency: "VND",
    financial_status: "paid",
  });
  assert.equal(bad?.code, "23514");
  const { data, error } = await db
    .from("channel_orders")
    .insert({ shop_id: shopA, external_order_sn: `${TAG}-fs2`, order_status: "ANY_NEW_SHOPEE_STATUS", currency: "VND" })
    .select("financial_status")
    .single();
  assert.equal(error, null);
  assert.equal(data!.financial_status, "pending");
});

test("5 + 6. same item_id allowed across shops, rejected within one shop", async () => {
  const row = { external_item_id: "99887766554433", item_name: "Thảm" };
  assert.equal((await db.from("channel_products").insert({ ...row, shop_id: shopA })).error, null);
  assert.equal((await db.from("channel_products").insert({ ...row, shop_id: shopB })).error, null);
  const { error } = await db.from("channel_products").insert({ ...row, shop_id: shopA });
  assert.equal(error?.code, "23505");
});

// ---------- Product mapping ----------

test("7 + 8. model maps to an internal product; deleting the product nulls the mapping, keeps the model", async () => {
  const { data: item } = await db
    .from("channel_products")
    .insert({ shop_id: shopA, external_item_id: `${TAG}-map`, item_name: "Map test", has_model: true })
    .select("id")
    .single();

  // Mapped status without a product is rejected.
  const { error: lie } = await db.from("channel_product_models").insert({
    channel_product_id: item!.id, external_model_id: "m0", mapping_status: "manual_mapped",
  });
  assert.equal(lie?.code, "23514");

  const { data: model, error } = await db
    .from("channel_product_models")
    .insert({
      channel_product_id: item!.id, external_model_id: "m1", model_sku: `${TAG}-sku`,
      internal_product_id: productId, mapping_status: "manual_mapped", mapped_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  assert.equal(error, null);

  const { data: joined } = await db
    .from("channel_product_models")
    .select("internal_product_id, products(sku)")
    .eq("id", model!.id)
    .single();
  assert.equal(joined!.internal_product_id, productId);

  // Use a dedicated product so the shared test product survives for later cases.
  const { data: supplier } = await db.from("suppliers").select("id").limit(1).single();
  const { data: temp } = await db
    .from("products")
    .insert({ sku: `${TAG}-tmp`, name: "tmp", unit: "chiec", supplier_id: supplier!.id })
    .select("id")
    .single();
  await db.from("channel_product_models").update({ internal_product_id: temp!.id }).eq("id", model!.id);

  const { error: delError } = await db.from("products").delete().eq("id", temp!.id);
  assert.equal(delError, null, "deleting a mapped product is not blocked");

  const { data: after } = await db
    .from("channel_product_models")
    .select("internal_product_id, mapping_status, mapped_at")
    .eq("id", model!.id)
    .single();
  assert.deepEqual(after, { internal_product_id: null, mapping_status: "unmapped", mapped_at: null });
});

// ---------- Cascades / one-to-one ----------

test("9. deleting a shop cascades every channel entity", async () => {
  const shopId = await insertShop(`${TAG}-C`);
  const orderId = await insertOrder(shopId, "CASCADE01");
  const { data: product } = await db
    .from("channel_products")
    .insert({ shop_id: shopId, external_item_id: "1", item_name: "x" })
    .select("id")
    .single();
  await db.from("channel_product_models").insert({ channel_product_id: product!.id, external_model_id: "1" });
  await db.from("channel_order_items").insert({ order_id: orderId, external_item_id: "1", item_name: "x", quantity: 1 });
  await db.from("order_financials").insert({ order_id: orderId });
  await db.from("order_financial_components").insert({
    order_id: orderId, component_type: "commission_fee", category: "platform_fee", amount: -1000, source: "shopee_escrow",
  });
  const { data: ret } = await db
    .from("channel_returns")
    .insert({ shop_id: shopId, order_id: orderId, external_return_sn: "R1" })
    .select("id")
    .single();
  await db.from("channel_return_items").insert({ return_id: ret!.id, external_item_id: "1", quantity: 1 });
  const { data: payout } = await db
    .from("payout_batches")
    .insert({ shop_id: shopId, from_currency: "VND", from_amount: 1, payout_currency: "VND", payout_amount: 1 })
    .select("id")
    .single();
  await db.from("payout_orders").insert({ payout_id: payout!.id, order_id: orderId, external_order_sn: "CASCADE01", escrow_amount: 1, currency: "VND" });
  await db.from("shop_connections").insert({ shop_id: shopId });
  await db.from("channel_sync_states").insert({ shop_id: shopId, sync_type: "order" });
  await db.from("channel_sync_logs").insert({ shop_id: shopId, sync_type: "order", started_at: new Date().toISOString(), status: "running" });
  await db.from("channel_api_snapshots").insert({
    shop_id: shopId, entity_type: "order", entity_external_id: "CASCADE01", api_name: "v2.order.get_order_detail", payload: { a: 1 },
  });

  const checks: Array<[string, string, string]> = [
    ["channel_orders", "shop_id", shopId],
    ["channel_products", "shop_id", shopId],
    ["channel_product_models", "channel_product_id", product!.id],
    ["channel_order_items", "order_id", orderId],
    ["order_financials", "order_id", orderId],
    ["order_financial_components", "order_id", orderId],
    ["channel_returns", "shop_id", shopId],
    ["channel_return_items", "return_id", ret!.id],
    ["payout_batches", "shop_id", shopId],
    ["payout_orders", "payout_id", payout!.id],
    ["shop_connections", "shop_id", shopId],
    ["channel_sync_states", "shop_id", shopId],
    ["channel_sync_logs", "shop_id", shopId],
    ["channel_api_snapshots", "shop_id", shopId],
  ];
  // Every fixture insert above really landed (otherwise "0 after delete" proves nothing).
  for (const [table, column, value] of checks) {
    const { count } = await db.from(table).select("id", { count: "exact", head: true }).eq(column, value);
    assert.equal(count, 1, `fixture ${table}`);
  }

  const { error } = await db.from("shops").delete().eq("id", shopId);
  assert.equal(error, null);

  for (const [table, column, value] of checks) {
    const { count } = await db.from(table).select("id", { count: "exact", head: true }).eq(column, value);
    assert.equal(count, 0, table);
  }
});

test("10. exactly one order_financials row per order", async () => {
  const orderId = await insertOrder(shopA, `${TAG}-fin`);
  assert.equal((await db.from("order_financials").insert({ order_id: orderId })).error, null);
  const { error } = await db.from("order_financials").insert({ order_id: orderId });
  assert.equal(error?.code, "23505");
});

test("11. return is linked to its order, and only to an order of the SAME shop", async () => {
  const orderId = await insertOrder(shopA, `${TAG}-ret`);
  const { data, error } = await db
    .from("channel_returns")
    .insert({ shop_id: shopA, order_id: orderId, external_return_sn: `${TAG}-R`, refund_amount: 150000.5, currency: "VND" })
    .select("id, channel_orders(external_order_sn)")
    .single();
  assert.equal(error, null);
  assert.deepEqual(data!.channel_orders, { external_order_sn: `${TAG}-ret` });

  const { error: crossShop } = await db
    .from("channel_returns")
    .insert({ shop_id: shopB, order_id: orderId, external_return_sn: `${TAG}-R2` });
  assert.equal(crossShop?.code, "23503", "return of shop B cannot point at shop A's order");
});

test("12. one payout links multiple orders (and unknown orders by order_sn only)", async () => {
  const o1 = await insertOrder(shopA, `${TAG}-p1`);
  const o2 = await insertOrder(shopA, `${TAG}-p2`);
  const { data: payout } = await db
    .from("payout_batches")
    .insert({ shop_id: shopA, from_currency: "VND", from_amount: 300000, payout_currency: "VND", payout_amount: 300000 })
    .select("id")
    .single();
  const { error } = await db.from("payout_orders").insert([
    { payout_id: payout!.id, order_id: o1, external_order_sn: `${TAG}-p1`, escrow_amount: 100000, currency: "VND" },
    { payout_id: payout!.id, order_id: o2, external_order_sn: `${TAG}-p2`, escrow_amount: 150000, currency: "VND" },
    { payout_id: payout!.id, order_id: null, external_order_sn: "NOT_SYNCED_YET", escrow_amount: 50000, currency: "VND" },
  ]);
  assert.equal(error, null);
  const { count } = await db.from("payout_orders").select("id", { count: "exact", head: true }).eq("payout_id", payout!.id);
  assert.equal(count, 3);
});

test("13. sync state is unique per shop + sync_type", async () => {
  assert.equal((await db.from("channel_sync_states").insert({ shop_id: shopA, sync_type: "order" })).error, null);
  assert.equal((await db.from("channel_sync_states").insert({ shop_id: shopB, sync_type: "order" })).error, null);
  const { error } = await db.from("channel_sync_states").insert({ shop_id: shopA, sync_type: "order" });
  assert.equal(error?.code, "23505");
});

test("14. money / quantity columns keep exact decimals", async () => {
  const { data: item } = await db
    .from("channel_products")
    .insert({
      shop_id: shopA, external_item_id: `${TAG}-dec`, item_name: "dec",
      channel_current_price: "9999999999999999.99", available_stock: "12.3456",
    })
    .select("channel_current_price::text, available_stock::text")
    .single();
  assert.deepEqual(item, { channel_current_price: "9999999999999999.99", available_stock: "12.3456" });

  const orderId = await insertOrder(shopA, `${TAG}-dec`);
  const { data: fin } = await db
    .from("order_financials")
    .insert({ order_id: orderId, commission_fee: "0.1", service_fee: "0.2", estimated_margin: "0.1234" })
    .select("commission_fee::text, service_fee::text, estimated_margin::text")
    .single();
  assert.deepEqual(fin, { commission_fee: "0.10", service_fee: "0.20", estimated_margin: "0.1234" });

  const { data: comp } = await db
    .from("order_financial_components")
    .insert([
      { order_id: orderId, component_type: "a", category: "platform_fee", amount: "-0.1", source: "manual" },
      { order_id: orderId, component_type: "b", category: "platform_fee", amount: "-0.2", source: "manual" },
    ])
    .select("amount::text");
  assert.deepEqual(comp!.map((c) => c.amount).sort(), ["-0.10", "-0.20"]);
});

// ---------- RLS / privileges ----------

test("15. RLS baseline: active users read business data, never raw snapshots; anon reads nothing", async () => {
  await db.from("channel_api_snapshots").insert({
    shop_id: shopA, entity_type: "order", entity_external_id: "X", api_name: "v2.order.get_order_detail", payload: { buyer: "pii" },
  });
  for (const name of ["viewer", "staff"]) {
    const c = users[name].client;
    const { data: shops, error } = await c.from("shops").select("id").in("id", [shopA, shopB]);
    assert.equal(error, null, name);
    assert.equal(shops!.length, 2, `${name} reads shops`);
    const { data: orders } = await c.from("channel_orders").select("id").eq("shop_id", shopA).limit(1);
    assert.equal(orders!.length, 1, `${name} reads orders`);
    const snap = await c.from("channel_api_snapshots").select("id").limit(1);
    assert.ok(snap.error, `${name}: raw snapshots denied`);
    const { data: syncStates } = await c.from("channel_sync_states").select("id").eq("shop_id", shopA);
    assert.equal(syncStates?.length ?? 0, 0, `${name}: sync states are admin-only`);
  }
  for (const rel of ["shops", "channel_orders", "order_financials", "shop_connections", "channel_api_snapshots", "channel_sync_logs"]) {
    const { data, error } = await anon.from(rel).select("id").limit(1);
    assert.ok(error || (data ?? []).length === 0, rel);
  }
});

test("16. viewer cannot mutate shops or connection tables", async () => {
  const c = users.viewer.client;
  assert.ok((await c.from("shops").insert({ channel: "shopee", external_shop_id: `${TAG}-V`, shop_name: "x" })).error);
  assert.ok((await c.from("shops").update({ shop_name: "hack" }).eq("id", shopA)).error);
  assert.ok((await c.from("shop_connections").insert({ shop_id: shopA })).error);
  assert.ok((await c.from("channel_sync_states").delete().eq("shop_id", shopA)).error);
  assert.ok((await c.from("channel_orders").update({ financial_status: "released" }).eq("shop_id", shopA)).error);
  assert.equal(hasPermission("viewer", "channel:manage"), false);
});

test("17. staff cannot read or modify tokens / connections", async () => {
  await db.from("shop_connections").insert({
    shop_id: shopA, connection_status: "connected", access_token_encrypted: "enc:access", refresh_token_encrypted: "enc:refresh",
  });
  const c = users.staff.client;
  const tokenRead = await c.from("shop_connections").select("access_token_encrypted").limit(1);
  assert.ok(tokenRead.error, "token column not readable");
  const { data: status } = await c.from("shop_connections").select("connection_status").eq("shop_id", shopA);
  assert.equal(status?.length ?? 0, 0, "connection rows are admin-only");
  assert.ok((await c.from("shop_connections").update({ access_token_encrypted: "x" }).eq("shop_id", shopA)).error);
  assert.equal(hasPermission("staff", "channel:manage"), false);
  assert.equal(hasPermission("staff", "channel:view"), true);

  const { data: still } = await db.from("shop_connections").select("access_token_encrypted").eq("shop_id", shopA).single();
  assert.equal(still!.access_token_encrypted, "enc:access");
});

test("18. admin manages shop config through the server path; tokens stay hidden even from an admin JWT", async (t) => {
  assert.equal(hasPermission("admin", "channel:manage"), true);
  // Server path (service-role, after the app's channel:manage check).
  const { error: updError } = await db.from("shops").update({ shop_name: "Shop A renamed", is_active: false }).eq("id", shopA);
  assert.equal(updError, null);
  const { error: connError } = await db
    .from("shop_connections")
    .update({ connection_status: "revoked" })
    .eq("shop_id", shopA);
  assert.equal(connError, null);

  if (!realAdminExists) return t.skip("no real active admin yet (run npm run auth:create-admin)");
  const c = users.admin.client;
  const { data: status, error } = await c.from("shop_connections").select("connection_status").eq("shop_id", shopA).single();
  assert.equal(error, null);
  assert.equal(status!.connection_status, "revoked");
  assert.ok((await c.from("shop_connections").select("refresh_token_encrypted").limit(1)).error, "admin JWT: token hidden");
  assert.ok((await c.from("shop_connections").select("*").limit(1)).error, "select * would include tokens => denied");
  const { data: logs, error: logsError } = await c.from("channel_sync_states").select("id").eq("shop_id", shopA);
  assert.equal(logsError, null);
  assert.equal(logs!.length, 1, "admin reads sync states");
  assert.ok((await c.from("shops").update({ shop_name: "x" }).eq("id", shopA)).error, "no direct writes, even for admin");
});
