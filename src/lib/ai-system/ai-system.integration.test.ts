// ============================================================
// PHASE 05 — integration tests against the LOCAL Supabase (00001 → 00077).
// Real tools on real SQL views / RPCs (receipts, v_outstanding, debt views,
// payments, product intelligence, Ads tables), the real SupabaseSystemStore
// (audit, shared budget, identity linking) and the fake model (no network).
// Business fixtures are dated 2035 so nothing else falls into the ranges.
// Run: node --env-file=.env.local --test src/lib/ai-system/ai-system.integration.test.ts
// ============================================================
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getAiConfig } from "../ai-assistant/config.ts";
import { FakeAiProvider } from "../ai-assistant/fake-provider.ts";
import { hashLinkCode } from "../conversation/service.ts";
import { calculateInvoiceFinancials } from "../invoices/financials.ts";
import { askSystemAssistant, type AssistantDeps } from "./assistant.ts";
import { answerThroughChannel, personalAdapter, webAdapter } from "./channels.ts";
import { getSystemAssistantConfig } from "./config.ts";
import { systemDemoScript } from "./fake-script.ts";
import { issuePersonalLinkCode, linkPersonalIdentity, resolvePersonalIdentity } from "./identity.ts";
import { SupabaseSystemStore } from "./supabase-store.ts";
import { createDefaultRegistry } from "./tools/index.ts";
import type { InternalActor, ToolContext, ToolResult } from "./types.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (never production)");
const db: SupabaseClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const anon: SupabaseClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
const store = new SupabaseSystemStore(db);
const registry = createDefaultRegistry();

const RUN = randomBytes(3).toString("hex");
const NOW = new Date("2035-05-10T05:00:00Z"); // 12:00 VN
const DAY = "2035-05-10";
const PASSWORD = `Pw-${randomBytes(8).toString("hex")}`;
const users = { admin: "", staff: "", viewer: "", off: "" };
const ids = { s1: "", s2: "", p1: "", p2: "", inv: "", shop: "", shop2: "", conn: "" };
const S1 = `AI5 An Phát ${RUN}`;
const S2 = `AI5 Bình Minh ${RUN}`;
const INV = `AI5-HD-${RUN}`;

const actor = (k: keyof typeof users, role: InternalActor["role"]): InternalActor => ({ userId: users[k], role, active: true });
const toolCtx = (a: InternalActor, over: Partial<ToolContext> = {}): ToolContext => ({ db, actor: a, now: NOW, maxRows: 20, flags: { adsRealData: false }, signal: new AbortController().signal, ...over });
const run = (name: string, args: unknown, a: InternalActor, over: Partial<ToolContext> = {}): Promise<ToolResult> => {
  const def = registry.get(name)!;
  const v = def.input.safeParse(args);
  if (!v.success) throw new Error(`bad args for ${name}: ${v.error.message}`);
  return def.run(v.data, toolCtx(a, over));
};

function deps(over: Partial<AssistantDeps> = {}): AssistantDeps {
  const aiConfig = getAiConfig({ AI_ENABLED: "false", NODE_ENV: "test" });
  return {
    db,
    store,
    registry,
    aiConfig,
    config: getSystemAssistantConfig({ AI_SYSTEM_ASSISTANT_ENABLED: "true", AI_SYSTEM_PERSONAL_DRAFTS_ENABLED: "true", AI_SYSTEM_REQUESTS_PER_MINUTE: "60" }),
    flags: { adsRealData: false },
    provider: () => new FakeAiProvider(systemDemoScript, "fake-int"),
    now: () => NOW,
    sleep: async () => {},
    ...over,
  };
}

async function createUser(key: keyof typeof users, role: "admin" | "staff" | "viewer", active = true) {
  const { data, error } = await db.auth.admin.createUser({ email: `ai5-${key}-${RUN}@example.test`, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${error?.message}`);
  await db.from("profiles").update({ is_active: active, role, full_name: `AI5 ${key}` }).eq("id", data.user.id);
  users[key] = data.user.id;
}

async function supplier(name: string, code: string) {
  const { data, error } = await db.from("suppliers").insert({ code, name, supplier_type: "business_household" }).select("id").single();
  if (error) throw error;
  return data.id as string;
}
async function product(supplierId: string, sku: string) {
  const { data, error } = await db.from("products").insert({ sku, name: `Ga gối ${sku}`, unit: "bộ", current_price: 1000, supplier_id: supplierId }).select("id").single();
  if (error) throw error;
  return data.id as string;
}
async function receipt(supplierId: string, productId: string, date: string, delivered: number, received: number) {
  const { error } = await db.rpc("create_receipt", { p_receipt_date: date, p_shift: "morning", p_supplier_id: supplierId, p_receiver_name: `AI5 ${RUN}`, p_note: null, p_created_by: null, p_items: [{ product_id: productId, unit_price: 1000, delivered_qty: delivered, received_qty: received }] });
  if (error) throw new Error(error.message);
}

before(async () => {
  await createUser("admin", "admin");
  await createUser("staff", "staff");
  await createUser("viewer", "viewer");
  await createUser("off", "admin", false);
  ids.s1 = await supplier(S1, `AI5A${RUN}`);
  ids.s2 = await supplier(S2, `AI5B${RUN}`);
  ids.p1 = await product(ids.s1, `AI5P1${RUN}`);
  ids.p2 = await product(ids.s2, `AI5P2${RUN}`);
  // invoice: 10 × 1.000 (household, no VAT) = 10.000; 4 received; 3.000 paid
  const fin = calculateInvoiceFinancials({ supplierType: "business_household", items: [{ quantity: 10, unitPrice: 1000 }], discountType: null, discountValue: null, vatRate: null });
  if (!fin.ok) throw new Error("financials");
  const inv = await db.rpc("create_invoice", { p_supplier_id: ids.s1, p_invoice_no: INV, p_invoice_date: "2035-05-09", p_note: null, p_created_by: null, p_items: [{ product_id: ids.p1, unit_price: 1000, quantity: 10 }], p_subtotal: fin.data.subtotal, p_discount_type: fin.data.discountType, p_discount_value: fin.data.discountValue, p_discount_amount: fin.data.discountAmount, p_vat_rate: fin.data.vatRate, p_vat_amount: fin.data.vatAmount, p_final_amount: fin.data.finalAmount });
  if (inv.error) throw new Error(inv.error.message);
  ids.inv = inv.data[0].invoice_id;
  await receipt(ids.s1, ids.p1, DAY, 5, 4);
  const pay = await db.rpc("create_payment", { p_supplier_id: ids.s1, p_payment_date: DAY, p_note: `AI5 ${RUN}`, p_created_by: null, p_items: [{ invoice_id: ids.inv, amount: 3000 }] });
  if (pay.error) throw new Error(pay.error.message);
  // 25 receiving days for S2 → a result set larger than the row limit
  for (let i = 0; i < 25; i++) await receipt(ids.s2, ids.p2, `2035-04-${String(i + 1).padStart(2, "0")}`, 2, 2);
  // Shopee fixture shops (no sales data) + an AI grant for the admin on shop 1 only
  const sh = await db.from("shops").insert([{ channel: "shopee", external_shop_id: `FIXTURE_AI5_${RUN}_1`, shop_name: `AI5 Shop Một ${RUN}`, currency: "VND", data_source: "fixture" }, { channel: "shopee", external_shop_id: `FIXTURE_AI5_${RUN}_2`, shop_name: `AI5 Shop Hai ${RUN}`, currency: "VND", data_source: "fixture" }]).select("id, shop_name");
  if (sh.error) throw sh.error;
  ids.shop = sh.data.find((s) => s.shop_name.includes("Một"))!.id;
  ids.shop2 = sh.data.find((s) => s.shop_name.includes("Hai"))!.id;
  await db.from("ai_user_shop_access").insert([{ internal_user_id: users.admin, shop_id: ids.shop }, { internal_user_id: users.staff, shop_id: ids.shop }]);
  const c = await db.from("zalo_personal_connections").insert({ connection_key: `ai5-${RUN}`, owner_user_id: users.admin }).select("id").single();
  if (c.error) throw c.error;
  ids.conn = c.data.id;
});

after(async () => {
  const uids = Object.values(users).filter(Boolean);
  if (uids.length) {
    await db.from("ai_system_requests").delete().in("user_id", uids);
    await db.from("ai_request_usage").delete().in("user_id", uids);
    await db.from("ai_identity_link_codes").delete().in("internal_user_id", uids);
  }
  if (ids.conn) await db.from("zalo_personal_connections").delete().eq("id", ids.conn);
  for (const s of [ids.shop, ids.shop2].filter(Boolean)) {
    await db.from("shopee_ads_shop_daily_performance").delete().eq("shop_id", s);
    await db.from("shops").delete().eq("id", s);
  }
  await db.from("payments").delete().eq("note", `AI5 ${RUN}`);
  if (ids.inv) await db.from("invoices").delete().eq("id", ids.inv);
  await db.from("receipts").delete().eq("receiver_name", `AI5 ${RUN}`);
  const pids = [ids.p1, ids.p2].filter(Boolean);
  if (pids.length) {
    await db.from("inventory_cost_ledger").delete().in("product_id", pids);
    await db.from("products").delete().in("id", pids);
  }
  for (const s of [ids.s1, ids.s2].filter(Boolean)) await db.from("suppliers").delete().eq("id", s);
  for (const u of uids) await db.auth.admin.deleteUser(u);
});

// ================================================================== hàng về
describe("receiving tools (real views / RPCs)", () => {
  it("get_receiving_status: today's receipts with delivered / received / difference, manual-entry freshness", async () => {
    const r = await run("get_receiving_status", { supplier: S1 }, actor("staff", "staff"));
    assert.equal(r.outcome, "ok");
    const g = (r.data!.groups as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([g.date, g.delivered_qty, g.received_qty, g.difference_qty, g.received_value], ["10/05/2035", "5", "4", "-1", "4.000 ₫"]);
    assert.equal(r.source!.freshness, "manual_entry");
    assert.ok(r.source!.dataUpdatedAt, "last receipt time");
    assert.ok(r.caveats.some((c) => /ngày dự kiến/.test(c)), "says expected dates don't exist");
  });

  it("large result set: limited to maxRows, total reported", async () => {
    const r = await run("get_receiving_status", { supplier: S2, period: { preset: "custom", from: "2035-04-01", to: "2035-04-30" } }, actor("staff", "staff"), { maxRows: 10 });
    assert.equal(r.data!.total_groups, 25);
    assert.equal((r.data!.groups as unknown[]).length, 10);
    assert.match(r.lines[0]!, /25 lượt.*hiển thị 10/);
  });

  it("no data / not found / ambiguous", async () => {
    const empty = await run("get_receiving_status", { supplier: S1, period: { preset: "custom", from: "2035-01-01", to: "2035-01-31" } }, actor("staff", "staff"));
    assert.equal(empty.outcome, "empty");
    assert.equal((await run("get_receiving_status", { supplier: `không có ${RUN}` }, actor("staff", "staff"))).outcome, "not_found");
    assert.equal((await run("get_receiving_status", { supplier: `AI5 ${RUN}` }, actor("staff", "staff"))).outcome, "ambiguous");
  });

  it("get_outstanding_goods: invoice 10 − received 4 = 6 remaining (status from v_outstanding); by invoice no", async () => {
    const r = await run("get_outstanding_goods", { supplier: S1 }, actor("staff", "staff"));
    const line = (r.data!.lines as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([line.invoice, line.invoice_qty, line.received_qty, line.remaining_qty, line.remaining_value, line.status], [INV, "10", "4", "6", "6.000 ₫", "Sắp hết"]);
    const byInv = await run("get_outstanding_goods", { invoiceNo: INV.toLowerCase() }, actor("staff", "staff"));
    assert.equal(byInv.rowCount, 1);
    assert.equal((await run("get_outstanding_goods", { invoiceNo: `NOPE-${RUN}` }, actor("staff", "staff"))).outcome, "not_found");
    const direct = await db.from("v_outstanding").select("remaining_qty").eq("invoice_no", INV).single();
    assert.equal(Number(direct.data!.remaining_qty), 6, "same figure as the screen's view");
  });
});

// ================================================================== công nợ
describe("payables tools (same SQL as /debts, /payments)", () => {
  it("get_supplier_payables = v_supplier_debt_summary (10.000 − 3.000 = 7.000)", async () => {
    const r = await run("get_supplier_payables", { supplier: S1 }, actor("staff", "staff"));
    const totals = r.data!.totals as Record<string, unknown>;
    assert.deepEqual([totals.invoiced, totals.paid, totals.remaining, totals.open_invoices], ["10.000 ₫", "3.000 ₫", "7.000 ₫", 1]);
    const view = await db.from("v_supplier_debt_summary").select("supplier_remaining_total").eq("supplier_id", ids.s1).single();
    assert.equal(Number(view.data!.supplier_remaining_total), 7000);
    assert.ok(r.caveats.some((c) => /hạn thanh toán/.test(c)));
  });

  it("get_invoices: open = partial invoice with age; paid filter → empty", async () => {
    const open = await run("get_invoices", { supplier: S1, status: "open" }, actor("admin", "admin"));
    const inv = (open.data!.invoices as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([inv.invoice, inv.remaining, inv.status, inv.age_days], [INV, "7.000 ₫", "Thanh toán một phần", 1]);
    assert.equal((await run("get_invoices", { supplier: S1, status: "paid" }, actor("admin", "admin"))).outcome, "empty");
  });

  it("get_payment_summary: 3.000 ₫ on 10/05/2035", async () => {
    const r = await run("get_payment_summary", { supplier: S1, period: { preset: "today" } }, actor("admin", "admin"));
    assert.equal(r.data!.total, "3.000 ₫");
    assert.equal(r.data!.payments, 1);
  });
});

// ================================================================== Shopee
describe("Shopee tools (AI shop grants re-checked on every call)", () => {
  it("no grant → denied; staff with a grant → denied (AI Shopee rollout is admin-only, reused rule)", async () => {
    const r = await run("get_shopee_revenue", {}, actor("viewer", "viewer"));
    assert.equal(r.outcome, "denied");
    const s = await run("get_shopee_revenue", {}, actor("staff", "staff"));
    assert.equal(s.outcome, "denied");
    assert.match(s.message!, /quản trị/);
  });

  it("admin: a shop without a grant is refused by name; granted shop without sales data → empty, never 0", async () => {
    const other = await run("get_shopee_revenue", { shop: `AI5 Shop Hai ${RUN}` }, actor("admin", "admin"));
    assert.equal(other.outcome, "denied");
    const r = await run("get_shopee_revenue", { shop: `AI5 Shop Một ${RUN}` }, actor("admin", "admin"));
    assert.equal(r.outcome, "empty");
    assert.match(r.lines[0]!, /chưa có dữ liệu doanh số/);
    assert.ok(!/0 ₫/.test(r.lines.join(" ")), "missing ≠ zero");
  });

  it("Ads: off unless real data is enabled; with rows → totals + derived ratios from the shop table", async () => {
    const off = await run("get_shopee_ads_performance", { shop: `AI5 Shop Một ${RUN}` }, actor("admin", "admin"));
    assert.equal(off.outcome, "unavailable");
    const ins = await db.from("shopee_ads_shop_daily_performance").insert({ shop_id: ids.shop, report_date: DAY, last_synced_at: NOW.toISOString(), expense: 200000, impression: 10000, clicks: 400, direct_order: 5, broad_order: 8, direct_gmv: 600000, broad_gmv: 1000000 });
    assert.equal(ins.error, null, ins.error?.message);
    const r = await run("get_shopee_ads_performance", { shop: `AI5 Shop Một ${RUN}` }, actor("admin", "admin"), { flags: { adsRealData: true } });
    assert.equal(r.outcome, "ok");
    assert.deepEqual([r.data!.spend, r.data!.clicks, r.data!.cpc, r.data!.broad_gmv, r.data!.broad_roas, r.data!.ctr], ["200.000 ₫", "400", "500 ₫", "1.000.000 ₫", "5", "4%"]);
  });
});

// ================================================================== assistant end-to-end
describe("assistant end-to-end (real store, fake model)", () => {
  it("staff asks about supplier debt (AI off): formatter answer, cited, audited without text", async () => {
    const r = await askSystemAssistant(deps(), { identity: { status: "resolved", actor: actor("staff", "staff") }, channel: { channel: "web", audience: "private", conversationRef: null, constraints: { maxChars: 9000, canSend: false } }, question: "Hiện còn nợ nhà cung cấp bao nhiêu?" });
    assert.equal(r.status, "answered");
    assert.equal(r.sources[0]!.href, "/debts");
    const req = await db.from("ai_system_requests").select("*").eq("id", r.requestId!).single();
    assert.deepEqual([req.data!.status, req.data!.planner, req.data!.synthesis, req.data!.tools], ["answered", "rules", "formatter", ["get_supplier_payables"]]);
    assert.ok(!("question" in req.data!) && !("answer" in req.data!), "no text stored");
    const calls = await db.from("ai_system_tool_calls").select("tool, outcome, sensitivity, scope").eq("request_id", r.requestId!);
    assert.deepEqual(calls.data!.map((c) => [c.tool, c.outcome, c.sensitivity]), [["get_supplier_payables", "ok", "financial"]]);
  });

  it("viewer and disabled users are refused (and audited)", async () => {
    const v = await answerThroughChannel(webAdapter, { ...deps(), identityStore: store }, { sessionUserId: users.viewer }, "Còn nợ NCC bao nhiêu?");
    assert.ok(v.ok && v.response.status === "denied");
    const off = await answerThroughChannel(webAdapter, { ...deps(), identityStore: store }, { sessionUserId: users.off }, "Còn nợ NCC bao nhiêu?");
    assert.ok(off.ok && off.response.status === "denied");
  });

  it("fake model through the real budget: both calls reserved on the shared table, labelled channel web", async () => {
    const ai = getAiConfig({ AI_ENABLED: "true", AI_PROVIDER: "fake", NODE_ENV: "test", AI_MAX_REQUESTS_PER_MINUTE: "100", AI_MAX_REQUESTS_PER_USER_PER_DAY: "100", AI_MAX_REQUESTS_PER_DAY: "100000" });
    const r = await askSystemAssistant(deps({ aiConfig: ai }), { identity: { status: "resolved", actor: actor("admin", "admin") }, channel: { channel: "web", audience: "private", conversationRef: null, constraints: { maxChars: 9000, canSend: false } }, question: "Hôm nay đã thanh toán cho NCC bao nhiêu?" });
    assert.equal(r.status, "answered");
    assert.equal(r.meta.planner, "gemini");
    assert.equal(r.meta.synthesis, "gemini");
    const usage = await db.from("ai_request_usage").select("channel, feature, status").eq("user_id", users.admin).order("created_at");
    assert.deepEqual(usage.data!.map((u) => [u.channel, u.feature, u.status]), [["web", "system_plan", "completed"], ["web", "system_answer", "completed"]]);
  });
});

// ================================================================== DB guards
describe("database guards (00077)", () => {
  it("ai_system_reserve shares the Phase 04 limits and validates channel / feature", async () => {
    const base = { p_user: users.staff, p_provider: "fake", p_model: `m-${RUN}`, p_estimated: 10, p_day_start: new Date(Date.now() - 3_600_000).toISOString(), p_max_user_day: 1, p_max_day: 100000, p_max_minute: 100, p_cooldown_minutes: 1 };
    const bad = await db.rpc("ai_system_reserve", { ...base, p_channel: "sms", p_feature: "system_plan" });
    assert.equal(bad.data.ok, false);
    const first = await db.rpc("ai_system_reserve", { ...base, p_channel: "web", p_feature: "system_plan" });
    assert.equal(first.data.ok, true, JSON.stringify(first));
    await db.rpc("zp_ai_finish", { p_id: first.data.id, p_status: "completed", p_reason: null, p_input: 1, p_output: 1, p_confirmed: false, p_attempts: 1, p_redactions: 0, p_duration: 1 });
    const second = await db.rpc("ai_system_reserve", { ...base, p_channel: "web", p_feature: "system_answer" });
    assert.deepEqual(second.data, { ok: false, reason: "user_daily" }, "the same per-user budget as Zalo Personal Ask AI");
  });

  it("RLS / grants: anon reads nothing and can't execute the functions", async () => {
    for (const t of ["ai_system_requests", "ai_system_tool_calls", "ai_channel_identities", "ai_identity_link_codes"]) {
      const r = await anon.from(t).select("id").limit(1);
      assert.ok(r.error || (r.data ?? []).length === 0, t);
    }
    const f = await anon.rpc("ai_system_reserve", { p_user: users.admin, p_channel: "web", p_feature: "system_plan", p_provider: "x", p_model: "x", p_estimated: 1, p_day_start: new Date().toISOString(), p_max_user_day: 9, p_max_day: 9, p_max_minute: 9, p_cooldown_minutes: 1 });
    assert.ok(f.error, "anon can't reserve");
    const g = await anon.rpc("ai_identity_consume_code", { p_code_hash: "0".repeat(64), p_channel: "zalo_personal", p_connection_id: ids.conn, p_external_user_id: "1" });
    assert.ok(g.error, "anon can't link identities");
  });
});

// ================================================================== identity mapping
describe("Zalo Personal identity linking", () => {
  it("one-time code: link → resolves; reuse fails; group answers stay knowledge-only; revoke → unlinked", async () => {
    const issued = await issuePersonalLinkCode(store, actor("admin", "admin"), new Date());
    assert.ok(issued.ok);
    const code = (issued as { code: string }).code;
    assert.deepEqual(await resolvePersonalIdentity(store, ids.conn, "8400001"), { status: "unlinked" });
    const linked = await linkPersonalIdentity(store, { connectionId: ids.conn, senderId: "8400001", code });
    assert.deepEqual(linked, { ok: true, internalUserId: users.admin });
    assert.equal((await linkPersonalIdentity(store, { connectionId: ids.conn, senderId: "8400002", code })).ok, false, "a code works once");
    const who = await resolvePersonalIdentity(store, ids.conn, "8400001");
    assert.equal(who.status, "resolved");
    const d = { ...deps(), identityStore: store };
    const group = await answerThroughChannel(personalAdapter, d, { connectionId: ids.conn, senderId: "8400001", conversationType: "group", conversationRef: null }, "Còn nợ NCC bao nhiêu?");
    assert.ok(group.ok && group.response.status === "denied" && group.output.send === false);
    const dm = await answerThroughChannel(personalAdapter, d, { connectionId: ids.conn, senderId: "8400001", conversationType: "user", conversationRef: null }, "Còn nợ NCC bao nhiêu?");
    assert.ok(dm.ok && dm.response.status === "answered" && dm.output.kind === "draft" && dm.output.send === false);
    const list = await store.listPersonalIdentities(users.admin);
    assert.equal(list.length, 1);
    assert.equal(await store.revokePersonalIdentity(list[0]!.id, users.staff, users.staff), false, "only the owner revokes");
    assert.equal(await store.revokePersonalIdentity(list[0]!.id, users.admin, users.admin), true);
    assert.deepEqual(await resolvePersonalIdentity(store, ids.conn, "8400001"), { status: "unlinked" });
  });

  it("expired codes and codes of disabled users never link; viewers can't issue codes", async () => {
    const created = new Date(Date.now() - 20 * 60_000);
    await db.from("ai_identity_link_codes").insert({ code_hash: hashLinkCode("EXPRD234"), channel: "zalo_personal", internal_user_id: users.admin, created_at: created.toISOString(), expires_at: new Date(created.getTime() + 10 * 60_000).toISOString() });
    assert.deepEqual(await linkPersonalIdentity(store, { connectionId: ids.conn, senderId: "8400003", code: "EXPRD234" }), { ok: false, reason: "invalid_code" });
    await db.from("ai_identity_link_codes").insert({ code_hash: hashLinkCode("OFFUSR23"), channel: "zalo_personal", internal_user_id: users.off, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    assert.deepEqual(await linkPersonalIdentity(store, { connectionId: ids.conn, senderId: "8400004", code: "OFFUSR23" }), { ok: false, reason: "user_inactive" });
    assert.deepEqual(await issuePersonalLinkCode(store, actor("viewer", "viewer"), new Date()), { ok: false, reason: "not_allowed" });
  });
});
