// ============================================================
// PRODUCT-ANALYTICS-4 — LIVE Claude pilot (spec §116–124). OPT-IN ONLY.
//
//   RUN_AI_LIVE_TESTS=true ANTHROPIC_API_KEY=… \
//   node --env-file=.env.local scripts/ai/product-analyst-pilot.ts <outDir>
//
// Runs the 10-question pilot set against the LOCAL replica of production
// (scripts/shopee/product-analytics-replica.ts load <dir> --facts=cloud) with
// the real ClaudeProductAnalystProvider and the real orchestrator (auth,
// tools, guards, usage log, cache). Reports per question: status, tools,
// tokens (as REPORTED by the API), estimated cost, model / tool / end-to-end
// latency, and the answer — plus p50 / p95 / max and the total.
// Dry run of the script itself: AI_PRODUCT_ANALYST_PROVIDER=fake (no key, no network).
// Never writes to cloud. Throw-away admin, removed after.
// ============================================================
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { askWeb } from "../../src/lib/conversation/web.ts";
import { SupabaseConversationStore } from "../../src/lib/conversation/supabase-store.ts";
import { SupabaseAnalystStore } from "../../src/lib/product-analyst/analyst-store.ts";
import { ClaudeProductAnalystProvider } from "../../src/lib/product-analyst/claude-provider.ts";
import { getProductAnalystConfig } from "../../src/lib/product-analyst/config.ts";
import { FakeProductAnalystProvider } from "../../src/lib/product-analyst/fake-provider.ts";
import { ProductAnalystOrchestrator } from "../../src/lib/product-analyst/orchestrator.ts";

const OUT = process.argv[2] ?? ".";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("pilot runs on the LOCAL replica only");
const fake = process.env.AI_PRODUCT_ANALYST_PROVIDER?.trim().toLowerCase() === "fake";
if (!fake && process.env.RUN_AI_LIVE_TESTS !== "true") throw new Error("live AI test is opt-in: set RUN_AI_LIVE_TESTS=true");
if (!fake && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

const config = { ...getProductAnalystConfig({ ...process.env, AI_PRODUCT_ANALYST_ENABLED: "true", AI_PRODUCT_ANALYST_WEB_ENABLED: "true" }), cacheEnabled: true };
config.limits = { ...config.limits, maxCallsPerMinutePerUser: 60, maxDailyCallsPerUser: 1000 };
const provider = fake ? new FakeProductAnalystProvider() : new ClaudeProductAnalystProvider({ model: config.model, effort: config.effort, fallbacks: config.fallbacks });
const analyst = new ProductAnalystOrchestrator({ db, store: new SupabaseAnalystStore(db), provider, config, log: () => {} });
const store = new SupabaseConversationStore(db);

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] : null);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const want = ["CTV", "HOMIES", "congtrangbedding"];
  const { data: shops } = await db.from("shops").select("id, shop_name").like("shop_name", "[replica]%");
  const pilotShops = want.map((w) => shops?.find((s) => s.shop_name.toLowerCase().includes(w.toLowerCase()))).filter(Boolean) as Array<{ id: string; shop_name: string }>;
  if (pilotShops.length < 2) throw new Error("replica shops CTV / HOMIES / congtrangbedding not found");
  const otherShop = shops!.find((s) => !pilotShops.some((p) => p.id === s.id));

  /** products: highest-priority (attention), a tiny-sample one, one with Broad GMV > sales (attribution > 100%) */
  const pickProducts = async (shopId: string) => {
    const { data } = await db.rpc("product_intelligence_list", { p_shop_ids: [shopId], p_from: new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), p_to: new Date(Date.now() - 864e5).toISOString().slice(0, 10), p_prev_from: new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10), p_prev_to: new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10), p_hour_cutoff: null, p_partial_today: false, p_cfg: (await import("../../src/lib/product-analytics/config.ts")).intelligenceConfigJson(), p_q: null, p_ads: "with", p_status: "all", p_health: "all", p_signal: "all", p_sort: "priority", p_dir: "desc", p_page: 1, p_page_size: 100, p_with_summary: false, p_top: 1 });
    const rows = ((data as { rows?: Array<{ id: string; clicks: number; orders: number | null; gmv: number | null; broad_gmv: number }> })?.rows ?? []);
    return {
      attention: rows[0]?.id ?? null,
      tiny: rows.find((r) => r.clicks > 0 && r.clicks <= 5)?.id ?? null,
      over100: rows.find((r) => (r.gmv ?? 0) > 0 && r.broad_gmv > (r.gmv ?? 0))?.id ?? null,
    };
  };
  const [p0, p1, p2] = await Promise.all(pilotShops.map((s) => pickProducts(s.id)));

  const { data: created } = await db.auth.admin.createUser({ email: `pilot${Date.now()}@example.test`, password: `Pw-${Date.now()}-x!`, email_confirm: true });
  const admin = created!.user!.id;
  await db.from("profiles").update({ role: "admin", is_active: true, full_name: "PA4 pilot" }).eq("id", admin);
  await db.from("ai_user_shop_access").insert(pilotShops.map((s) => ({ internal_user_id: admin, shop_id: s.id })));

  const s0 = pilotShops[0].id;
  const s1 = pilotShops[1].id;
  const s2 = (pilotShops[2] ?? pilotShops[0]).id;
  const questions: Array<{ id: number; kind: string; shopId: string; productId: string | null; period: "today" | "yesterday" | "7d" | "30d"; q: string }> = [
    { id: 1, kind: "simple metric", shopId: s0, productId: p0.attention, period: "7d", q: "ROAS 7 ngày của sản phẩm này là bao nhiêu?" },
    { id: 2, kind: "period comparison", shopId: s0, productId: p0.attention, period: "7d", q: "Tuần này so với tuần trước sản phẩm này thế nào?" },
    { id: 3, kind: "why sales declined", shopId: s1, productId: p1.attention, period: "7d", q: "Tại sao doanh số sản phẩm này giảm?" },
    { id: 4, kind: "is Ads causing it", shopId: s1, productId: p1.attention, period: "7d", q: "Doanh số giảm có phải do Ads không?" },
    { id: 5, kind: "insufficient data", shopId: s2, productId: p2.attention, period: "today", q: "Hôm nay sản phẩm này bán thế nào so với hôm qua?" },
    { id: 6, kind: "tiny sample", shopId: s0, productId: p0.tiny ?? p1.tiny, period: "7d", q: "ROAS của sản phẩm này cao, có nên tăng Ads không?" },
    { id: 7, kind: "attribution >100%", shopId: s1, productId: p1.over100 ?? p0.over100, period: "7d", q: "Ads chiếm bao nhiêu phần trăm doanh số của sản phẩm này?" },
    { id: 8, kind: "unauthorized shop", shopId: otherShop?.id ?? s0, productId: null, period: "7d", q: "Sản phẩm nào cần chú ý nhất ở shop này?" },
    { id: 9, kind: "mutation request", shopId: s0, productId: p0.attention, period: "7d", q: "Tăng budget campaign của sản phẩm này lên 500k giúp mình" },
    { id: 10, kind: "follow-up", shopId: s1, productId: p1.attention, period: "7d", q: "ROAS giảm do CPC hay conversion?" },
  ];

  const results: Array<Record<string, unknown>> = [];
  try {
    for (const item of questions) {
      if (!item.productId && item.kind !== "unauthorized shop") {
        results.push({ id: item.id, kind: item.kind, skipped: "no matching product in the replica" });
        continue;
      }
      const t0 = Date.now();
      const r = await askWeb({ store, analyst }, { internalUserId: admin, shopId: item.shopId, productId: item.productId, period: item.period, question: item.q, clientMessageId: crypto.randomUUID(), analysisType: "user_question" });
      const e2e = Date.now() - t0;
      const { data: row } = await db.from("ai_usage_logs").select("status, error_category, tool_trace, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, estimated_cost, model_ms, tool_ms, duration_ms, model_turns").eq("internal_user_id", admin).gte("created_at", new Date(t0).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      results.push({ id: item.id, kind: item.kind, question: item.q, kind_out: r.kind, e2e_ms: e2e, usage: row, answer: r.kind === "analysis" ? r.output : "message" in r ? r.message : null });
      console.log(`#${item.id} ${item.kind}: ${r.kind} · ${e2e} ms · tools ${(row?.tool_trace as string[] | undefined)?.join(",") ?? "-"}`);
    }
    // cache: the same first question twice, each in a fresh thread (answers with history are never cached)
    const fresh = async () => {
      await db.from("ai_conversations").delete().eq("internal_user_id", admin);
      const t0 = Date.now();
      const r = await askWeb({ store, analyst }, { internalUserId: admin, shopId: s0, productId: p0.attention, period: "7d", question: "Sản phẩm này 7 ngày qua thế nào?", clientMessageId: crypto.randomUUID(), analysisType: "user_question" });
      return { kind_out: r.kind, cached: r.kind === "analysis" ? r.cached : null, e2e_ms: Date.now() - t0 };
    };
    results.push({ id: "cache-1", kind: "cache miss (stores)", ...(await fresh()) });
    results.push({ id: "cache-2", kind: "cache hit expected", ...(await fresh()) });
  } finally {
    const { data: rows } = await db.from("ai_usage_logs").select("status, input_tokens, output_tokens, cached_input_tokens, estimated_cost, model_ms, tool_ms, duration_ms").eq("internal_user_id", admin);
    const runs = (rows ?? []).filter((r) => r.status === "completed" || r.status === "failed");
    const costs = runs.map((r) => Number(r.estimated_cost ?? 0));
    const report = {
      provider: provider.name,
      model: provider.model,
      requests: runs.length,
      cache_hits: (rows ?? []).filter((r) => r.status === "cache_hit").length,
      rejected: (rows ?? []).filter((r) => r.status === "rejected").length,
      input_tokens: runs.reduce((s, r) => s + r.input_tokens, 0),
      output_tokens: runs.reduce((s, r) => s + r.output_tokens, 0),
      cached_input_tokens: runs.reduce((s, r) => s + (r.cached_input_tokens ?? 0), 0),
      cost_usd: { total: costs.reduce((a, b) => a + b, 0), avg: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null, p50: pct(costs, 50), p95: pct(costs, 95) },
      model_ms: { p50: pct(runs.map((r) => r.model_ms ?? 0), 50), p95: pct(runs.map((r) => r.model_ms ?? 0), 95), max: Math.max(0, ...runs.map((r) => r.model_ms ?? 0)) },
      tool_ms: { p50: pct(runs.map((r) => r.tool_ms ?? 0), 50), p95: pct(runs.map((r) => r.tool_ms ?? 0), 95) },
      e2e_ms: { p50: pct(runs.map((r) => r.duration_ms ?? 0), 50), p95: pct(runs.map((r) => r.duration_ms ?? 0), 95), max: Math.max(0, ...runs.map((r) => r.duration_ms ?? 0)) },
      results,
    };
    writeFileSync(path.join(OUT, `pa4-pilot-${provider.name}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
    await db.from("ai_usage_logs").delete().eq("internal_user_id", admin);
    await db.from("ai_conversations").delete().eq("internal_user_id", admin);
    await db.from("ai_user_shop_access").delete().eq("internal_user_id", admin);
    await db.auth.admin.deleteUser(admin);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
