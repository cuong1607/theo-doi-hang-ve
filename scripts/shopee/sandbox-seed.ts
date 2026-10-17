// ============================================================
// DEV TOOL — seed the Shopee SANDBOX test shop (LOCAL-LIVE-1).
//
//   npm run shopee:sandbox -- explore                 shop info, leaf categories, logistics channels
//   npm run shopee:sandbox -- attributes <categoryId> mandatory attributes of a category
//   npm run shopee:sandbox -- create --sku SKU --name "Tên" --price 120000 --stock 50 --category 123 [--logistic 5001]
//   npm run shopee:sandbox -- stock <itemId> <stock>   change stock (NOTE: does NOT bump the item's update_time →
//                                                      the incremental product sync does not see stock-only changes)
//   npm run shopee:sandbox -- rename <itemId> <name>   change the item name (bumps update_time → incremental sync refreshes it)
//   npm run shopee:sandbox -- list                    items of the sandbox shop
//   npm run shopee:sandbox -- get /api/v2/payment/get_income_overview '{"k":"v"}'
//                                                     read-only probe of any get_* API (Git Bash: MSYS_NO_PATHCONV=1)
//
// Safety (refuses to run otherwise):
//   * SHOPEE_API_BASE_URL must be a Shopee SANDBOX host (test-stable / sandbox)
//   * NEXT_PUBLIC_SUPABASE_URL must be the LOCAL database
// Uses the app's own client + connection service (token refresh on the
// LOCAL connection row only — the sandbox token is not shared with prod).
// ============================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { ShopeeClient } from "../../src/lib/channels/shopee/client.ts";
import { getShopeeConfig } from "../../src/lib/channels/shopee/config.ts";
import { signedQuery, unixSeconds } from "../../src/lib/channels/shopee/signing.ts";
import { ShopeeConnectionService } from "../../src/lib/channels/shopee/token.ts";

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

const config = getShopeeConfig();
if (!/sandbox|test-stable/i.test(config.apiBaseUrl)) fail(`SHOPEE_API_BASE_URL (${config.apiBaseUrl}) không phải host Sandbox — công cụ này chỉ ghi vào shop TEST.`);
const dbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(dbUrl)) fail("NEXT_PUBLIC_SUPABASE_URL không phải DB local.");
const db = createClient(dbUrl, process.env.SUPABASE_SERVICE_ROLE_KEY ?? fail("thiếu SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
const client = new ShopeeClient({ partnerId: config.partnerId, partnerKey: config.partnerKey, apiBaseUrl: config.apiBaseUrl });
const connections = new ShopeeConnectionService({ db, client, encryptionKey: config.encryptionKey });

type Envelope = { error?: string; message?: string; response?: Record<string, unknown>; [k: string]: unknown };

async function sandboxShop() {
  const { data, error } = await db.from("shops").select("id, external_shop_id, shop_name, data_source").eq("channel", "shopee").eq("data_source", "live");
  if (error) fail(error.message);
  if (!data || data.length !== 1) fail(`Cần đúng 1 shop Shopee live trong DB local (đang có ${data?.length ?? 0}).`);
  return data[0] as { id: string; external_shop_id: string; shop_name: string };
}

async function call(apiPath: string, method: "GET" | "POST", params: Record<string, unknown> = {}): Promise<Envelope> {
  const shop = await sandboxShop();
  const accessToken = await connections.getValidAccessToken(shop.id);
  const res = await client.request<Envelope>({
    path: apiPath,
    method,
    shop: { externalShopId: shop.external_shop_id, accessToken },
    ...(method === "GET" ? { query: params as Record<string, string | number | boolean> } : { body: params }),
  });
  return res.data;
}

/** media_space.upload_image: partner-level, multipart (the JSON client cannot send it). */
async function uploadImage(file: string): Promise<string> {
  const apiPath = "/api/v2/media_space/upload_image";
  const signed = signedQuery({ partnerId: config.partnerId, partnerKey: config.partnerKey, path: apiPath, timestamp: unixSeconds(new Date()), scope: { kind: "public" } });
  const url = new URL(`${config.apiBaseUrl}${apiPath}`);
  for (const [k, v] of Object.entries(signed)) url.searchParams.set(k, v);
  const form = new FormData();
  form.append("image", new Blob([readFileSync(file)], { type: "image/png" }), path.basename(file));
  const res = await fetch(url, { method: "POST", body: form });
  const json = (await res.json()) as { error?: string; message?: string; response?: { image_info?: { image_id?: string } } };
  const id = json.response?.image_info?.image_id;
  if (!id) fail(`upload_image lỗi: ${json.error ?? res.status} ${json.message ?? ""}`);
  return id;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "explore") {
    const shop = await sandboxShop();
    console.log("shop:", shop.shop_name, shop.external_shop_id);
    const info = await call("/api/v2/shop/get_shop_info", "GET");
    console.log("shop_info:", JSON.stringify({ shop_name: info.shop_name, region: info.region, status: info.status, error: info.error }));
    const cats = await call("/api/v2/product/get_category", "GET", { language: "vi" });
    const list = ((cats.response?.category_list as Array<{ category_id: number; display_category_name: string; has_children: boolean; parent_category_id: number }>) ?? []).filter((c) => !c.has_children);
    console.log(`leaf categories: ${list.length}; sample:`);
    for (const c of list.filter((c) => /chăn|ga|gối|nệm|bedding|bed|drap/i.test(c.display_category_name)).slice(0, 15)) console.log(`  ${c.category_id}  ${c.display_category_name} (parent ${c.parent_category_id})`);
    for (const c of list.slice(0, 5)) console.log(`  ${c.category_id}  ${c.display_category_name}`);
    const logistics = await call("/api/v2/logistics/get_channel_list", "GET");
    for (const l of (logistics.response?.logistics_channel_list as Array<{ logistics_channel_id: number; logistics_channel_name: string; enabled: boolean; mask_channel_id: number }>) ?? []) {
      console.log(`  logistic ${l.logistics_channel_id} ${l.logistics_channel_name} enabled=${l.enabled} mask=${l.mask_channel_id}`);
    }
    if (cats.error || logistics.error) console.log("errors:", cats.error, cats.message, logistics.error, logistics.message);
    return;
  }
  if (cmd === "attributes") {
    const categoryId = Number(args[0]);
    const r = await call("/api/v2/product/get_attribute_tree", "GET", { category_id_list: categoryId, language: "vi" });
    console.log(JSON.stringify(r, null, 2).slice(0, 4000));
    const brands = await call("/api/v2/product/get_brand_list", "GET", { category_id: categoryId, status: 1, offset: 0, page_size: 5, language: "vi" });
    console.log("brands:", JSON.stringify(brands.response ?? brands).slice(0, 800));
    return;
  }
  if (cmd === "create") {
    const sku = flag(args, "sku") ?? fail("thiếu --sku");
    const name = flag(args, "name") ?? fail("thiếu --name");
    const price = Number(flag(args, "price") ?? fail("thiếu --price"));
    const stock = Number(flag(args, "stock") ?? "50");
    const categoryId = Number(flag(args, "category") ?? fail("thiếu --category"));
    const logisticId = flag(args, "logistic");
    const imageId = await uploadImage(path.join(process.cwd(), "src", "app", "icon.png"));
    let logisticInfo: Array<{ logistic_id: number; enabled: boolean }>;
    if (logisticId) logisticInfo = [{ logistic_id: Number(logisticId), enabled: true }];
    else {
      const logistics = await call("/api/v2/logistics/get_channel_list", "GET");
      logisticInfo = ((logistics.response?.logistics_channel_list as Array<{ logistics_channel_id: number; enabled: boolean; mask_channel_id: number }>) ?? [])
        .filter((l) => l.enabled && l.mask_channel_id === 0)
        .slice(0, 3)
        .map((l) => ({ logistic_id: l.logistics_channel_id, enabled: true }));
    }
    const body = {
      item_name: name,
      description: `${name} — sản phẩm test LOCAL-LIVE-1 (Sandbox). Không bán thật. Dùng để kiểm tra đồng bộ sản phẩm, ghép SKU và giá vốn.`,
      original_price: price,
      seller_stock: [{ stock }],
      weight: 0.5,
      dimension: { package_length: 20, package_width: 20, package_height: 10 },
      item_sku: sku,
      category_id: categoryId,
      image: { image_id_list: [imageId] },
      logistic_info: logisticInfo,
      brand: { brand_id: 0, original_brand_name: "NoBrand" },
      condition: "NEW",
      item_status: "NORMAL",
    };
    const r = await call("/api/v2/product/add_item", "POST", body);
    console.log(JSON.stringify({ error: r.error, message: r.message, item_id: r.response?.item_id, item_sku: r.response?.item_sku }, null, 2));
    return;
  }
  if (cmd === "stock") {
    const itemId = Number(args[0]);
    const stock = Number(args[1]);
    const r = await call("/api/v2/product/update_stock", "POST", { item_id: itemId, stock_list: [{ model_id: 0, seller_stock: [{ stock }] }] });
    console.log(JSON.stringify({ error: r.error, message: r.message, response: r.response }));
    return;
  }
  if (cmd === "rename") {
    const itemId = Number(args[0]);
    const name = args.slice(1).join(" ");
    if (!itemId || !name) fail("Lệnh: rename <itemId> <tên mới>");
    const r = await call("/api/v2/product/update_item", "POST", { item_id: itemId, item_name: name });
    console.log(JSON.stringify({ error: r.error, message: r.message, item_id: r.response?.item_id, item_name: r.response?.item_name }));
    return;
  }
  if (cmd === "get") {
    // Read-only probe: npm run shopee:sandbox -- get /api/v2/payment/get_income_overview '{"k":1}'
    if (!args[0]?.startsWith("/api/v2/") || !/\/get_/.test(args[0])) fail("chỉ cho phép GET /api/v2/.../get_*");
    const params = args[1] ? (JSON.parse(args[1]) as Record<string, unknown>) : {};
    try {
      const r = await call(args[0], args[2] === "POST" ? "POST" : "GET", params);
      console.log(JSON.stringify(r, null, 2).slice(0, 8000));
    } catch (err) {
      console.log(String(err), JSON.stringify((err as { details?: unknown }).details ?? null));
    }
    return;
  }
  if (cmd === "returns") {
    const now = Math.floor(Date.now() / 1000);
    const r = await call("/api/v2/returns/get_return_list", "GET", { page_no: 0, page_size: 20, create_time_from: now - 14 * 86400, create_time_to: now });
    console.log(JSON.stringify(r, null, 2).slice(0, 6000));
    return;
  }
  if (cmd === "return") {
    const r = await call("/api/v2/returns/get_return_detail", "GET", { return_sn: args[0] });
    console.log(JSON.stringify(r, null, 2).slice(0, 8000));
    return;
  }
  if (cmd === "list") {
    const r = await call("/api/v2/product/get_item_list", "GET", { offset: 0, page_size: 50, item_status: "NORMAL" });
    console.log(JSON.stringify(r.response ?? r, null, 2));
    return;
  }
  fail("Lệnh: explore | attributes <categoryId> | create … | stock <itemId> <stock> | list");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
