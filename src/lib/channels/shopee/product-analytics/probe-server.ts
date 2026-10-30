// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1: server transport for the READ-ONLY product
// analytics probe (admin page /shopee/product-analytics/probe).
//
// Runs inside the app, where the production partner credentials live, for
// ONE validated live shop and ≤ 10 explicit item ids: control path + the
// evidenced candidates, nothing else (assertProductAnalyticsReadRequest).
// Token flow = the app's own (ShopeeConnectionService.getValidAccessToken).
//
// Writes to Shopee: NOTHING. Writes to our DB: ONE channel_api_snapshots row
// (entity_type 'product_analytics_probe') holding the report, so the result
// can be read back with a SELECT and turned into sanitized fixtures locally
// (scripts/shopee/product-analytics-discovery.ts import-cloud).
//
// Logs: metadata only. Never the URL (token + signature), never a body.
// ============================================================
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { getShopee } from "../server.ts";
import { listAdsProbeShops, adsProbeEnvironment } from "../ads/probe-server.ts";
import { buildItemComparisons, PRODUCT_ANALYTICS_PROBE_ENTITY, runProductAnalyticsDiscovery, type AdsItemFacts, type DiscoveryTransport, type InternalItemFacts, type ProductAnalyticsProbeResult } from "./discovery.ts";
import { assertProductAnalyticsReadRequest, PRODUCT_ANALYTICS_DISCOVERY_MAX_ITEMS } from "./read-only-policy.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const running = new Set<string>();
/** = analytics_is_sales_status() (00059): cost_order_status_eligible() + TO_RETURN. */
const SALES_STATUSES = new Set(["READY_TO_SHIP", "PROCESSED", "RETRY_SHIP", "SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED", "TO_RETURN"]);

export class ProductAnalyticsProbeInputError extends Error {}

export type { ProductAnalyticsProbeResult };

export function parseProbeItemIds(text: string): string[] {
  const ids = [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new ProductAnalyticsProbeInputError("Nhập ít nhất 1 item id.");
  if (ids.length > PRODUCT_ANALYTICS_DISCOVERY_MAX_ITEMS) throw new ProductAnalyticsProbeInputError(`Tối đa ${PRODUCT_ANALYTICS_DISCOVERY_MAX_ITEMS} item mỗi lượt.`);
  for (const id of ids) if (!/^[0-9]{1,20}$/.test(id)) throw new ProductAnalyticsProbeInputError(`Item id không hợp lệ: ${id}`);
  return ids;
}

function vnDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Internal order facts for the given items (sales statuses only, same rule as the analytics read model). */
async function internalFacts(shopId: string, itemIds: string[], from: string, to: string): Promise<Map<string, InternalItemFacts>> {
  const db = createAdminClient();
  const out = new Map<string, InternalItemFacts>();
  const fromTs = `${from}T00:00:00+07:00`;
  const toTs = `${addDays(to, 1)}T00:00:00+07:00`;
  for (const itemId of itemIds) {
    const facts: InternalItemFacts = { ordersInDb: 0, unitsInDb: 0, firstOrderAt: null, units7d: 0, orders7d: 0 };
    // ≤ 1000 rows per page (PostgREST cap) — paged
    for (let page = 0; page < 20; page++) {
      const { data, error } = await db
        .from("channel_order_items")
        .select("quantity, channel_orders!inner(id, shop_id, order_status, created_at_channel)")
        .eq("external_item_id", itemId)
        .eq("channel_orders.shop_id", shopId)
        .order("id")
        .range(page * 1000, page * 1000 + 999);
      if (error) throw new Error("Không đọc được đơn hàng nội bộ.");
      const rows = (data ?? []) as unknown as Array<{ quantity: number; channel_orders: { id: string; order_status: string; created_at_channel: string } }>;
      const orders = new Set<string>();
      const orders7 = new Set<string>();
      for (const r of rows) {
        const o = r.channel_orders;
        if (!SALES_STATUSES.has(o.order_status)) continue;
        facts.unitsInDb += Number(r.quantity);
        orders.add(o.id);
        if (!facts.firstOrderAt || o.created_at_channel < facts.firstOrderAt) facts.firstOrderAt = o.created_at_channel;
        const t = new Date(o.created_at_channel).getTime();
        if (t >= new Date(fromTs).getTime() && t < new Date(toTs).getTime()) {
          facts.units7d += Number(r.quantity);
          orders7.add(o.id);
        }
      }
      facts.ordersInDb += orders.size;
      facts.orders7d += orders7.size;
      if (rows.length < 1000) break;
    }
    out.set(itemId, facts);
  }
  return out;
}

async function adsFacts(shopId: string, itemIds: string[], from: string, to: string): Promise<Map<string, AdsItemFacts>> {
  const db = createAdminClient();
  const out = new Map<string, AdsItemFacts>();
  const { data: products } = await db.from("shopee_ads_products").select("provider_item_id").eq("shop_id", shopId).in("provider_item_id", itemIds);
  const productIds = new Set((products ?? []).map((p) => p.provider_item_id as string));
  const { data: links } = await db.from("shopee_ads_campaign_products").select("campaign_id, provider_item_id").eq("shop_id", shopId).in("provider_item_id", itemIds);
  for (const itemId of itemIds) {
    const campaigns = [...new Set((links ?? []).filter((l) => l.provider_item_id === itemId).map((l) => l.campaign_id as string))];
    const facts: AdsItemFacts = { adsProductRow: productIds.has(itemId), campaigns: campaigns.length, impression7d: 0, clicks7d: 0, expense7d: 0, broadOrder7d: 0, directOrder7d: 0 };
    if (campaigns.length) {
      const { data: perf } = await db
        .from("shopee_ads_campaign_daily_performance")
        .select("impression, clicks, expense, broad_order, direct_order")
        .eq("shop_id", shopId)
        .in("campaign_id", campaigns.slice(0, 100))
        .gte("report_date", from)
        .lte("report_date", to)
        .limit(1000);
      for (const r of perf ?? []) {
        facts.impression7d += Number(r.impression);
        facts.clicks7d += Number(r.clicks);
        facts.expense7d += Number(r.expense);
        facts.broadOrder7d += Number(r.broad_order);
        facts.directOrder7d += Number(r.direct_order);
      }
    }
    out.set(itemId, facts);
  }
  return out;
}

export async function runProductAnalyticsProbeForShop(shopId: string, itemText: string, now = new Date()): Promise<ProductAnalyticsProbeResult> {
  const itemIds = parseProbeItemIds(itemText);
  const shops = await listAdsProbeShops();
  const shop = shops.find((s) => s.id === shopId);
  // only a validated internal shop record — never a provider shop id from the caller
  if (!shop) throw new ProductAnalyticsProbeInputError("Shop không hợp lệ (cần shop Shopee live đang hoạt động).");
  if (shop.connectionStatus !== "connected") throw new ProductAnalyticsProbeInputError(`Shop chưa kết nối (trạng thái: ${shop.connectionStatus ?? "không có"}).`);
  if (running.has(shopId)) throw new ProductAnalyticsProbeInputError("Đang có một lượt probe cho shop này.");
  running.add(shopId);
  try {
    const { config, client, service } = getShopee();
    const environment = adsProbeEnvironment(config.apiBaseUrl);
    const transport: DiscoveryTransport = async (req) => {
      assertProductAnalyticsReadRequest(req.method, req.path);
      let accessToken: string;
      try {
        accessToken = await service.getValidAccessToken(shop.id);
      } catch {
        return { httpStatus: null, latencyMs: 0, text: "", transportError: { code: "token_unavailable", message: "token" } };
      }
      const url = client.signedUrl(req.path, req.params, { externalShopId: shop.externalShopId, accessToken });
      const started = Date.now();
      try {
        const res = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const text = (await res.text()).split(accessToken).join("[redacted]").split(config.partnerKey).join("[redacted]");
        console.info(JSON.stringify({ source: "shopee-product-analytics-probe", event: "call", shopId: shop.id, apiPath: req.path, method: req.method, httpStatus: res.status, latencyMs: Date.now() - started }));
        return { httpStatus: res.status, latencyMs: Date.now() - started, text };
      } catch (err) {
        return { httpStatus: null, latencyMs: Date.now() - started, text: "", transportError: { code: "network_error", message: err instanceof Error ? err.name : "fetch failed" } };
      }
    };

    const report = await runProductAnalyticsDiscovery({ plan: [{ shopKey: shop.id, shopLabel: shop.shopName, itemIds }], transport });
    const to = addDays(vnDay(now), -1);
    const from = addDays(to, -6);
    const okCall = report.calls.find((c) => c.classification === "OK");
    // sequential on purpose (Shopee-code rule: no unbounded fan-out; these are small DB reads)
    const internal = await internalFacts(shop.id, itemIds, from, to);
    const ads = await adsFacts(shop.id, itemIds, from, to);
    const result: ProductAnalyticsProbeResult = {
      environment,
      shopLabel: shop.shopName,
      ranAt: now.toISOString(),
      window: { from, to },
      report,
      comparisons: buildItemComparisons(itemIds, okCall?.body ?? null, internal, ads),
    };
    const { error } = await createAdminClient()
      .from("channel_api_snapshots")
      .insert({ shop_id: shop.id, entity_type: PRODUCT_ANALYTICS_PROBE_ENTITY, entity_external_id: result.ranAt, api_name: "product_analytics_probe", payload: result, source_mode: "live", synced_at: result.ranAt });
    if (error) console.warn(JSON.stringify({ source: "shopee-product-analytics-probe", event: "snapshot_failed", shopId: shop.id }));
    return result;
  } finally {
    running.delete(shopId);
  }
}
