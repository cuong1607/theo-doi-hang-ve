// SHOPEE-PRODUCT-ANALYTICS-1 (part B) — conversation foundation on the real
// local database (migration 00069): signed webhook → store → dedupe → link →
// authorization → context, with the Supabase store. Outbound Zalo and the
// analyst are fakes (no network, no model).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { zaloWebhookMac } from "../zalo/webhook.ts";
import { handleZaloWebhookRequest, SenderRateLimiter, type ZaloWebhookConfig } from "../zalo/webhook-handler.ts";
import type { ProductAnalystRequest } from "../product-analyst/contracts.ts";
import { DisabledProductAnalystProvider } from "../product-analyst/provider.ts";
import { acceptIncomingMessage, generateLinkCode, processAcceptedMessage, type ConversationDeps } from "./service.ts";
import { SupabaseConversationStore } from "./supabase-store.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey || !/localhost|127\.0\.0\.1/.test(url)) throw new Error("integration test needs the LOCAL Supabase (.env.local)");
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const TAG = Date.now();
const APP = "4242424242";
const SECRET = "it-oa-secret";
const OA = "8080";
const config: ZaloWebhookConfig = { enabled: true, appId: APP, oaSecretKey: SECRET, oaId: OA };
const ZALO_A = `77${TAG}`.slice(0, 16);
const ZALO_X = `78${TAG}`.slice(0, 16);

const users: string[] = [];
const shops: { a?: string; b?: string } = {};
let admin = "";
let staff = "";
const sent: Array<{ to: string; text: string }> = [];
const requests: ProductAnalystRequest[] = [];
let deps: ConversationDeps;
let store: SupabaseConversationStore;

async function makeUser(name: string, role: "admin" | "staff"): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email: `pa1+${TAG}-${name}@example.test`, password: `Pw-${TAG}-x!`, email_confirm: true, app_metadata: { provisioned_by_admin: true } });
  if (error || !data.user) throw error ?? new Error("createUser");
  users.push(data.user.id);
  const { error: e } = await db.from("profiles").update({ role, is_active: true }).eq("id", data.user.id);
  if (e) throw e;
  return data.user.id;
}

before(async () => {
  admin = await makeUser("admin", "admin");
  staff = await makeUser("staff", "staff");
  const { data, error } = await db
    .from("shops")
    .insert([
      { channel: "shopee", external_shop_id: `pa1a${TAG}`, shop_name: `PA1 Thảm Alpha ${TAG}`, data_source: "fixture" },
      { channel: "shopee", external_shop_id: `pa1b${TAG}`, shop_name: `PA1 Gối Beta ${TAG}`, data_source: "fixture" },
    ])
    .select("id, shop_name");
  if (error) throw error;
  shops.a = data!.find((s) => s.shop_name.includes("Alpha"))!.id;
  shops.b = data!.find((s) => s.shop_name.includes("Beta"))!.id;
  store = new SupabaseConversationStore(db);
  deps = {
    store,
    analyst: { name: "spy", analyze: async (r) => (requests.push(r), new DisabledProductAnalystProvider().analyze()) },
    sender: { sendText: async (to, text) => (sent.push({ to, text }), { ok: true, providerMessageId: `out-${TAG}-${sent.length}` }) },
  };
});

after(async () => {
  await db.from("ai_conversations").delete().in("external_user_id", [ZALO_A, ZALO_X]);
  await db.from("zalo_user_links").delete().in("zalo_user_id", [ZALO_A, ZALO_X]);
  await db.from("zalo_link_codes").delete().in("internal_user_id", users);
  await db.from("ai_user_shop_access").delete().in("internal_user_id", users);
  if (shops.a) await db.from("shops").delete().in("id", [shops.a, shops.b!]);
  for (const id of users) await db.auth.admin.deleteUser(id);
});

let seq = 0;
async function deliver(sender: string, text: string, msgId = `it-${TAG}-${++seq}`) {
  const now = new Date();
  const raw = JSON.stringify({ app_id: APP, event_name: "user_send_text", timestamp: String(now.getTime()), sender: { id: sender }, recipient: { id: OA }, message: { msg_id: msgId, text } });
  const outcome = await handleZaloWebhookRequest(
    { rawBody: raw, signatureHeader: `mac=${zaloWebhookMac(APP, raw, String(now.getTime()), SECRET)}`, config, now },
    { accept: (m) => acceptIncomingMessage(deps, m), limiter: new SenderRateLimiter() },
  );
  const result = "accepted" in outcome ? await processAcceptedMessage(deps, outcome.accepted) : null;
  return { outcome, result, msgId };
}

async function inbound(sender: string) {
  const { data } = await db.from("ai_messages").select("text, processing_status, provider_message_id, ai_conversations!inner(external_user_id)").eq("direction", "inbound").eq("ai_conversations.external_user_id", sender).order("created_at");
  return data ?? [];
}

test("PA-1 / 61-62: unknown user → stored redacted, one notice; same event twice → one row, one reply", async () => {
  const first = await deliver(ZALO_X, "sản phẩm thảm tuần này sao?", `dup-${TAG}`);
  assert.equal(first.result, "unlinked");
  const again = await deliver(ZALO_X, "sản phẩm thảm tuần này sao?", `dup-${TAG}`);
  assert.deepEqual(again.outcome.body, { ok: true, ignored: "duplicate" });
  const rows = await inbound(ZALO_X);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "[người dùng chưa liên kết]");
  assert.equal(rows[0].processing_status, "replied");
  assert.equal(sent.filter((s) => s.to === ZALO_X).length, 1);
  // the database itself refuses a second inbound row for the same provider id
  const { data: conv } = await db.from("ai_conversations").select("id").eq("external_user_id", ZALO_X).single();
  const { error } = await db.from("ai_messages").insert({ conversation_id: conv!.id, channel: "zalo", direction: "inbound", provider_message_id: `dup-${TAG}`, text: "x", processing_status: "pending" });
  assert.equal(error?.code, "23505");
});

test("PA-1 / 34: link code — hash stored only, one-time, staff code rejected, admin code links", async () => {
  const staffCode = generateLinkCode(new Date());
  await store.createLinkCode({ codeHash: staffCode.codeHash, internalUserId: staff, createdBy: admin, expiresAt: staffCode.expiresAt });
  assert.equal((await deliver(ZALO_A, `LINK ${staffCode.code}`)).result, "link_failed");

  const code = generateLinkCode(new Date());
  await store.createLinkCode({ codeHash: code.codeHash, internalUserId: admin, createdBy: admin, expiresAt: code.expiresAt });
  const { data: stored } = await db.from("zalo_link_codes").select("code_hash").eq("code_hash", code.codeHash);
  assert.equal(stored!.length, 1);
  assert.equal(JSON.stringify(stored).includes(code.code), false);

  assert.equal((await deliver(ZALO_A, `LINK ${code.code}`)).result, "linked");
  const { data: link } = await db.from("zalo_user_links").select("internal_user_id, status").eq("zalo_user_id", ZALO_A).single();
  assert.deepEqual(link, { internal_user_id: admin, status: "active" });
  assert.equal((await deliver(ZALO_X, `LINK ${code.code}`)).result, "link_failed", "used code cannot link a second account");
  assert.ok((await inbound(ZALO_A)).every((r) => !r.text.includes(code.code)), "code redacted in ai_messages");
});

test("PA-1 / 63: shop A granted → shop B denied; no grant → no analysis", async () => {
  assert.equal((await deliver(ZALO_A, "sản phẩm thảm lông tuần này")).result, "shop_required", "deny by default: no grant yet");
  await db.from("ai_user_shop_access").insert({ internal_user_id: admin, shop_id: shops.a, granted_by: admin });
  assert.equal((await deliver(ZALO_A, `Shop PA1 Gối Beta ${TAG} hôm qua thế nào?`)).result, "shop_denied");
  assert.equal(requests.length, 0);
});

test("PA-1 / 64: context persisted — product X, then 'còn hôm qua?' keeps X and the shop", async () => {
  assert.equal((await deliver(ZALO_A, "phân tích sản phẩm thảm lông cừu tuần này")).result, "analysis_placeholder");
  assert.equal((await deliver(ZALO_A, "còn hôm qua?")).result, "analysis_placeholder");
  assert.deepEqual(requests.map((r) => [r.productQuery, r.period, r.shopId, r.internalUserId]), [
    ["thảm lông cừu", "this_week", shops.a, admin],
    ["thảm lông cừu", "yesterday", shops.a, admin],
  ]);
  const { data: conv } = await db.from("ai_conversations").select("internal_user_id, current_shop_id, last_intent, context").eq("external_user_id", ZALO_A).single();
  assert.equal(conv!.current_shop_id, shops.a);
  assert.equal(conv!.last_intent, "PRODUCT_ANALYSIS");
  assert.deepEqual({ q: conv!.context.productQuery, p: conv!.context.period }, { q: "thảm lông cừu", p: "yesterday" });
  // revoke the grant: the remembered shop is NOT used any more
  await db.from("ai_user_shop_access").delete().eq("internal_user_id", admin);
  assert.equal((await deliver(ZALO_A, "còn tuần trước?")).result, "shop_required");
  assert.equal(requests.length, 2);
});

test("PA-1: only conversational fields stored — no raw webhook payload columns", async () => {
  const { data } = await db.from("ai_messages").select("*").limit(1);
  const cols = Object.keys(data?.[0] ?? {});
  assert.deepEqual(cols.sort(), ["channel", "conversation_id", "created_at", "direction", "error_code", "id", "intent", "processing_status", "provider_message_id", "text", "updated_at"]);
  const { error } = await createClient(url!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!).from("ai_messages").select("id").limit(1);
  assert.ok(error, "anon cannot read conversations");
});
