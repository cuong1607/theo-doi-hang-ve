// ============================================================
// DEV TOOL — PRODUCT-ANALYTICS-2 local replica + real-payload validation.
//
//   node --env-file=.env.local scripts/shopee/product-analytics-replica.ts load <outDir>
//   node --env-file=.env.local scripts/shopee/product-analytics-replica.ts load <outDir> --facts=cloud
//   node --env-file=.env.local scripts/shopee/product-analytics-replica.ts drop
//
// --facts=cloud (2P): copy the facts / identities / product job history already on
// cloud instead of re-mapping legacy snapshots — the UI then shows what production shows.
//
// CLOUD: SELECT only (cloudDb). LOCAL: writes (guarded: the target must be localhost).
//   1. copies the 5 production shops (same ids, name prefixed "[replica]"), their Ads
//      campaigns / product links / daily + hourly facts / product metadata
//   2. runs the NEW fact mapper (mapOrderToSalesFacts) over every stored production
//      get_order_detail payload (latest per order) and upserts through the same RPC
//      as the sync job → mapping coverage on REAL payloads, PII check, row counts
// No Shopee call. Nothing raw is written to the repo: the report goes to <outDir>.
// ============================================================
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { cloudDb, fail } from "./cloud-readonly.ts";
import { mapOrderToSalesFacts, type ProductSalesFactRow } from "../../src/lib/product-analytics/sales-facts.ts";
import { upsertProductSalesFacts } from "../../src/lib/channels/shopee/product-analytics/sales-sync.ts";

const REPLICA = "[replica] ";

function localDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("Chạy với --env-file=.env.local");
  if (!/localhost|127\.0\.0\.1/.test(url)) fail("Đích ghi phải là DB LOCAL.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += page) {
    const { data, error } = await build(i, i + page - 1);
    if (error) fail(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < page) break;
  }
  return out;
}

async function insertChunks(db: SupabaseClient, table: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(table).insert(rows.slice(i, i + 500));
    if (error) fail(`${table}: ${error.message}`);
  }
}

async function drop(local: SupabaseClient, ids?: string[]) {
  const q = local.from("shops").delete().like("shop_name", `${REPLICA}%`);
  const { error } = ids ? await local.from("shops").delete().in("id", ids) : await q;
  if (error) fail(error.message);
}

async function load(outDir: string) {
  const cloud = cloudDb();
  const local = localDb();
  const started = Date.now();
  const { data: shops, error } = await cloud.from("shops").select("id, shop_name, external_shop_id, currency, region, timezone").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true);
  if (error || !shops) fail(error?.message ?? "no shops");
  const ids = shops.map((s) => s.id as string);
  await drop(local, ids);
  await drop(local);
  await insertChunks(local, "shops", shops.map((s) => ({ id: s.id, channel: "shopee", external_shop_id: `9${String(s.external_shop_id)}`, shop_name: `${REPLICA}${s.shop_name}`, currency: s.currency ?? "VND", region: s.region ?? "VN", timezone: s.timezone, data_source: "live", is_active: true })));

  const since = new Date(Date.now() - 75 * 86_400_000).toISOString().slice(0, 10);
  const campaigns = await all((a, b) => cloud.from("shopee_ads_campaigns").select("*").in("shop_id", ids).order("id").range(a, b));
  await insertChunks(local, "shopee_ads_campaigns", campaigns as Record<string, unknown>[]);
  const links = await all((a, b) => cloud.from("shopee_ads_campaign_products").select("*").in("shop_id", ids).order("id").range(a, b));
  await insertChunks(local, "shopee_ads_campaign_products", links as Record<string, unknown>[]);
  const daily = await all((a, b) => cloud.from("shopee_ads_campaign_daily_performance").select("*").in("shop_id", ids).gte("report_date", since).order("id").range(a, b));
  await insertChunks(local, "shopee_ads_campaign_daily_performance", daily as Record<string, unknown>[]);
  const hourly = await all((a, b) => cloud.from("shopee_ads_campaign_hourly_performance").select("*").in("shop_id", ids).gte("report_date", new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10)).order("id").range(a, b));
  await insertChunks(local, "shopee_ads_campaign_hourly_performance", hourly as Record<string, unknown>[]);
  const adsProducts = await all((a, b) => cloud.from("shopee_ads_products").select("*").in("shop_id", ids).order("id").range(a, b));
  await insertChunks(local, "shopee_ads_products", adsProducts as Record<string, unknown>[]);

  if (process.argv.includes("--facts=cloud")) {
    // 2P: mirror exactly what production shows — the facts / identities / job history already on cloud
    const products = await all((a, b) => cloud.from("shopee_products").select("*").in("shop_id", ids).order("id").range(a, b));
    for (let i = 0; i < products.length; i += 500) {
      const { error: pErr } = await local.from("shopee_products").upsert(products.slice(i, i + 500) as Record<string, unknown>[], { onConflict: "shop_id,provider_item_id", ignoreDuplicates: true });
      if (pErr) fail(`shopee_products: ${pErr.message}`);
    }
    const facts = await all((a, b) => cloud.from("shopee_product_sales_facts").select("*").in("shop_id", ids).order("id").range(a, b));
    await insertChunks(local, "shopee_product_sales_facts", facts as Record<string, unknown>[]);
    const jobs = await all((a, b) => cloud.from("channel_sync_jobs").select("id, shop_id, sync_type, mode, status, priority, started_at, finished_at, created_at, metadata").in("shop_id", ids).eq("sync_type", "product_sales_facts_read").order("id").range(a, b));
    await insertChunks(local, "channel_sync_jobs", jobs.map((j) => ({ ...(j as Record<string, unknown>), metadata: { ...((j as { metadata: Record<string, unknown> }).metadata ?? {}), replica: true } })));
    // freshness (last success) is read from channel_sync_states
    const states = await all((a, b) => cloud.from("channel_sync_states").select("shop_id, sync_type, last_success_at").in("shop_id", ids).like("sync_type", "product_%").order("shop_id").range(a, b));
    if (states.length) {
      const { error: sErr } = await local.from("channel_sync_states").upsert(states as Record<string, unknown>[], { onConflict: "shop_id,sync_type" });
      if (sErr) fail(`channel_sync_states: ${sErr.message}`);
    }
    const settings = await all((a, b) => cloud.from("product_analytics_shop_settings").select("*").in("shop_id", ids).order("shop_id").range(a, b));
    if (settings.length) await insertChunks(local, "product_analytics_shop_settings", settings.map((s) => ({ ...(s as Record<string, unknown>), updated_by: null })));
    const report = { mode: "facts=cloud", products: products.length, facts: facts.length, jobs: jobs.length, settings: settings.length, durationMs: Date.now() - started };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "pa2p-replica-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    return;
  }

  // ---- real order payloads → NEW mapper → facts
  type Snap = { shop_id: string; entity_external_id: string; synced_at: string; payload: unknown };
  const snaps = await all<Snap>((a, b) => cloud.from("channel_api_snapshots").select("shop_id, entity_external_id, synced_at, payload").eq("entity_type", "order").in("shop_id", ids).order("id").range(a, b), 500);
  const latest = new Map<string, Snap>();
  for (const s of snaps) {
    const key = `${s.shop_id}|${s.entity_external_id}`;
    const cur = latest.get(key);
    if (!cur || cur.synced_at < s.synced_at) latest.set(key, s);
  }
  const perShop = new Map<string, ProductSalesFactRow[]>();
  const issues: Record<string, number> = {};
  let mapped = 0;
  for (const s of latest.values()) {
    const r = mapOrderToSalesFacts(s.payload);
    if ("issue" in r) {
      issues[r.issue.reason.replace(/\[\d+\]/, "[i]")] = (issues[r.issue.reason.replace(/\[\d+\]/, "[i]")] ?? 0) + 1;
      continue;
    }
    mapped++;
    perShop.set(s.shop_id, [...(perShop.get(s.shop_id) ?? []), ...r.rows]);
  }
  const piiProbe = /message_to_seller|recipient|buyer_user|phone|full_address/;
  const leaked = [...perShop.values()].flat().filter((row) => piiProbe.test(Object.keys(row).join(","))).length;
  const upserts: Record<string, unknown> = {};
  for (const [shopId, rows] of perShop) upserts[shopId] = await upsertProductSalesFacts(local, shopId, rows);
  // the replica's "last success" so the UI shows real freshness semantics (local only)
  for (const shopId of ids) {
    await local.from("product_analytics_shop_settings").upsert({ shop_id: shopId, sales_sync_enabled: false, sales_backfill_done_at: null }, { onConflict: "shop_id" });
  }

  const shopName = new Map(shops.map((s) => [s.id as string, s.shop_name as string]));
  const facts = await all<{ shop_id: string; status_class: string; is_free_gift: boolean; report_date: string }>((a, b) => local.from("shopee_product_sales_facts").select("shop_id, status_class, is_free_gift, report_date").in("shop_id", ids).order("id").range(a, b));
  const { data: products } = await local.from("shopee_products").select("shop_id, first_seen_source, metadata_source").in("shop_id", ids);
  const report = {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    copied: { campaigns: campaigns.length, links: links.length, adsDaily: daily.length, adsHourly: hourly.length, adsProducts: adsProducts.length },
    orders: { snapshots: snaps.length, distinctOrders: latest.size, mapped, issues, piiKeysLeaked: leaked },
    facts: {
      total: facts.length,
      byShop: Object.fromEntries(ids.map((id) => [shopName.get(id), facts.filter((f) => f.shop_id === id).length])),
      byStatusClass: facts.reduce<Record<string, number>>((a, f) => ({ ...a, [f.status_class]: (a[f.status_class] ?? 0) + 1 }), {}),
      freeGiftLines: facts.filter((f) => f.is_free_gift).length,
      dateRange: [facts.reduce((m, f) => (f.report_date < m ? f.report_date : m), "9999"), facts.reduce((m, f) => (f.report_date > m ? f.report_date : m), "0000")],
    },
    upserts: Object.fromEntries(Object.entries(upserts).map(([k, v]) => [shopName.get(k), v])),
    products: {
      total: products?.length ?? 0,
      byFirstSeen: (products ?? []).reduce<Record<string, number>>((a, p) => ({ ...a, [p.first_seen_source]: (a[p.first_seen_source] ?? 0) + 1 }), {}),
      byMetadataSource: (products ?? []).reduce<Record<string, number>>((a, p) => ({ ...a, [String(p.metadata_source)]: (a[String(p.metadata_source)] ?? 0) + 1 }), {}),
    },
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "pa2-replica-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "load" && arg) await load(arg);
else if (cmd === "drop") await drop(localDb());
else fail("usage: product-analytics-replica.ts load <outDir> | drop");
