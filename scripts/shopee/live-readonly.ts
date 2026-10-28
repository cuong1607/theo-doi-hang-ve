// ============================================================
// DEV TOOL — call the REAL Shopee API from a developer machine, READ-ONLY.
//
//   npm run shopee:live -- shops
//   npm run shopee:live -- escrow <orderSn> [orderSn…]     get_escrow_detail
//   npm run shopee:live -- order <orderSn> [orderSn…]      get_order_detail
//   npm run shopee:live -- estimate [--limit 5] [orderSn…] open orders: Shopee
//                                                          estimated revenue vs order total
//   SHOPEE-6B (hàng hoàn — real payload validation):
//   npm run shopee:live -- returns [--days 15] [--limit 10]  get_return_list → detail +
//                                                          get_reverse_tracking_info (Hoàn Trả)
//   npm run shopee:live -- reverse <returnSn…>             get_reverse_tracking_info
//   npm run shopee:live -- tracking <orderSn…>             get_order_detail (cancel / package) +
//                                                          get_tracking_number + get_tracking_info
//   npm run shopee:live -- failed [--limit 10]             cancelled-after-pickup orders from the
//                                                          cloud DB → same as "tracking" (Hoàn Hủy)
//   options: --shop <shopId>   --save   (writes sanitized payloads to .shopee-live/)
//
// Env:
//   .env.local        SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, APP_ENCRYPTION_KEY (the PROD key)
//   .env.cloud.local  NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY of the cloud project
//
// Safety rules (why this exists instead of pointing the app at prod;
// the read-only token source lives in ./cloud-readonly.ts, shared with ads-discovery.ts):
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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseEncryptionKey } from "../../src/lib/security/secrets.ts";
import { ShopeeClient } from "../../src/lib/channels/shopee/client.ts";
import { getShopeeConfig } from "../../src/lib/channels/shopee/config.ts";
import { estimatedOrderRevenue, parseEscrowDetail } from "../../src/lib/channels/shopee/escrow-adapter.ts";
import { ESCROW_ESTIMATE_STATUSES } from "../../src/lib/channels/shopee/escrow-sync.ts";
import { RealShopeeOrderProvider } from "../../src/lib/channels/shopee/order-provider.ts";
import { RealShopeePaymentProvider } from "../../src/lib/channels/shopee/payment-provider.ts";
import type { ShopeeTokenSource } from "../../src/lib/channels/shopee/token.ts";
import { parseReturnListPage, sanitizeReturnPayload } from "../../src/lib/channels/shopee/return-adapter.ts";
import { RealShopeeReturnProvider } from "../../src/lib/channels/shopee/return-provider.ts";
import { parseFailedDeliveryTracking, parseReverseTrackingInfo, parseTrackingNumber, type ReturnLogisticsFacts } from "../../src/lib/channels/shopee/return-logistics-adapter.ts";
import { RealShopeeReturnLogisticsProvider } from "../../src/lib/channels/shopee/return-logistics-provider.ts";
import { cloudDb, fail, ReadOnlyTokenSource } from "./cloud-readonly.ts";

const OUT_DIR = path.join(process.cwd(), ".shopee-live");
const ORDER_PII_KEYS = new Set(["buyer_username", "buyer_user_name", "buyer_user_id", "recipient_address", "buyer_cpf_id", "buyer_cancel_reason", "message_to_seller", "note"]);


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
  const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--shop") && !all[i - 1]?.startsWith("--limit") && !all[i - 1]?.startsWith("--days"));
  if (!command || !["shops", "escrow", "order", "estimate", "returns", "reverse", "tracking", "failed"].includes(command)) {
    fail("Lệnh: shops | escrow <sn…> | order <sn…> | estimate [--limit N] [sn…] | returns [--days N] [--limit N] | reverse <returnSn…> | tracking <orderSn…> | failed [--limit N]   (tuỳ chọn --shop <id> --save)");
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

  if (command === "returns" || command === "reverse" || command === "tracking" || command === "failed") {
    await returnOperationsCommand(command, { db, client, tokens, ctx, positional, saveFiles, days: Number(flag("--days") ?? 15), limit: Number(flag("--limit") ?? 10) });
    return;
  }

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

// ------------------------------------------------------------ SHOPEE-6B

function printFacts(label: string, f: ReturnLogisticsFacts) {
  console.log(`  [${label}] segment=${f.segment} provider=${f.providerStatus ?? "—"} → ${f.canonicalStatus}`);
  console.log(`  delivered_to_seller_at=${f.deliveredToSellerAt ?? "—"} (${f.deliveredAtSource ?? "—"})  tracking=${f.trackingNumber ?? "—"}  rts=${f.rtsTrackingNumber ?? "—"}  carrier=${f.logisticsProvider ?? "—"}${f.notes.length ? `  notes=${f.notes.join(",")}` : ""}`);
  for (const e of f.events) console.log(`    ${e.eventTime}  ${e.segment.padEnd(19)} ${String(e.providerStatus ?? "(không có status)").padEnd(28)} → ${e.canonicalStatus.padEnd(26)} ${e.description ?? ""}`);
}

/** Raw field names actually present (for the docs checklist) — keys only, never values. */
const keysOf = (v: unknown) => (v && typeof v === "object" ? Object.keys(v as Record<string, unknown>).sort().join(", ") : "—");

async function returnOperationsCommand(
  command: "returns" | "reverse" | "tracking" | "failed",
  o: { db: SupabaseClient; client: ShopeeClient; tokens: ShopeeTokenSource; ctx: { shopId: string; externalShopId: string }; positional: string[]; saveFiles: boolean; days: number; limit: number },
) {
  const logistics = new RealShopeeReturnLogisticsProvider({ client: o.client, connections: o.tokens });
  const reverse = async (sn: string) => {
    try {
      const payload = await logistics.getReverseTrackingInfo(o.ctx, { returnSn: sn });
      const response = (payload.raw as { response?: unknown }).response;
      console.log(`  fields: ${keysOf(response)}`);
      printFacts("reverse", parseReverseTrackingInfo(payload.raw));
      if (o.saveFiles) console.log(`  → ${save(`reverse-tracking-${sn}.json`, payload.raw)}`);
    } catch (err) {
      console.log(`  get_reverse_tracking_info lỗi: ${(err as Error).message.slice(0, 200)}`);
    }
  };
  const tracking = async (sn: string) => {
    const orders = new RealShopeeOrderProvider({ client: o.client, connections: o.tokens });
    let packageNumber: string | null = null;
    try {
      const detail = sanitizeOrder((await orders.getOrderDetails(o.ctx, { orderSns: [sn] })).raw) as { response?: { order_list?: Array<Record<string, unknown>> } };
      const ord = detail.response?.order_list?.[0];
      const pkgs = (ord?.package_list as Array<Record<string, unknown>> | undefined) ?? [];
      packageNumber = (pkgs[0]?.package_number as string | undefined) ?? null;
      console.log(`  order_status=${ord?.order_status ?? "?"} cancel_by=${ord?.cancel_by ?? "—"} cancel_reason=${ord?.cancel_reason ?? "—"} pickup_done_time=${ord?.pickup_done_time ?? "—"} carrier=${ord?.shipping_carrier ?? "—"}`);
      for (const p of pkgs) console.log(`  package ${p.package_number ?? "—"} logistics_status=${p.logistics_status ?? "—"} carrier=${p.shipping_carrier ?? "—"}`);
      if (o.saveFiles) console.log(`  → ${save(`order-${sn}.json`, detail)}`);
    } catch (err) {
      console.log(`  get_order_detail lỗi: ${(err as Error).message.slice(0, 200)}`);
    }
    let trackingNumber: string | null = null;
    try {
      const tn = await logistics.getTrackingNumber(o.ctx, { orderSn: sn, packageNumber });
      console.log(`  get_tracking_number fields: ${keysOf((tn.raw as { response?: unknown }).response)}`);
      trackingNumber = parseTrackingNumber(tn.raw);
    } catch (err) {
      console.log(`  get_tracking_number lỗi: ${(err as Error).message.slice(0, 200)}`);
    }
    try {
      const info = await logistics.getTrackingInfo(o.ctx, { orderSn: sn, packageNumber });
      console.log(`  get_tracking_info fields: ${keysOf((info.raw as { response?: unknown }).response)}`);
      printFacts("rts", parseFailedDeliveryTracking(info.raw, trackingNumber));
      if (o.saveFiles) console.log(`  → ${save(`tracking-info-${sn}.json`, { ...(info.raw as object), tracking_number: trackingNumber })}`);
    } catch (err) {
      console.log(`  get_tracking_info lỗi: ${(err as Error).message.slice(0, 200)}`);
    }
  };

  if (command === "reverse" || command === "tracking") {
    if (o.positional.length === 0) fail("Cần ít nhất 1 mã.");
    for (const sn of o.positional) {
      console.log(`\n${sn}`);
      await (command === "reverse" ? reverse(sn) : tracking(sn));
    }
    return;
  }

  if (command === "returns") {
    const returns = new RealShopeeReturnProvider({ client: o.client, connections: o.tokens });
    const to = Math.floor(Date.now() / 1000);
    const from = to - Math.min(Math.max(o.days, 1), 15) * 86400;
    const page = parseReturnListPage((await returns.listReturns(o.ctx, { updateTimeFrom: from, updateTimeTo: to, pageNo: 0, pageSize: 50 })).raw);
    console.log(`${page.entries.length} return trong ${o.days} ngày (more=${page.more}); xem ${Math.min(o.limit, page.entries.length)}:`);
    for (const e of page.entries.slice(0, o.limit)) {
      console.log(`\n${e.returnSn}  order ${e.orderSn}  status ${e.status ?? "—"}`);
      try {
        const detail = (await returns.getReturnDetail(o.ctx, { returnSn: e.returnSn })).raw as { response?: Record<string, unknown> };
        const r = detail.response ?? {};
        console.log(`  detail: needs_logistics=${r.needs_logistics ?? "—"} reverse_logistic_status=${r.reverse_logistic_status ?? "—"} return_refund_type=${r.return_refund_type ?? "—"} tracking_number=${r.tracking_number ?? "—"} items=${Array.isArray(r.item) ? r.item.length : "—"}`);
        if (o.saveFiles) console.log(`  → ${save(`return-detail-${e.returnSn}.json`, sanitizeReturnPayload(detail))}`);
      } catch (err) {
        console.log(`  get_return_detail lỗi: ${(err as Error).message.slice(0, 200)}`);
      }
      await reverse(e.returnSn);
    }
    return;
  }

  // failed: cancelled orders that had been handed to the carrier (columns that exist before 00060 only)
  const { data, error } = await o.db
    .from("channel_orders")
    .select("external_order_sn, order_status, pickup_done_at_channel, updated_at_channel")
    .eq("shop_id", o.ctx.shopId)
    .eq("order_status", "CANCELLED")
    .not("pickup_done_at_channel", "is", null)
    .order("updated_at_channel", { ascending: false })
    .limit(o.limit);
  if (error) fail(error.message);
  console.log(`${data?.length ?? 0} đơn huỷ sau khi đã lấy hàng (ứng viên Hoàn Hủy):`);
  for (const r of data ?? []) {
    console.log(`\n${r.external_order_sn}  cập nhật ${r.updated_at_channel}`);
    await tracking(r.external_order_sn as string);
  }
}

await main();
