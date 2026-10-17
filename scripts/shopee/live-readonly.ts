// ============================================================
// DEV TOOL — call the REAL Shopee API from a developer machine, READ-ONLY.
//
//   npm run shopee:live -- shops
//   npm run shopee:live -- escrow <orderSn> [orderSn…]     get_escrow_detail
//   npm run shopee:live -- order <orderSn> [orderSn…]      get_order_detail
//   npm run shopee:live -- estimate [--limit 5] [orderSn…] open orders: Shopee
//                                                          estimated revenue vs order total
//   options: --shop <shopId>   --save   (writes sanitized payloads to .shopee-live/)
//
// Env:
//   .env.local        SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, APP_ENCRYPTION_KEY (the PROD key)
//   .env.cloud.local  NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY of the cloud project
//
// Safety rules (why this exists instead of pointing the app at prod):
//   * NEVER refreshes a token. Shopee refresh tokens are single-use: a refresh
//     from this machine would invalidate the token production holds. When the
//     stored access token is close to expiry the tool stops — production
//     refreshes it on its next sync; run again later.
//   * NEVER writes to the cloud database (SELECT only; API failures are not
//     recorded on the connection).
//   * Uses the SAME provider / client / adapter code as production, so what
//     works here works there.
//   * Saved payloads go through the production sanitizers (buyer identity,
//     seller tax id removed); .shopee-live/ is git-ignored.
// ============================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret, parseEncryptionKey } from "../../src/lib/security/secrets.ts";
import { ShopeeClient } from "../../src/lib/channels/shopee/client.ts";
import { getShopeeConfig } from "../../src/lib/channels/shopee/config.ts";
import { TOKEN_REFRESH_BUFFER_SECONDS } from "../../src/lib/channels/shopee/constants.ts";
import { estimatedOrderRevenue, parseEscrowDetail } from "../../src/lib/channels/shopee/escrow-adapter.ts";
import { ESCROW_ESTIMATE_STATUSES } from "../../src/lib/channels/shopee/escrow-sync.ts";
import { RealShopeeOrderProvider } from "../../src/lib/channels/shopee/order-provider.ts";
import { RealShopeePaymentProvider } from "../../src/lib/channels/shopee/payment-provider.ts";
import { tokenContext, type ShopeeTokenSource } from "../../src/lib/channels/shopee/token.ts";

const OUT_DIR = path.join(process.cwd(), ".shopee-live");
const ORDER_PII_KEYS = new Set(["buyer_username", "buyer_user_name", "buyer_user_id", "recipient_address", "buyer_cpf_id", "buyer_cancel_reason", "message_to_seller", "note"]);

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function cloudDb(): SupabaseClient {
  let env: Record<string, string | undefined>;
  try {
    env = parseEnv(readFileSync(path.join(process.cwd(), ".env.cloud.local"), "utf8"));
  } catch {
    fail("Không đọc được .env.cloud.local (URL + service role key của project cloud).");
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail(".env.cloud.local thiếu NEXT_PUBLIC_SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.");
  if (/localhost|127\.0\.0\.1/.test(url)) fail(".env.cloud.local đang trỏ về DB local — token shop thật chỉ có trên cloud.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Token source that only READS the production connection. No refresh, no writes. */
class ReadOnlyTokenSource implements ShopeeTokenSource {
  private readonly db: SupabaseClient;
  private readonly key: Buffer;

  constructor(db: SupabaseClient, key: Buffer) {
    this.db = db;
    this.key = key;
  }

  async getValidAccessToken(shopId: string): Promise<string> {
    const { data, error } = await this.db
      .from("shop_connections")
      .select("shop_id, connection_status, access_token_encrypted, access_token_expires_at")
      .eq("shop_id", shopId)
      .maybeSingle<{ shop_id: string; connection_status: string; access_token_encrypted: string | null; access_token_expires_at: string | null }>();
    if (error) fail(`Không đọc được kết nối shop: ${error.message}`);
    if (!data?.access_token_encrypted || !data.access_token_expires_at) fail(`Shop ${shopId} chưa có access token (trạng thái ${data?.connection_status ?? "không có"}).`);
    const minutesLeft = (new Date(data.access_token_expires_at).getTime() - Date.now()) / 60_000;
    if (minutesLeft * 60 < TOKEN_REFRESH_BUFFER_SECONDS) {
      fail(
        `Access token của prod còn ${Math.max(0, Math.floor(minutesLeft))} phút (< ${TOKEN_REFRESH_BUFFER_SECONDS / 60}). ` +
          "Công cụ này KHÔNG làm mới token (refresh token Shopee dùng 1 lần — làm mới ở đây sẽ làm hỏng kết nối của prod). " +
          "Đợi prod đồng bộ (tự làm mới) rồi chạy lại.",
      );
    }
    try {
      return decryptSecret(data.access_token_encrypted, this.key, tokenContext(data.shop_id, "access_token"));
    } catch {
      fail("Giải mã token thất bại — APP_ENCRYPTION_KEY trong .env.local không phải khóa của production.");
    }
  }

  async recordApiFailure(): Promise<void> {
    // Read-only: never touch the production connection row.
  }
}

function sanitizeOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeOrder);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !ORDER_PII_KEYS.has(k)).map(([k, v]) => [k, sanitizeOrder(v)]));
  }
  return value;
}

function save(name: string, payload: unknown) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return path.relative(process.cwd(), file);
}

const fmt = (v: string | null | undefined) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("vi-VN"));

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const saveFiles = args.includes("--save");
  const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--shop") && !all[i - 1]?.startsWith("--limit"));
  if (!command || !["shops", "escrow", "order", "estimate"].includes(command)) {
    fail("Lệnh: shops | escrow <sn…> | order <sn…> | estimate [--limit N] [sn…]   (tuỳ chọn --shop <id> --save)");
  }

  const config = getShopeeConfig({ ...process.env, SHOPEE_REDIRECT_URL: process.env.SHOPEE_REDIRECT_URL || "https://localhost/readonly" });
  const key = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);
  const db = cloudDb();
  const tokens = new ReadOnlyTokenSource(db, key);
  const client = new ShopeeClient({ partnerId: config.partnerId, partnerKey: config.partnerKey, apiBaseUrl: config.apiBaseUrl, maxRetries: 0, logger: () => {} });

  const { data: shops, error: shopErr } = await db
    .from("shops")
    .select("id, shop_name, external_shop_id, is_active, shop_connections(connection_status, access_token_expires_at)")
    .eq("channel", "shopee")
    .eq("data_source", "live");
  if (shopErr) fail(shopErr.message);
  if (command === "shops") {
    for (const s of shops ?? []) {
      const c = (s.shop_connections as unknown as Array<{ connection_status: string; access_token_expires_at: string | null }>)[0];
      const left = c?.access_token_expires_at ? Math.floor((new Date(c.access_token_expires_at).getTime() - Date.now()) / 60_000) : null;
      console.log(`${s.id}  ${s.shop_name}  ${c?.connection_status ?? "—"}  token còn ${left ?? "—"} phút`);
    }
    return;
  }
  const shopId = flag("--shop") ?? (shops?.length === 1 ? shops[0].id : undefined);
  const shop = shops?.find((s) => s.id === shopId);
  if (!shop) fail(`Chọn shop bằng --shop <id> (có ${shops?.length ?? 0} shop live; xem lệnh "shops").`);
  const ctx = { shopId: shop.id as string, externalShopId: shop.external_shop_id as string };
  const payment = new RealShopeePaymentProvider({ client, connections: tokens });

  if (command === "order") {
    if (positional.length === 0) fail("Cần ít nhất 1 mã đơn.");
    const provider = new RealShopeeOrderProvider({ client, connections: tokens });
    const payload = await provider.getOrderDetails(ctx, { orderSns: positional });
    const clean = sanitizeOrder(payload.raw);
    console.log(JSON.stringify(clean, null, 2).slice(0, 4000));
    if (saveFiles) console.log(`→ ${save(`order-${positional.join("_")}.json`, clean)}`);
    return;
  }

  let sns = positional;
  if (command === "estimate" && sns.length === 0) {
    const limit = Number(flag("--limit") ?? 5);
    const { data } = await db
      .from("channel_orders")
      .select("external_order_sn")
      .eq("shop_id", shop.id)
      .in("order_status", [...ESCROW_ESTIMATE_STATUSES])
      .order("created_at_channel", { ascending: false })
      .limit(limit);
    sns = (data ?? []).map((r) => r.external_order_sn as string);
  }
  if (sns.length === 0) fail("Cần ít nhất 1 mã đơn.");

  const { data: orders } = await db
    .from("v_channel_order_summary")
    .select("external_order_sn, order_status, channel_total_amount, internal_cogs")
    .eq("shop_id", shop.id)
    .in("external_order_sn", sns);
  const byOrder = new Map((orders ?? []).map((o) => [o.external_order_sn as string, o]));

  for (const sn of sns) {
    try {
      const payload = await payment.getEscrowDetail(ctx, { orderSn: sn });
      const parsed = parseEscrowDetail(payload.raw, { expectedOrderSn: sn });
      const income = (parsed.sanitized as { response: { order_income: Record<string, unknown> } }).response.order_income;
      const o = byOrder.get(sn);
      const revenue = estimatedOrderRevenue(parsed);
      if (command === "escrow") {
        console.log(`\n${sn} (${o?.order_status ?? "?"})`);
        for (const k of ["escrow_amount", "escrow_amount_after_adjustment", "buyer_total_amount", "original_price", "order_selling_price", "commission_fee", "service_fee", "seller_transaction_fee", "order_ams_commission_fee", "withholding_vat_tax", "withholding_pit_tax", "final_shipping_fee"]) {
          if (income[k] !== undefined) console.log(`  ${k.padEnd(32)} ${String(income[k])}`);
        }
        if (parsed.unknownFields.length) console.log(`  trường lạ khác 0: ${parsed.unknownFields.join(", ")}`);
      } else {
        // display only — authoritative math stays in SQL
        const profit = revenue !== null && o?.internal_cogs != null ? Number(revenue) - Number(o.internal_cogs) : null;
        const margin = profit !== null && Number(o?.channel_total_amount) > 0 ? ((profit / Number(o!.channel_total_amount)) * 100).toFixed(1) + "%" : "—";
        console.log(
          `${sn}  ${String(o?.order_status ?? "?").padEnd(18)} tổng đơn ${fmt(o?.channel_total_amount).padStart(10)}  DT ước tính ${fmt(revenue).padStart(10)}  COGS ${fmt(o?.internal_cogs).padStart(10)}  LN dự kiến ${profit === null ? "—" : profit.toLocaleString("vi-VN")} (${margin})`,
        );
      }
      if (saveFiles) console.log(`  → ${save(`escrow-${sn}.json`, parsed.sanitized)}`);
    } catch (err) {
      console.log(`${sn}  lỗi: ${(err as Error).message.slice(0, 200)}`);
    }
  }
}

await main();
