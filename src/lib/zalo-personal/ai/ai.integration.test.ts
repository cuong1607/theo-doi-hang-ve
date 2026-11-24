// ============================================================
// ZALO PERSONAL Phase 04 — integration tests against the LOCAL Supabase
// (migrations 00073 + 00074 + 00075). Real Phase 02 ingest RPCs, real
// SupabaseDashboardStore + SupabaseAiStore, real SQL functions; the model is a
// fake provider (no network). Covers: zp_fold parity with foldVi, accent-
// insensitive full-text search inside the scope, cross-connection isolation,
// period bounds, atomic budget reservation, summary provenance + facts,
// stale on source deletion / consent withdrawal, DB-side refusal of foreign
// sources and wrong namespaces, private sessions, RLS for anon / authenticated.
// Run: node --env-file=<local env> --test src/lib/zalo-personal/ai/ai.integration.test.ts
// ============================================================
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getAiConfig, type AiConfig } from "../../ai-assistant/config.ts";
import { FakeAiProvider, type FakeScript } from "../../ai-assistant/fake-provider.ts";
import { presetPeriod } from "../../ai-assistant/time-range.ts";
import { foldVi } from "../../ai-assistant/text.ts";
import { encryptSecret, parseEncryptionKey } from "../../security/secrets.ts";
import { workerSecretContext } from "../config.ts";
import { SupabaseDashboardStore } from "../dashboard/supabase-store.ts";
import { generateWorkerSecret } from "../signing.ts";
import { ask, getMemory, getSession, summarize, type AiDeps } from "./service.ts";
import { SupabaseAiStore } from "./supabase-store.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (never production)");
const db: SupabaseClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const encKey = parseEncryptionKey(process.env.APP_ENCRYPTION_KEY);
const aiStore = new SupabaseAiStore(db);
const dashboard = new SupabaseDashboardStore(db);

const RUN = randomBytes(3).toString("hex");
const PASSWORD = `Pw-${randomBytes(8).toString("hex")}`;
const ACC1 = `86${Date.now()}`.slice(0, 18);
const ACC2 = `87${Date.now()}`.slice(0, 18);
const GA = `27${Date.now()}1`.slice(0, 19);
const GB = `27${Date.now()}2`.slice(0, 19);
const GC = `27${Date.now()}3`.slice(0, 19);

const users: Record<"owner" | "staff" | "owner2", string> = { owner: "", staff: "", owner2: "" };
const created = { users: [] as string[], connections: [] as string[] };
const ids = { c1: "", c2: "", w1: "", w2: "", ga: "", gb: "", gc: "", groupA: "" };
const actor = (k: keyof typeof users) => ({ userId: users[k], role: "staff" as const });

function cfg(over: Partial<AiConfig> = {}): AiConfig {
  const base = getAiConfig({ AI_ENABLED: "true", ZALO_PERSONAL_AI_ENABLED: "true", AI_PROVIDER: "fake", NODE_ENV: "test" });
  return { ...base, ...over, limits: { ...base.limits, maxApiCallsPerUserPerMinute: 100, maxRequestsPerUserPerDay: 100, maxRequestsPerMinute: 100, ...(over.limits ?? {}) } };
}
const labelOf = (user: string, needle: string) => user.split("\n").find((l) => l.includes(needle))?.match(/^\[(S\d+)\]/)?.[1];
function depsWith(script: FakeScript, config: AiConfig = cfg()) {
  const provider = new FakeAiProvider(script, "fake-int");
  const deps: AiDeps = { dashboard, store: aiStore, config, provider: () => provider, sleep: async () => {} };
  return { deps, provider };
}

async function createUser(key: keyof typeof users) {
  const { data, error } = await db.auth.admin.createUser({ email: `zp4-${key}-${RUN}@example.test`, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${error?.message}`);
  created.users.push(data.user.id);
  await db.from("profiles").update({ is_active: true, role: "staff", full_name: `ZP4 ${key}` }).eq("id", data.user.id);
  users[key] = data.user.id;
}

async function connection(key: string, owner: string, account: string) {
  const { data: c, error } = await db.from("zalo_personal_connections").insert({ connection_key: `d4-${key}-${RUN}`, owner_user_id: owner }).select("id").single();
  if (error) throw new Error(error.message);
  created.connections.push(c.id);
  const workerId = randomUUID();
  await db.from("zalo_personal_workers").insert({ id: workerId, worker_key: `d4w-${key}-${RUN}`, connection_id: c.id, secret_encrypted: encryptSecret(generateWorkerSecret(), encKey, workerSecretContext(workerId)) });
  const hb = await db.rpc("zp_record_heartbeat", { p_worker_id: workerId, p_account_id: account, p_state: { workerVersion: "t", workerStartedAt: new Date().toISOString(), sessionState: "authenticated", listenerState: "active", lastMessageReceivedAt: null, lastDeliveryOkAt: new Date().toISOString(), outboxDepth: 0, deadLetterCount: 0, outboxFullDrops: 0, lastErrorCategory: null } });
  if (hb.error || hb.data?.ok !== true) throw new Error("heartbeat");
  return { id: c.id as string, workerId };
}

let seq = 0;
const ev = (conv: string, text: string, at: Date) => {
  seq++;
  return { eventKey: createHash("sha256").update(`d4|${RUN}|${seq}`).digest("hex"), kind: "message", conversationType: "group", conversationId: conv, externalMessageId: `d4${RUN}${seq}`, senderId: `300000000000000${100 + (seq % 3)}`, messageType: "text", text, textLength: text.length, mentions: [], mentionsSelf: false, isSelf: false, subtype: null, sentAt: at.toISOString(), receivedAt: at.toISOString() };
};
async function ingest(workerId: string, account: string, events: unknown[]) {
  const { data, error } = await db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: account, p_events: events });
  if (error || data?.ok !== true) throw new Error(`ingest ${error?.message ?? JSON.stringify(data)}`);
  return data.results as { status: string }[];
}
async function monitor(actorId: string, connectionId: string, external: string) {
  const g = (await db.from("zalo_personal_groups").select("id").eq("connection_id", connectionId).eq("external_group_id", external).single()).data!.id as string;
  await db.rpc("zp_update_group", { p_actor: actorId, p_connection_id: connectionId, p_group_id: g, p_action: "grant_consent", p_mode: null, p_note: "đồng ý (test)" });
  await db.rpc("zp_update_group", { p_actor: actorId, p_connection_id: connectionId, p_group_id: g, p_action: "set_mode", p_mode: "monitor", p_note: null });
  return g;
}
const convId = async (connectionId: string, external: string) => (await db.from("zalo_personal_conversations").select("id").eq("connection_id", connectionId).eq("external_conversation_id", external).single()).data!.id as string;

before(async () => {
  await createUser("owner");
  await createUser("staff");
  await createUser("owner2");
  const c1 = await connection("one", users.owner, ACC1);
  const c2 = await connection("two", users.owner2, ACC2);
  Object.assign(ids, { c1: c1.id, w1: c1.workerId, c2: c2.id, w2: c2.workerId });
  const t = Date.now();
  await ingest(ids.w1, ACC1, [ev(GA, "khởi tạo", new Date(t - 7200_000)), ev(GB, "khởi tạo", new Date(t - 7200_000))]);
  await ingest(ids.w2, ACC2, [ev(GC, "khởi tạo", new Date(t - 7200_000))]);
  ids.groupA = await monitor(users.owner, ids.c1, GA);
  await monitor(users.owner, ids.c1, GB);
  await monitor(users.owner2, ids.c2, GC);
  const r = await ingest(ids.w1, ACC1, [
    ev(GA, "Kho Bắc Ninh nhận 3 kiện VẢI cotton của NCC Hưng Thịnh", new Date(t - 3600_000)),
    ev(GA, "Chốt: lô hàng ABC giao thứ năm, anh Hùng phụ trách", new Date(t - 3500_000)),
    ev(GA, "Ok em ghi nhận", new Date(t - 3400_000)),
    ev(GA, "Giảm 100% phí_ship cho đơn lẻ", new Date(t - 3300_000)),
    ev(GB, "Nhóm B: vải lụa về muộn", new Date(t - 3200_000)),
  ]);
  assert.ok(r.every((x) => x.status === "stored"), JSON.stringify(r));
  await ingest(ids.w2, ACC2, [ev(GC, "Bí mật chủ 2: vải cotton giá nhập", new Date(t - 3000_000))]);
  ids.ga = await convId(ids.c1, GA);
  ids.gb = await convId(ids.c1, GB);
  ids.gc = await convId(ids.c2, GC);
});

after(async () => {
  for (const id of created.connections) {
    const convs = ((await db.from("zalo_personal_conversations").select("id").eq("connection_id", id)).data ?? []).map((c) => c.id);
    const facts = ((await db.from("ai_memory_facts").select("id").in("conversation_id", convs)).data ?? []).map((f) => f.id);
    const sums = ((await db.from("ai_conversation_summaries").select("id").in("conversation_id", convs)).data ?? []).map((s) => s.id);
    if (facts.length) await db.from("ai_memory_sources").delete().eq("memory_kind", "fact").in("memory_id", facts);
    if (sums.length) await db.from("ai_memory_sources").delete().eq("memory_kind", "summary").in("memory_id", sums);
    await db.from("ai_memory_facts").delete().eq("connection_id", id);
    await db.from("ai_conversation_summaries").delete().eq("connection_id", id);
    for (const t of ["zalo_personal_audit_log", "zalo_personal_access_grants", "zalo_personal_status_events", "zalo_personal_messages", "zalo_personal_ingestion_events", "zalo_personal_conversations", "zalo_personal_groups", "zalo_personal_sync_state", "zalo_personal_workers"]) await db.from(t).delete().eq("connection_id", id);
    await db.from("zalo_personal_connections").delete().eq("id", id);
  }
  for (const u of created.users) {
    await db.from("ai_request_usage").delete().eq("user_id", u);
    await db.from("ai_assistant_sessions").delete().eq("user_id", u);
    await db.auth.admin.deleteUser(u);
  }
});

describe("search (00075)", () => {
  it("zp_fold equals foldVi (TS and SQL fold the same way)", async () => {
    for (const s of ["Đơn HÀNG Bắc Ninh", "Nguyễn Văn Hùng", "Hùng".normalize("NFD"), "ỲÝỴỶỸ ơớờợởỡ", "giá 1.500.000đ"]) {
      const { data } = await db.rpc("zp_fold", { p_text: s });
      assert.equal(data, foldVi(s), s);
    }
  });
  const period = () => presetPeriod("last_7_days", new Date());
  it("with or without accents, upper or lower case, and proper names", async () => {
    const scope = { full: [ids.c1], group: [], ids: [] };
    for (const terms of [["vai"], ["cotton"], ["hung", "thinh"], ["bac", "ninh"]]) {
      const rows = await aiStore.search(scope, { conversationIds: null, connectionId: null, from: period().start, to: period().end, terms, limit: 20 });
      assert.ok(rows.some((r) => /Bắc Ninh nhận 3 kiện/.test(r.textContent ?? "")), terms.join(","));
    }
    const lit = await aiStore.search(scope, { conversationIds: null, connectionId: null, from: period().start, to: period().end, terms: ["phi_ship"], limit: 20 });
    assert.equal(lit.length, 0, "non-alnum terms are dropped by the SQL guard, not interpreted");
  });
  it("scope: connection 2 never appears; picked conversations narrow further; period bounds apply", async () => {
    const all = await aiStore.search({ full: [ids.c1], group: [], ids: [] }, { conversationIds: null, connectionId: null, from: period().start, to: period().end, terms: ["cotton"], limit: 50 });
    assert.equal(all.some((r) => r.connectionId === ids.c2), false);
    const onlyB = await aiStore.search({ full: [], group: [], ids: [ids.gb] }, { conversationIds: [ids.gb], connectionId: null, from: period().start, to: period().end, terms: ["vai"], limit: 50 });
    assert.ok(onlyB.length > 0 && onlyB.every((r) => r.conversationId === ids.gb));
    const future = await aiStore.search({ full: [ids.c1], group: [], ids: [] }, { conversationIds: null, connectionId: null, from: new Date(Date.now() + 3600_000), to: new Date(Date.now() + 7200_000), terms: [], limit: 50 });
    assert.equal(future.length, 0);
    const huge = await aiStore.search({ full: [ids.c1], group: [], ids: [] }, { conversationIds: null, connectionId: null, from: new Date(Date.now() - 400 * 86_400_000), to: new Date(), terms: [], limit: 50 });
    assert.equal(huge.length, 0, "a window > 93 days returns nothing");
  });
});

describe("ask end-to-end on real rows", () => {
  it("owner gets a cited answer from group A; group B and connection 2 never reach the model", async () => {
    const { deps, provider } = depsWith((i) => ({ status: "answered", answer: "Anh Hùng.", points: [{ text: "Anh Hùng phụ trách lô ABC", sourceIds: [labelOf(i.user, "anh Hùng phụ trách")!] }] }));
    const r = await ask(deps, actor("owner"), { question: "Ai phụ trách lô hàng ABC?", conversationIds: [ids.ga], period: { preset: "last_7_days" } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.data.turn.status, "answered");
    assert.equal(r.data.turn.points[0]!.citations[0]!.conversationId, ids.ga);
    assert.doesNotMatch(provider.calls[0]!.user, /Nhóm B|Bí mật chủ 2/);
    const session = await getSession(deps, actor("owner"), r.data.sessionId);
    assert.ok(session.ok && session.data.turns[0]!.points.length === 1);
    const usage = await db.from("ai_request_usage").select("status, input_tokens").eq("user_id", users.owner);
    assert.ok(usage.data!.some((u) => u.status === "completed"));
  });
  it("staff without a grant → forbidden; after a read grant: groups only; owner2's group not_found", async () => {
    const { deps } = depsWith(() => ({ status: "insufficient", answer: "", points: [] }));
    const before = await ask(deps, actor("staff"), { question: "Lô ABC?" });
    assert.equal(before.ok ? "ok" : before.error, "forbidden");
    await db.rpc("zp_grant_access", { p_actor: users.owner, p_connection_id: ids.c1, p_grantee: users.staff, p_scope: "connection", p_conversation_id: null, p_level: "read", p_note: null });
    const okr = await ask(deps, actor("staff"), { question: "Lô ABC?", conversationIds: [ids.ga] });
    assert.ok(okr.ok);
    const idor = await ask(deps, actor("staff"), { question: "Lô ABC?", conversationIds: [ids.gc] });
    assert.equal(idor.ok ? "ok" : idor.error, "not_found");
  });
  it("sessions are per user: the owner's session is not visible to staff", async () => {
    const { deps } = depsWith(() => ({ status: "insufficient", answer: "", points: [] }));
    const r = await ask(deps, actor("owner"), { question: "Có gì mới trong nhóm?", conversationIds: [ids.ga] });
    assert.ok(r.ok);
    const s = await getSession(deps, actor("staff"), r.data.sessionId);
    assert.equal(s.ok ? "ok" : s.error, "not_found");
  });
});

describe("budget reservation is atomic", () => {
  it("parallel reservations never exceed the daily cap", async () => {
    const cap = await db.from("ai_request_usage").select("id", { count: "exact", head: true }).in("status", ["running", "completed", "failed"]).gte("created_at", presetPeriod("today", new Date()).start.toISOString());
    const used = cap.count ?? 0;
    const limits = { ...cfg().limits, maxRequestsPerDay: used + 2, maxRequestsPerUserPerDay: 100, maxRequestsPerMinute: 100 };
    const who = [users.owner, users.staff, users.owner2, users.owner, users.staff, users.owner2];
    const res = await Promise.all(who.map((u) => aiStore.reserve(u, "ask", "fake", `fake-cap-${RUN}`, 10, presetPeriod("today", new Date()).start, limits)));
    const granted = res.filter((r) => r.ok);
    assert.equal(granted.length, 2, JSON.stringify(res));
    for (const g of granted) if (g.ok) await aiStore.finish(g.id, { status: "completed", reason: null, inputTokens: 1, outputTokens: 1, confirmed: false, attempts: 1, redactions: 0, durationMs: 1 });
  });
  it("a quota error starts the cool-down for that model", async () => {
    const limits = { ...cfg().limits, maxRequestsPerDay: 100_000 };
    const model = `fake-quota-${RUN}`;
    const r = await aiStore.reserve(users.owner2, "ask", "fake", model, 1, presetPeriod("today", new Date()).start, limits);
    assert.ok(r.ok);
    if (r.ok) await aiStore.finish(r.id, { status: "failed", reason: "quota_exceeded", inputTokens: 0, outputTokens: 0, confirmed: false, attempts: 1, redactions: 0, durationMs: 1 });
    const next = await aiStore.reserve(users.owner, "ask", "fake", model, 1, presetPeriod("today", new Date()).start, limits);
    assert.deepEqual(next, { ok: false, reason: "quota_cooldown" });
  });
});

describe("summaries, provenance and invalidation", () => {
  const script: FakeScript = (i) => ({
    status: "answered",
    summary: "Kho nhận vải; chốt lô ABC.",
    points: [{ text: "Kho nhận 3 kiện vải", sourceIds: [labelOf(i.user, "3 kiện")!] }],
    decisions: [{ text: "Lô ABC giao thứ năm", sourceIds: [labelOf(i.user, "lô hàng ABC")!], confidence: 0.9 }],
    facts: [{ text: "NCC Hưng Thịnh cung cấp vải cotton", sourceIds: [labelOf(i.user, "3 kiện")!] }],
  });
  it("summary + facts stored with sources; reused while sources are unchanged", async () => {
    const { deps, provider } = depsWith(script);
    const r = await summarize(deps, actor("owner"), { conversationId: ids.ga, kind: "conversation", period: { preset: "last_7_days" } });
    assert.ok(r.ok && r.data.summary, JSON.stringify(r));
    const row = (await db.from("ai_conversation_summaries").select("id, namespace, source_count, status").eq("id", r.data.summary.id).single()).data!;
    assert.deepEqual([row.namespace, row.status], ["personal_group", "fresh"]);
    const src = await db.from("ai_memory_sources").select("message_id", { count: "exact", head: true }).eq("memory_kind", "summary").eq("memory_id", row.id);
    assert.equal(src.count, row.source_count);
    const facts = (await db.from("ai_memory_facts").select("kind, confidence, evidence_status").eq("summary_id", row.id)).data!;
    assert.ok(facts.length >= 2 && facts.every((f) => f.evidence_status === "ai_inferred" && Number(f.confidence) <= 0.7));
    const again = await summarize(deps, actor("owner"), { conversationId: ids.ga, kind: "conversation", period: { preset: "last_7_days" } });
    assert.ok(again.ok && again.data.summary?.reused);
    assert.equal(provider.calls.length, 1);
  });
  it("database refuses foreign sources and a wrong namespace", async () => {
    const foreign = (await db.from("zalo_personal_messages").select("id").eq("conversation_id", ids.gc).limit(1).single()).data!.id;
    const p = presetPeriod("last_7_days", new Date());
    const base = { p_actor: users.owner, p_connection_id: ids.c1, p_conversation_id: ids.ga, p_kind: "conversation", p_topic: null, p_period_start: p.start.toISOString(), p_period_end: p.end.toISOString(), p_fingerprint: "0".repeat(64), p_prompt_version: "t", p_provider: "fake", p_model: "fake", p_content: {}, p_facts: [] };
    assert.equal((await db.rpc("zp_ai_store_summary", { ...base, p_namespace: "personal_group", p_input_ids: [foreign] })).data.error, "foreign_source");
    assert.equal((await db.rpc("zp_ai_store_summary", { ...base, p_namespace: "personal_direct", p_input_ids: [] })).data.error, "namespace_mismatch");
    const web = await db.from("ai_memory_facts").insert({ namespace: "web_session", connection_id: ids.c1, conversation_id: ids.ga, kind: "fact", statement: "x", confidence: 0.5, source_count: 1 });
    assert.equal(web.error?.code, "23514", "Web namespace is refused by a CHECK");
  });
  it("a deleted source message (retention) makes the summary and its facts stale", async () => {
    const { deps } = depsWith(script);
    const before = await getMemory(deps, actor("owner"), ids.ga);
    assert.ok(before.ok && before.data.summaries.some((s) => s.status === "fresh"));
    const victim = (await db.from("zalo_personal_messages").select("id").eq("conversation_id", ids.ga).ilike("text_content", "%3 kiện%").single()).data!.id;
    const del = await db.from("zalo_personal_messages").delete().eq("id", victim);
    assert.equal(del.error, null);
    const after = await getMemory(deps, actor("owner"), ids.ga);
    assert.ok(after.ok);
    assert.ok(after.data.summaries.every((s) => s.status === "stale" && s.staleReason === "source_deleted"));
    assert.ok(after.data.facts.filter((f) => f.status === "stale").length > 0);
  });
  it("withdrawn consent makes the group's memory stale", async () => {
    const { deps } = depsWith(script);
    await summarize(deps, actor("owner"), { conversationId: ids.ga, kind: "decision", period: { preset: "last_7_days" } });
    await db.rpc("zp_update_group", { p_actor: users.owner, p_connection_id: ids.c1, p_group_id: ids.groupA, p_action: "withdraw_consent", p_mode: null, p_note: null });
    const m = await getMemory(deps, actor("owner"), ids.ga);
    assert.ok(m.ok && m.data.summaries.filter((s) => s.kind === "decision").every((s) => s.status === "stale" && s.staleReason === "consent_withdrawn"));
  });
});

describe("RLS: browser roles get nothing", () => {
  it("anon and a signed-in user cannot read the AI tables or call the AI functions", async () => {
    const anon = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const authed = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error: se } = await authed.auth.signInWithPassword({ email: `zp4-owner-${RUN}@example.test`, password: PASSWORD });
    assert.equal(se, null);
    for (const client of [anon, authed]) {
      for (const t of ["ai_assistant_sessions", "ai_assistant_turns", "ai_conversation_summaries", "ai_memory_facts", "ai_memory_sources", "ai_request_usage"]) {
        const r = await client.from(t).select("*").limit(1);
        assert.ok(r.error !== null || (r.data ?? []).length === 0, `${t} readable`);
        assert.ok(r.error, `${t}: expected a permission error`);
      }
      const fn = await client.rpc("zp_ai_search", { p_full: [ids.c1], p_group: [], p_ids: [], p_conversation_ids: null, p_connection_id: null, p_type: null, p_sender: null, p_message_type: null, p_from: new Date(Date.now() - 86_400_000).toISOString(), p_to: new Date().toISOString(), p_terms: [], p_limit: 5 });
      assert.ok(fn.error, "zp_ai_search callable by a browser role");
      const res = await client.rpc("zp_ai_reserve", { p_user: users.owner, p_feature: "ask", p_provider: "x", p_model: "x", p_estimated: 0, p_day_start: new Date().toISOString(), p_max_user_day: 9, p_max_day: 9, p_max_minute: 9, p_cooldown_minutes: 1 });
      assert.ok(res.error, "zp_ai_reserve callable by a browser role");
    }
  });
});
