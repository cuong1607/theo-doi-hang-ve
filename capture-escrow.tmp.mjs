// Throwaway (deleted after use): capture REAL get_escrow_detail payloads of the
// pilot shop for SHOPEE-5 payload validation. Read-only towards Shopee; the
// only possible DB write is the normal token refresh of shop_connections.
// Output: scratchpad dir (never committed). buyer_user_name is stripped.
//   node --env-file=.env.production.local capture-escrow.tmp.mjs <outDir>
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { ShopeeClient } from "./src/lib/channels/shopee/client.ts";
import { getShopeeConfig } from "./src/lib/channels/shopee/config.ts";
import { ShopeeConnectionService } from "./src/lib/channels/shopee/token.ts";
import { RealShopeePaymentProvider } from "./src/lib/channels/shopee/payment-provider.ts";

const outDir = process.argv[2];
mkdirSync(outDir, { recursive: true });
const config = getShopeeConfig();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const client = new ShopeeClient({ partnerId: config.partnerId, partnerKey: config.partnerKey, apiBaseUrl: config.apiBaseUrl, maxRetries: 1, logger: () => {} });
const connections = new ShopeeConnectionService({ db, client, encryptionKey: config.encryptionKey, logger: () => {} });
const provider = new RealShopeePaymentProvider({ client, connections });

const { data: shop } = await db.from("shops").select("id, external_shop_id, shop_name").eq("channel", "shopee").eq("data_source", "live").limit(1).single();
const pick = async (status, n) =>
  (await db.from("channel_orders").select("external_order_sn, order_status, channel_total_amount").eq("shop_id", shop.id).eq("order_status", status).order("updated_at_channel", { ascending: false }).limit(n)).data ?? [];
const orders = [...(await pick("COMPLETED", 40)), ...(await pick("TO_RETURN", 8)), ...(await pick("SHIPPED", 2)), ...(await pick("CANCELLED", 2))];
console.log(`shop ${shop.shop_name}: ${orders.length} orders`);

const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "buyer_user_name").map(([k, x]) => [k, strip(x)]));
  return v;
};
const summary = [];
for (const o of orders) {
  try {
    const p = await provider.getEscrowDetail({ shopId: shop.id, externalShopId: shop.external_shop_id }, { orderSn: o.external_order_sn });
    writeFileSync(path.join(outDir, `${o.order_status}_${o.external_order_sn}.json`), JSON.stringify(strip(p.raw), null, 2));
    const inc = p.raw?.response?.order_income ?? {};
    summary.push({ sn: o.external_order_sn, status: o.order_status, ok: true, escrow: inc.escrow_amount, after: inc.escrow_amount_after_adjustment, adj: (inc.order_adjustment ?? []).length });
  } catch (e) {
    summary.push({ sn: o.external_order_sn, status: o.order_status, ok: false, code: e.errorCode ?? e.name, msg: String(e.message).slice(0, 160) });
  }
  await new Promise((r) => setTimeout(r, 250));
}
writeFileSync(path.join(outDir, "_summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.reduce((m, s) => ((m[`${s.status}:${s.ok ? "ok" : s.code}`] = (m[`${s.status}:${s.ok ? "ok" : s.code}`] ?? 0) + 1), m), {})));
