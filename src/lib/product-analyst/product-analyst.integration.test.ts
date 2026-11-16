// PRODUCT-ANALYTICS-4 — Product Analyst on the real LOCAL database with the
// production replica (scripts/shopee/product-analytics-replica.ts load … --facts=cloud).
// Real tools / authorization / usage log / cache; the model is the deterministic
// FakeProductAnalystProvider or a scripted provider. No network, no Anthropic call.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { zaloWebhookMac } from "../zalo/webhook.ts";
import { handleZaloWebhookRequest, SenderRateLimiter, type ZaloWebhookConfig } from "../zalo/webhook-handler.ts";
import { acceptIncomingMessage, generateLinkCode, processAcceptedMessage, type ConversationDeps } from "../conversation/service.ts";
import { SupabaseConversationStore } from "../conversation/supabase-store.ts";
import { askWeb } from "../conversation/web.ts";
import { SupabaseAnalystStore } from "./analyst-store.ts";
import { getProductAnalystConfig, type ProductAnalystConfig } from "./config.ts";
import type { AnalystOutput, ProductAnalystRequest } from "./contracts.ts";
import { FakeProductAnalystProvider } from "./fake-provider.ts";
import { ProductAnalystOrchestrator } from "./orchestrator.ts";
import { AnalystProviderError, emptyUsage, type AnalystRunInput, type AnalystRunResult, type ProductAnalystProvider } from "./provider.ts";
import { ANALYST_TOOLS, executeAnalystTool, rawDataViolations } from "./tools.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (.env.local)");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
// needs real data shapes: skip (with the reason) when the replica is not loaded
const { count: replicaShops } = await db.from("shops").select("id", { count: "exact", head: true }).like("shop_name", "[replica]%");
const SKIP = (replicaShops ?? 0) < 2 ? "production replica not loaded (scripts/shopee/product-analytics-replica.ts load <dir> --facts=cloud)" : false;
const it = (name: string, fn: () => Promise<void>) => test(name, { skip: SKIP }, fn);

const TAG = Date.now();
const users: string[] = [];
let admin = "";
let staff = "";
let shopA = ""; // granted
let shopB = ""; // not granted
let productA = ""; // in shop A, with sales + Ads
let productAItem = "";
let productB = ""; // in shop B
const facts: Record<string, unknown> = {};

const baseConfig = (over: Partial<ProductAnalystConfig["limits"]> = {}): ProductAnalystConfig => {
  const c = getProductAnalystConfig({ AI_PRODUCT_ANALYST_ENABLED: "true", AI_PRODUCT_ANALYST_ZALO_ENABLED: "true", AI_PRODUCT_ANALYST_WEB_ENABLED: "true", AI_PRODUCT_ANALYST_PROVIDER: "fake" });
  return { ...c, limits: { ...c.limits, maxCallsPerMinutePerUser: 60, maxDailyCallsPerUser: 1000, ...over } };
};
const silent = () => {};
const orchestrator = (provider: ProductAnalystProvider = new FakeProductAnalystProvider(), config = baseConfig()) => new ProductAnalystOrchestrator({ db, store: new SupabaseAnalystStore(db), provider, config, log: silent });
const req = (over: Partial<ProductAnalystRequest> = {}): ProductAnalystRequest => ({
  channel: "web",
  conversationId: null,
  internalUserId: admin,
  shopId: shopA,
  productId: productA,
  productQuery: null,
  intent: "PRODUCT_ANALYSIS",
  period: "last_30_days",
  question: `Tại sao doanh số giảm? ${TAG}-${Math.random()}`,
  history: [],
  analysisType: "user_question",
  ...over,
});
async function usageRows(userId = admin) {
  const { data } = await db.from("ai_usage_logs").select("status, error_category, tool_trace, tool_calls, input_tokens, output_tokens, estimated_cost, product_id, channel, model_turns, duration_ms").eq("internal_user_id", userId).order("created_at");
  return data ?? [];
}

async function makeUser(name: string, role: "admin" | "staff"): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email: `pa4+${TAG}-${name}@example.test`, password: `Pw-${TAG}-x!`, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser");
  users.push(data.user.id);
  await db.from("profiles").update({ role, is_active: true }).eq("id", data.user.id);
  return data.user.id;
}

before(async () => {
  if (SKIP) return;
  const { data: shops } = await db.from("shops").select("id, shop_name").like("shop_name", "[replica]%").eq("is_active", true).order("shop_name");
  if (!shops || shops.length < 2) throw new Error("load the replica first: scripts/shopee/product-analytics-replica.ts load <dir> --facts=cloud");
  // the shop with the most products that have sales facts → A; another → B
  const counts = await Promise.all(shops.map(async (s) => ({ ...s, n: (await db.from("shopee_product_sales_facts").select("id", { count: "exact", head: true }).eq("shop_id", s.id)).count ?? 0 })));
  counts.sort((a, b) => b.n - a.n);
  shopA = counts[0].id;
  shopB = counts[1].id;
  // a product of A with both sales facts and a single-item campaign
  const { data: links } = await db.from("shopee_ads_campaign_products").select("provider_item_id").eq("shop_id", shopA).limit(500);
  const { data: sold } = await db.from("shopee_product_sales_facts").select("provider_item_id").eq("shop_id", shopA).order("report_date", { ascending: false }).limit(2000);
  const soldSet = new Set((sold ?? []).map((r) => String(r.provider_item_id)));
  const item = (links ?? []).map((l) => String(l.provider_item_id)).find((i) => soldSet.has(i)) ?? [...soldSet][0];
  const { data: pa } = await db.from("shopee_products").select("id, provider_item_id").eq("shop_id", shopA).eq("provider_item_id", item).single();
  productA = pa!.id;
  productAItem = pa!.provider_item_id;
  const { data: pb } = await db.from("shopee_products").select("id").eq("shop_id", shopB).limit(1).single();
  productB = pb!.id;
  admin = await makeUser("admin", "admin");
  staff = await makeUser("staff", "staff");
  await db.from("ai_user_shop_access").insert([
    { internal_user_id: admin, shop_id: shopA },
    { internal_user_id: staff, shop_id: shopA },
  ]);
});

after(async () => {
  if (SKIP) return;
  await db.from("ai_usage_logs").delete().in("internal_user_id", users);
  await db.from("ai_analysis_cache").delete().in("shop_id", [shopA, shopB]);
  await db.from("ai_conversations").delete().in("internal_user_id", users);
  await db.from("ai_conversations").delete().in("external_user_id", [ZALO_A, ZALO_X, ...users]);
  await db.from("zalo_user_links").delete().in("zalo_user_id", [ZALO_A, ZALO_X]);
  await db.from("zalo_link_codes").delete().in("internal_user_id", users);
  await db.from("ai_user_shop_access").delete().in("internal_user_id", users);
  for (const id of users) await db.auth.admin.deleteUser(id);
  console.log(JSON.stringify({ pa4_integration_facts: facts }));
});

// ------------------------------------------------------------------ tools on real data

it("PA4 §9 §32 §107: every tool on real replica products — authorized, aggregated, ≤ 6 KB, no raw data", async () => {
  const { data: top } = await db.from("shopee_products").select("id").eq("shop_id", shopA).limit(4);
  const sizes: Record<string, number[]> = {};
  for (const p of [productA, ...(top ?? []).map((r) => r.id as string)]) {
    let diagnosis = 0;
    for (const t of ANALYST_TOOLS) {
      const r = await executeAnalystTool(t.name, t.name === "get_product_baseline" ? { days: 28 } : { period: "30d" }, { db, internalUserId: admin, shopId: shopA, productId: p, contextPeriod: { preset: "30d" }, now: new Date(), maxBytes: 6144 });
      assert.ok(r.ok, `${t.name}: ${r.ok ? "" : r.code}`);
      if (!r.ok) continue;
      assert.ok(r.bytes <= 6144, `${t.name} ${r.bytes} B`);
      assert.deepEqual(rawDataViolations(r.data), [], `${t.name}: raw data`);
      assert.doesNotMatch(r.content, /buyer|order_sn|recipient|access_token|"payload"/i);
      (sizes[t.name] ??= []).push(r.bytes);
      if (["get_product_overview", "get_product_signals", "compare_product_periods", "get_product_ads_performance"].includes(t.name)) diagnosis += r.bytes;
    }
    (sizes.diagnosis_4_tools ??= []).push(diagnosis);
  }
  facts.tool_bytes_max = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, Math.max(...v)]));
  assert.ok((facts.tool_bytes_max as Record<string, number>).diagnosis_4_tools <= 16_000);
});

// ------------------------------------------------------------------ authorization (spec §10–11, §105)

it("PA4 §10 §105: authorization on every request — allowed, other shop, product of another shop, inactive, role, allowlist", async () => {
  let runs = 0;
  const spy: ProductAnalystProvider = { name: "fake", model: "fake-analyst", run: async (i) => (runs++, new FakeProductAnalystProvider().run(i)) };
  const o = orchestrator(spy);
  const ok = await o.analyze(req());
  assert.equal(ok.kind, "analysis", JSON.stringify(ok).slice(0, 300));
  assert.equal(runs, 1);

  assert.deepEqual(pick(await o.analyze(req({ shopId: shopB, productId: productB }))), ["error", "AUTH_DENIED"], "shop not granted");
  assert.deepEqual(pick(await o.analyze(req({ shopId: shopA, productId: productB }))), ["error", "PRODUCT_NOT_FOUND"], "product of another shop");
  assert.deepEqual(pick(await o.analyze(req({ internalUserId: staff }))), ["error", "AUTH_DENIED"], "role outside the rollout");
  await db.from("profiles").update({ is_active: false }).eq("id", admin);
  assert.deepEqual(pick(await o.analyze(req())), ["error", "AUTH_DENIED"], "inactive user");
  await db.from("profiles").update({ is_active: true }).eq("id", admin);
  const allowlisted = orchestrator(spy, { ...baseConfig(), allowedUserIds: [staff] });
  assert.deepEqual(pick(await allowlisted.analyze(req())), ["error", "AUTH_DENIED"], "not in AI_PRODUCT_ANALYST_ALLOWED_USER_IDS");
  assert.equal(runs, 1, "the model never ran for a denied request");
  // a tool call with a tampered scope is refused by the backend, not by the model
  const tampered = await executeAnalystTool("get_product_overview", { period: "7d" }, { db, internalUserId: admin, shopId: shopA, productId: productB, contextPeriod: { preset: "7d" }, now: new Date(), maxBytes: 6144 });
  assert.equal(!tampered.ok && tampered.code, "PRODUCT_NOT_FOUND");
  const rejected = (await usageRows()).filter((r) => r.status === "rejected").map((r) => r.error_category);
  assert.ok(rejected.includes("AUTH_DENIED") && rejected.includes("PRODUCT_NOT_FOUND"), "denials are logged");
});

const pick = (r: Awaited<ReturnType<ProductAnalystOrchestrator["analyze"]>>) => [r.kind, r.kind === "error" ? r.category : null];

// ------------------------------------------------------------------ usage log + cache (spec §62–66, §74)

it("PA4 §62 §64–66 §74: usage row per analysis (tokens, tool trace, no text); cache hit; cache never bypasses authorization", async () => {
  await db.from("ai_usage_logs").delete().eq("internal_user_id", admin);
  const o = orchestrator();
  const q = req({ question: `Ads sản phẩm này thế nào ${TAG}` });
  const first = await o.analyze(q);
  assert.equal(first.kind, "analysis");
  const second = await o.analyze(q);
  assert.ok(second.kind === "analysis" && second.meta.cached, "identical question + unchanged data → cache");
  const rows = await usageRows();
  assert.deepEqual(rows.map((r) => r.status), ["completed", "cache_hit"]);
  assert.ok(rows[0].tool_calls >= 1 && rows[0].tool_trace.length === rows[0].tool_calls && rows[0].input_tokens > 0 && rows[0].model_turns >= 1);
  assert.equal(rows[0].product_id, productA);
  const { data: cols } = await db.from("ai_usage_logs").select("*").eq("internal_user_id", admin).limit(1).single();
  assert.ok(!Object.keys(cols!).some((k) => /prompt$|question|answer|text|content/.test(k)), "no prompt / answer text stored");
  // revoke the grant: the SAME cached question is now denied
  await db.from("ai_user_shop_access").delete().eq("internal_user_id", admin).eq("shop_id", shopA);
  assert.deepEqual(pick(await o.analyze(q)), ["error", "AUTH_DENIED"]);
  await db.from("ai_user_shop_access").insert({ internal_user_id: admin, shop_id: shopA });
  facts.first_analysis = { tools: rows[0].tool_trace, input_tokens: rows[0].input_tokens, output_tokens: rows[0].output_tokens, duration_ms: rows[0].duration_ms };
});

// ------------------------------------------------------------------ limits (spec §31 §68 §69 §101)

it("PA4 §68 §69 §101: per-minute, concurrent and daily-cost limits answer with a friendly message", async () => {
  await db.from("ai_usage_logs").delete().eq("internal_user_id", admin);
  const o = orchestrator(new FakeProductAnalystProvider(), baseConfig({ maxCallsPerMinutePerUser: 2 }));
  assert.equal((await o.analyze(req())).kind, "analysis");
  assert.equal((await o.analyze(req())).kind, "analysis");
  const third = await o.analyze(req());
  assert.deepEqual(pick(third), ["error", "LIMIT_REACHED"]);
  assert.match((third as { message: string }).message, /một phút/);

  await db.from("ai_usage_logs").delete().eq("internal_user_id", admin);
  const base = { provider: "fake", model: "fake-analyst", prompt_version: "pa4-v1", channel: "web", internal_user_id: admin, analysis_type: "user_question" };
  await db.from("ai_usage_logs").insert({ ...base, status: "running" });
  assert.match(((await orchestrator().analyze(req())) as { message: string }).message, /câu hỏi trước/, "one active analysis per user");
  await db.from("ai_usage_logs").delete().eq("internal_user_id", admin);
  await db.from("ai_usage_logs").insert({ ...base, status: "completed", estimated_cost: 99 });
  assert.match(((await orchestrator().analyze(req())) as { message: string }).message, /giới hạn chi phí/);
  await db.from("ai_usage_logs").delete().eq("internal_user_id", admin);
});

// ------------------------------------------------------------------ guards end to end (spec §18 §61 §72 §73 §108)

/** Plays a model that answers with fixed outputs (first, then the repair). */
function scripted(outputs: unknown[], opts: { throws?: AnalystProviderError } = {}): ProductAnalystProvider {
  return {
    name: "scripted",
    model: "fake-analyst",
    async run(input: AnalystRunInput): Promise<AnalystRunResult> {
      if (opts.throws) throw opts.throws;
      const toolTrace: string[] = [];
      await input.executeTool("get_product_ads_performance", { period: "context" });
      toolTrace.push("get_product_ads_performance");
      let repaired = false;
      for (const raw of outputs) {
        const v = input.check(raw);
        if (v.ok) return { status: "completed", raw, usage: emptyUsage(), modelTurns: 2, toolCalls: 1, toolTrace, modelMs: 1, toolMs: 1, repaired };
        repaired = true;
      }
      return { status: "invalid_output", raw: outputs.at(-1), usage: emptyUsage(), modelTurns: 3, toolCalls: 1, toolTrace, modelMs: 1, toolMs: 1, repaired };
    },
  };
}
const answer = (summary: string): AnalystOutput => ({ summary, data_quality_note: null, findings: [], hypotheses: [], evidence: [], confidence: "LOW", missing_data: [], suggested_checks: [], follow_up_context: { topic: null } });

it("PA4 §18 §61 §72 §73 §108: Ads-share / organic / invented numbers never reach the user; provider errors are categorized", async () => {
  for (const bad of ["Ads tạo ra 500% doanh thu của sản phẩm.", "Doanh số organic âm vì Broad GMV lớn hơn doanh số.", "Doanh số giảm 37,7% trong kỳ."]) {
    const r = await orchestrator(scripted([answer(bad), answer(bad)])).analyze(req());
    assert.deepEqual(pick(r), ["error", "OUTPUT_INVALID"], bad);
    assert.match((r as { message: string }).message, /chưa phân tích được/);
  }
  const fixed = await orchestrator(scripted([answer("Ads tạo ra 500% doanh thu."), answer("Chỉ báo Ads attribution / tổng doanh số có thể vượt 100% và không phải tỉ trọng doanh số do Ads.")])).analyze(req());
  assert.equal(fixed.kind, "analysis", "one repair turn is allowed");
  const limited = await orchestrator(scripted([], { throws: new AnalystProviderError("AI_RATE_LIMIT", "rate_limited") })).analyze(req());
  assert.deepEqual(pick(limited), ["error", "AI_RATE_LIMIT"]);
  assert.doesNotMatch((limited as { message: string }).message, /429|rate_limited|Error/);
  const rows = await usageRows();
  assert.ok(rows.some((r) => r.status === "failed" && r.error_category === "OUTPUT_INVALID") && rows.some((r) => r.error_category === "AI_RATE_LIMIT"));
});

// ------------------------------------------------------------------ Zalo E2E (spec §114) — signed webhook → service → orchestrator(fake) → outbound

const APP = "4343434343";
const SECRET = "pa4-oa-secret";
const OA = "9090";
const zcfg: ZaloWebhookConfig = { enabled: true, appId: APP, oaSecretKey: SECRET, oaId: OA };
const ZALO_A = `86${TAG}`.slice(0, 16);
const ZALO_X = `87${TAG}`.slice(0, 16);
const sent: Array<{ to: string; text: string }> = [];
let seq = 0;

function zaloDeps(provider: ProductAnalystProvider = new FakeProductAnalystProvider()): ConversationDeps {
  return { store: new SupabaseConversationStore(db), analyst: orchestrator(provider), sender: { sendText: async (to, text) => (sent.push({ to, text }), { ok: true, providerMessageId: `out-${TAG}-${sent.length}` }) } };
}
async function deliver(deps: ConversationDeps, sender: string, text: string, msgId = `pa4-${TAG}-${++seq}`) {
  const now = new Date();
  const raw = JSON.stringify({ app_id: APP, event_name: "user_send_text", timestamp: String(now.getTime()), sender: { id: sender }, recipient: { id: OA }, message: { msg_id: msgId, text } });
  const outcome = await handleZaloWebhookRequest({ rawBody: raw, signatureHeader: `mac=${zaloWebhookMac(APP, raw, String(now.getTime()), SECRET)}`, config: zcfg, now }, { accept: (m) => acceptIncomingMessage(deps, m), limiter: new SenderRateLimiter() });
  return { outcome, result: "accepted" in outcome ? await processAcceptedMessage(deps, outcome.accepted) : null };
}

it("PA4 §114: Zalo — unknown user (no AI), LINK, analysis, follow-up context, ambiguous / unknown product, other shop, mutation, duplicate, provider error", async () => {
  await db.from("ai_usage_logs").delete().eq("internal_user_id", admin);
  const deps = zaloDeps();
  const store = deps.store as SupabaseConversationStore;

  assert.equal((await deliver(deps, ZALO_X, `sản phẩm ${productAItem} 30 ngày`)).result, "unlinked");
  const code = generateLinkCode(new Date());
  await store.createLinkCode({ codeHash: code.codeHash, internalUserId: admin, createdBy: admin, expiresAt: code.expiresAt });
  assert.equal((await deliver(deps, ZALO_A, `LINK ${code.code}`)).result, "linked");
  assert.equal((await usageRows()).length, 0, "linking and unknown users never reach the analyst");

  const first = await deliver(deps, ZALO_A, `Tại sao sản phẩm ${productAItem} 30 ngày giảm doanh số?`, `pa4-dup-${TAG}`);
  assert.equal(first.result, "analysis");
  const reply = sent.filter((s) => s.to === ZALO_A).slice(-3).map((s) => s.text).join("\n");
  assert.match(reply, /Kết luận:/);
  assert.doesNotMatch(reply, /[{}]|get_product|tool/);
  const dup = await deliver(deps, ZALO_A, `Tại sao sản phẩm ${productAItem} 30 ngày giảm doanh số?`, `pa4-dup-${TAG}`);
  assert.deepEqual(dup.outcome.body, { ok: true, ignored: "duplicate" });
  assert.equal((await usageRows()).length, 1, "duplicate event → one analysis");

  assert.equal((await deliver(deps, ZALO_A, "còn hôm qua?")).result, "analysis", "follow-up");
  const rows = await usageRows();
  assert.equal(rows.at(-1)!.product_id, productA, "follow-up reused the product from context");
  assert.equal(rows.at(-1)!.channel, "zalo");

  assert.equal((await deliver(deps, ZALO_A, "sản phẩm thảm 7 ngày")).result, "clarify_product");
  assert.match(sent.at(-1)!.text, /Có nhiều sản phẩm khớp/);
  assert.equal((await deliver(deps, ZALO_A, "sản phẩm khongtontai zzqx tuần này")).result, "product_not_found");

  const { data: shopBRow } = await db.from("shops").select("shop_name").eq("id", shopB).single();
  assert.equal((await deliver(deps, ZALO_A, `Shop ${shopBRow!.shop_name} hôm qua thế nào?`)).result, "shop_denied");

  const before = (await usageRows()).length;
  assert.equal((await deliver(deps, ZALO_A, "Tăng budget chiến dịch lên 500k giúp mình")).result, "mutation_refused");
  assert.equal((await usageRows()).length, before, "a change request costs no analysis");

  const broken = zaloDeps(scripted([], { throws: new AnalystProviderError("AI_PROVIDER_ERROR", "status_500") }));
  assert.equal((await deliver(broken, ZALO_A, `sản phẩm ${productAItem} tuần này sao?`)).result, "analysis_failed");
  assert.match(sent.at(-1)!.text, /Mình chưa phân tích được dữ liệu lúc này/);
  assert.doesNotMatch(sent.at(-1)!.text, /status_500|Error|stack/i);
  facts.zalo_messages_sent = sent.filter((s) => s.to === ZALO_A).length;
});

it("PA4 §80 §81 §115: web channel — own thread, grant re-checked, double submit analysed once, structured answer stored", async () => {
  const store = new SupabaseConversationStore(db);
  const analyst = orchestrator();
  const id = crypto.randomUUID();
  const q = { internalUserId: admin, shopId: shopA, productId: productA, period: "30d" as const, question: "Ads của sản phẩm này thế nào?", clientMessageId: id, analysisType: "user_question" as const };
  const r = await askWeb({ store, analyst }, q);
  assert.equal(r.kind, "analysis", JSON.stringify(r).slice(0, 200));
  assert.equal((await askWeb({ store, analyst }, q)).kind, "duplicate");
  const { data: conv } = await db.from("ai_conversations").select("id, channel").eq("channel", "web").eq("external_user_id", admin).single();
  const msgs = await store.threadMessages(conv!.id, 10);
  assert.equal(msgs.filter((m) => m.direction === "outbound").length, 1);
  assert.ok(msgs.at(-1)!.analysis?.summary, "validated structured answer stored for re-render");
  const { count: zaloMixed } = await db.from("ai_messages").select("id", { count: "exact", head: true }).eq("conversation_id", conv!.id).eq("channel", "zalo");
  assert.equal(zaloMixed, 0, "web and Zalo threads are not merged");
  assert.equal((await askWeb({ store, analyst }, { ...q, shopId: shopB, productId: productB, clientMessageId: crypto.randomUUID() })).kind, "denied");
});
