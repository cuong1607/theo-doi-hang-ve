/**
 * PRODUCT-ANALYTICS-2P pilot checks — READ ONLY (SELECT / read RPCs, no write, no Shopee call).
 *
 *   node --env-file=.env.cloud.local scripts/shopee/product-analytics-pilot-check.ts latency <shopName>
 *   node --env-file=.env.cloud.local scripts/shopee/product-analytics-pilot-check.ts agent-tools
 *
 * latency: list 7d / 30d (one shop), list 30d (all shops), detail + baseline of the shop's top product.
 *          Measured from this machine (network to the DB region included), not from Vercel.
 * agent-tools: runs the 5 future tools for a real granted user, then the denial paths.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  compare_product_periods,
  get_product_ads_performance,
  get_product_baseline,
  get_product_overview,
  get_product_sales_summary,
  ProductToolAccessError,
} from "../../src/lib/product-analytics/agent-tools.ts";
import { resolveProductPeriod } from "../../src/lib/product-analytics/periods.ts";
import { loadProductDetail, loadProductList } from "../../src/lib/product-analytics/read-model.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
const db: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });

const RUNS = 7;

async function measure(label: string, fn: () => Promise<unknown>) {
  await fn(); // warm-up (connection, plan cache)
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const q = (p: number) => Math.round(ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)]);
  console.log(JSON.stringify({ read: label, runs: RUNS, p50_ms: q(0.5), p95_ms: q(0.95), max_ms: Math.round(ms[ms.length - 1]) }));
}

async function shops() {
  const { data, error } = await db.from("shops").select("id, shop_name").eq("channel", "shopee");
  if (error) throw error;
  return data as { id: string; shop_name: string }[];
}

async function latency(shopName: string) {
  const all = await shops();
  const shop = all.find((s) => s.shop_name.toLowerCase().startsWith(shopName.toLowerCase()));
  if (!shop) throw new Error(`shop not found: ${shopName}`);
  const p7 = resolveProductPeriod({ preset: "7d" });
  const p30 = resolveProductPeriod({ preset: "30d" });
  await measure(`list 7d [${shopName}]`, () => loadProductList(db, [shop.id], p7));
  await measure(`list 30d [${shopName}]`, () => loadProductList(db, [shop.id], p30));
  const allRows = await loadProductList(db, all.map((s) => s.id), p30);
  console.log(JSON.stringify({ all_shops_list_rows: allRows.length }));
  await measure("list 30d [all 5 shops]", () => loadProductList(db, all.map((s) => s.id), p30));
  const rows = await loadProductList(db, [shop.id], p30);
  const top = [...rows].sort((a, b) => Number(b.gmv ?? 0) - Number(a.gmv ?? 0))[0];
  if (!top) return console.log("no product");
  const ref = { productId: top.id, shopId: shop.id, itemId: top.item_id };
  await measure(`detail 30d [top product ${top.item_id}]`, () => loadProductDetail(db, ref, p30));
  await measure("baseline RPC 30d", async () => {
    const { error } = await db.rpc("product_analytics_baseline", { p_shop_id: shop.id, p_item_id: top.item_id, p_from: p30.from, p_to: p30.to });
    if (error) throw error;
  });
}

const FORBIDDEN_KEYS = /order_sn|provider_order_id|buyer|recipient|phone|address|message_to_seller|sql|query/i;

function keysOf(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}

async function agentTools() {
  const { data: grants, error } = await db.from("ai_user_shop_access").select("internal_user_id, shop_id");
  if (error) throw error;
  if (!grants?.length) return console.log("no ai_user_shop_access grant on this database");
  const g = grants[0] as { internal_user_id: string; shop_id: string };
  const all = await shops();
  const granted = new Set(grants.filter((x) => x.internal_user_id === g.internal_user_id).map((x) => x.shop_id));
  const p30 = resolveProductPeriod({ preset: "30d" });
  const rows = await loadProductList(db, [g.shop_id], p30);
  const top = [...rows].sort((a, b) => Number(b.gmv ?? 0) - Number(a.gmv ?? 0))[0];
  console.log(JSON.stringify({ granted_shops: [...granted].map((id) => all.find((s) => s.id === id)?.shop_name), product_item: top?.item_id }));
  const scope = { internal_user_id: g.internal_user_id, shop_id: g.shop_id, product_id: top.id };
  const tools = {
    get_product_overview: () => get_product_overview(db, scope),
    compare_product_periods: () => compare_product_periods(db, scope, { period: { preset: "7d" } }),
    get_product_sales_summary: () => get_product_sales_summary(db, scope, { period: { preset: "30d" } }),
    get_product_ads_performance: () => get_product_ads_performance(db, scope, { period: { preset: "7d" } }),
    get_product_baseline: () => get_product_baseline(db, scope, { days: 30 }),
  };
  for (const [name, fn] of Object.entries(tools)) {
    const t = performance.now();
    const out = await fn();
    const json = JSON.stringify(out);
    const keys = keysOf(out);
    const forbidden = [...keys].filter((k) => FORBIDDEN_KEYS.test(k));
    console.log(JSON.stringify({
      tool: name,
      bytes: Buffer.byteLength(json),
      under_6kb: Buffer.byteLength(json) < 6144,
      ms: Math.round(performance.now() - t),
      has_data_quality: keys.has("data_quality"),
      has_metric_meta: keys.has("metric_meta") || keys.has("source") || keys.has("semantic_confidence"),
      forbidden_keys: forbidden,
    }));
  }
  // §34: what the analyst would actually receive for sales
  const cmp = await compare_product_periods(db, scope, { period: { preset: "7d" } });
  const base = await get_product_baseline(db, scope, { days: 30 });
  console.log(JSON.stringify({ sales_gmv: cmp.comparisons.sales_gmv, orders: cmp.comparisons.orders, sales_signals: cmp.signals.filter((s) => /^(SALES|ORDERS|UNITS)_/.test(s.type)), coverage: cmp.data_quality.sales_coverage, baseline_sales_complete: base.data_quality.sales_baseline_complete }));
  // denial paths
  const other = all.find((s) => !granted.has(s.id));
  const otherProduct = other ? (await db.from("shopee_products").select("id").eq("shop_id", other.id).limit(1).maybeSingle()).data : null;
  const cases: [string, typeof scope][] = [
    ["unknown user", { ...scope, internal_user_id: "00000000-0000-4000-8000-000000000000" }],
    ["shop not granted", other && otherProduct ? { ...scope, shop_id: other.id, product_id: otherProduct.id } : scope],
    ["product of another shop under granted shop", otherProduct ? { ...scope, product_id: otherProduct.id } : scope],
    ["not a uuid", { ...scope, product_id: "1; select 1" }],
  ];
  for (const [label, s] of cases) {
    try {
      await get_product_overview(db, s);
      console.log(JSON.stringify({ deny_case: label, result: "ALLOWED (BAD)" }));
    } catch (e) {
      console.log(JSON.stringify({ deny_case: label, result: e instanceof ProductToolAccessError ? e.code : `error ${(e as Error).message}` }));
    }
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "latency") await latency(arg ?? "CTV");
else if (cmd === "agent-tools") await agentTools();
else console.log("usage: latency <shopName> | agent-tools");
