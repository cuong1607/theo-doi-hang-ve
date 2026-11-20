// SHOPEE-PRODUCT-ANALYTICS-1 (part B/C) — Zalo webhook, router, conversation
// service (in-memory store), agent contracts and static guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseZaloWebhookEvent, verifyZaloWebhookSignature, zaloWebhookMac } from "../zalo/webhook.ts";
import { handleZaloWebhookRequest, SenderRateLimiter, type ZaloWebhookConfig } from "../zalo/webhook-handler.ts";
import { routeMessage } from "./router.ts";
import {
  acceptIncomingMessage,
  generateLinkCode,
  handleIncomingConversationMessage,
  hashLinkCode,
  MESSAGES,
  type ConversationChannel,
  type ConversationContextData,
  type ConversationDeps,
  type ConversationRecord,
  type ConversationStore,
  type ProductCandidate,
  type ShopRef,
  type UserLink,
} from "./service.ts";
import { analysisCacheKey, ANALYSIS_RUN_POLICY, FORBIDDEN_TOOL_PATTERNS, validateAnalystOutput, type ProductAnalyst, type ProductAnalystRequest } from "../product-analyst/contracts.ts";
import { getProductAnalystConfig } from "../product-analyst/config.ts";
import { DisabledProductAnalyst, PRODUCT_ANALYST_PLACEHOLDER } from "../product-analyst/provider.ts";
import { ANALYST_TOOLS } from "../product-analyst/tools.ts";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");

// ------------------------------------------------------------ in-memory store
class MemoryStore implements ConversationStore {
  links = new Map<string, { internalUserId: string; status: "active" | "revoked" }>();
  profiles = new Map<string, { active: boolean; role: string }>();
  conversations = new Map<string, ConversationRecord & { externalUserId: string }>();
  messages: Array<{ id: string; conversationId: string; direction: "inbound" | "outbound"; providerMessageId: string | null; text: string; status: string }> = [];
  access = new Map<string, Set<string>>();
  shops: ShopRef[] = [];
  codes = new Map<string, { internalUserId: string; expiresAt: Date; usedAt: Date | null }>();
  private seq = 0;

  async findLink(_c: ConversationChannel, ext: string): Promise<UserLink | null> {
    const l = this.links.get(ext);
    if (!l) return null;
    const p = this.profiles.get(l.internalUserId);
    return { internalUserId: l.internalUserId, status: l.status, profileActive: !!p?.active, role: p?.role ?? null };
  }
  async upsertConversation(_c: ConversationChannel, ext: string, internalUserId: string | null): Promise<ConversationRecord> {
    let c = this.conversations.get(ext);
    if (!c) {
      c = { id: `conv-${++this.seq}`, externalUserId: ext, internalUserId, currentShopId: null, lastIntent: null, context: {} };
      this.conversations.set(ext, c);
    } else if (c.internalUserId !== internalUserId) {
      c.internalUserId = internalUserId;
      c.currentShopId = null;
    }
    return { ...c, context: { ...c.context } };
  }
  async insertInboundMessage(i: { conversationId: string; providerMessageId: string; text: string }) {
    if (this.messages.some((m) => m.direction === "inbound" && m.providerMessageId === i.providerMessageId)) return { inserted: false as const };
    const id = `msg-${++this.seq}`;
    this.messages.push({ id, conversationId: i.conversationId, direction: "inbound", providerMessageId: i.providerMessageId, text: i.text, status: "pending" });
    return { inserted: true as const, id };
  }
  async setInboundStatus(id: string, status: string) {
    this.messages.find((m) => m.id === id)!.status = status;
  }
  async insertOutboundMessage(i: { conversationId: string; text: string; status: "sent" | "failed"; providerMessageId: string | null }) {
    this.messages.push({ id: `msg-${++this.seq}`, conversationId: i.conversationId, direction: "outbound", providerMessageId: i.providerMessageId, text: i.text, status: i.status });
  }
  products = new Map<string, ProductCandidate[]>();
  async findProducts(shopId: string) {
    return this.products.get(shopId) ?? [];
  }
  async updateConversation(id: string, patch: { currentShopId?: string | null; currentProductId?: string | null; lastIntent?: ConversationRecord["lastIntent"]; context?: ConversationContextData; internalUserId?: string | null }) {
    const c = [...this.conversations.values()].find((x) => x.id === id)!;
    if (patch.currentShopId !== undefined) c.currentShopId = patch.currentShopId;
    if (patch.currentProductId !== undefined) c.currentProductId = patch.currentProductId;
    if (patch.lastIntent !== undefined) c.lastIntent = patch.lastIntent;
    if (patch.context !== undefined) c.context = { ...patch.context };
    if (patch.internalUserId !== undefined) c.internalUserId = patch.internalUserId;
  }
  async allowedShops(userId: string) {
    const ids = this.access.get(userId) ?? new Set();
    return this.shops.filter((s) => ids.has(s.id));
  }
  async allShops() {
    return this.shops;
  }
  async consumeLinkCode(hash: string, _ext: string, now: Date) {
    const c = this.codes.get(hash);
    if (!c || c.usedAt || c.expiresAt <= now) return null;
    c.usedAt = now;
    return { internalUserId: c.internalUserId };
  }
  async createLink(_c: ConversationChannel, ext: string, internalUserId: string) {
    this.links.set(ext, { internalUserId, status: "active" });
  }
  async profile(id: string) {
    return this.profiles.get(id) ?? null;
  }
}

function setup(now = new Date("2026-10-30T03:00:00Z")) {
  const store = new MemoryStore();
  store.shops = [
    { id: "shop-a", name: "RUGLUX" },
    { id: "shop-b", name: "CTV Bedding & decor Store" },
  ];
  store.profiles.set("u-admin", { active: true, role: "admin" });
  store.profiles.set("u-staff", { active: true, role: "staff" });
  const sent: Array<{ to: string; text: string }> = [];
  const requests: ProductAnalystRequest[] = [];
  // a spy around the DISABLED analyst: PA-1 behaviour (placeholder, no PA-4 live routing)
  const analyst: ProductAnalyst = {
    name: "disabled",
    analyze: async (r) => {
      requests.push(r);
      return new DisabledProductAnalyst().analyze();
    },
  };
  const deps: ConversationDeps = { store, analyst, now: () => now, sender: { sendText: async (to, text) => (sent.push({ to, text }), { ok: true, providerMessageId: `out-${sent.length}` }) } };
  let n = 0;
  const msg = (text: string, ext = "5550001", id?: string) => ({ channel: "zalo" as const, externalUserId: ext, providerMessageId: id ?? `m-${++n}`, text, receivedAt: now });
  return { store, deps, sent, requests, msg, now };
}

function linkAdmin(store: MemoryStore, ext = "5550001", user = "u-admin", shops = ["shop-a"]) {
  store.links.set(ext, { internalUserId: user, status: "active" });
  store.access.set(user, new Set(shops));
}

// ------------------------------------------------------------ webhook
const APP = "1234567890";
const SECRET = "oa-secret-key";
const config: ZaloWebhookConfig = { enabled: true, appId: APP, oaSecretKey: SECRET, oaId: "777" };
function signed(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return { raw, header: `mac=${zaloWebhookMac(APP, raw, String(body.timestamp), SECRET)}` };
}
const NOW = new Date("2026-10-30T03:00:00Z");
const textEvent = (over: Record<string, unknown> = {}) => ({
  app_id: APP,
  event_name: "user_send_text",
  timestamp: String(NOW.getTime()),
  sender: { id: "5550001" },
  recipient: { id: "777" },
  message: { msg_id: "msg-abc", text: "hướng dẫn" },
  ...over,
});

test("PA-1 / 61: webhook signature — valid, invalid, missing, stale, wrong app, not configured", () => {
  const { raw, header } = signed(textEvent());
  assert.deepEqual(verifyZaloWebhookSignature({ rawBody: raw, signatureHeader: header, appId: APP, oaSecretKey: SECRET, now: NOW }), { ok: true, skewMs: 0, timestampDigits: 13 });
  assert.equal(verifyZaloWebhookSignature({ rawBody: raw, signatureHeader: header.replace(/.$/, (c) => (c === "0" ? "1" : "0")), appId: APP, oaSecretKey: SECRET, now: NOW }).ok, false);
  assert.deepEqual(
    verifyZaloWebhookSignature({ rawBody: raw.replace("hướng dẫn", "x"), signatureHeader: header, appId: APP, oaSecretKey: SECRET, now: NOW }),
    { ok: false, reason: "bad_signature", skewMs: 0, diagnostics: { reserializedBodyMatches: false, bodyIsCompact: true } },
    "tampered body",
  );
  assert.deepEqual(verifyZaloWebhookSignature({ rawBody: raw, signatureHeader: null, appId: APP, oaSecretKey: SECRET, now: NOW }), { ok: false, reason: "missing_signature" });
  assert.deepEqual(verifyZaloWebhookSignature({ rawBody: raw, signatureHeader: header, appId: APP, oaSecretKey: undefined, now: NOW }), { ok: false, reason: "not_configured" });
  assert.deepEqual(verifyZaloWebhookSignature({ rawBody: raw, signatureHeader: header, appId: "999", oaSecretKey: SECRET, now: NOW }), { ok: false, reason: "app_mismatch" });
  assert.deepEqual(verifyZaloWebhookSignature({ rawBody: raw, signatureHeader: header, appId: APP, oaSecretKey: SECRET, now: new Date(NOW.getTime() + 16 * 60_000) }), { ok: false, reason: "stale_timestamp", skewMs: 16 * 60_000 });
});

test("PA-1P / 16-17: raw bytes are what is verified; the re-serialized variant is diagnostics only, never accepted", () => {
  const event = textEvent();
  const pretty = JSON.stringify(event, null, 2); // raw body with whitespace, as a sender might format it
  const compactMac = `mac=${zaloWebhookMac(APP, JSON.stringify(event), event.timestamp, SECRET)}`;
  const r = verifyZaloWebhookSignature({ rawBody: pretty, signatureHeader: compactMac, appId: APP, oaSecretKey: SECRET, now: NOW });
  assert.equal(r.ok, false, "a mac over a different byte layout is rejected");
  assert.deepEqual(r, { ok: false, reason: "bad_signature", skewMs: 0, diagnostics: { reserializedBodyMatches: true, bodyIsCompact: false } });
  const prettyMac = `mac=${zaloWebhookMac(APP, pretty, event.timestamp, SECRET)}`;
  assert.equal(verifyZaloWebhookSignature({ rawBody: pretty, signatureHeader: prettyMac, appId: APP, oaSecretKey: SECRET, now: NOW }).ok, true, "mac over the exact raw bytes passes");
  // a seconds timestamp is accepted within the window and reported as 10 digits
  const secEvent = textEvent({ timestamp: String(Math.floor(NOW.getTime() / 1000)) });
  const secRaw = JSON.stringify(secEvent);
  const sec = verifyZaloWebhookSignature({ rawBody: secRaw, signatureHeader: `mac=${zaloWebhookMac(APP, secRaw, secEvent.timestamp, SECRET)}`, appId: APP, oaSecretKey: SECRET, now: NOW });
  assert.equal(sec.ok && sec.timestampDigits, 10);
});

test("PA-1 / 61: webhook handler — disabled, invalid signature, unsupported event, other OA, text accepted, duplicate", async () => {
  const limiter = new SenderRateLimiter();
  const accepted: string[] = [];
  const accept = async (m: { providerMessageId: string }) => {
    if (accepted.includes(m.providerMessageId)) return null;
    accepted.push(m.providerMessageId);
    return { messageId: "x", conversation: { id: "c", internalUserId: null, currentShopId: null, lastIntent: null, context: {} }, link: null, message: m } as never;
  };
  const ok = signed(textEvent());
  assert.deepEqual((await handleZaloWebhookRequest({ rawBody: ok.raw, signatureHeader: ok.header, config: { ...config, enabled: false }, now: NOW }, { accept, limiter })).body, { ok: true, ignored: "disabled" });
  const bad = await handleZaloWebhookRequest({ rawBody: ok.raw, signatureHeader: "mac=" + "0".repeat(64), config, now: NOW }, { accept, limiter });
  assert.equal(bad.status, 401);
  assert.equal((await handleZaloWebhookRequest({ rawBody: ok.raw, signatureHeader: ok.header, config: { ...config, oaSecretKey: undefined }, now: NOW }, { accept, limiter })).status, 503, "fail closed when the secret is missing");
  const follow = signed(textEvent({ event_name: "follow", message: undefined }));
  assert.deepEqual((await handleZaloWebhookRequest({ rawBody: follow.raw, signatureHeader: follow.header, config, now: NOW }, { accept, limiter })).body, { ok: true, ignored: "unsupported_event" });
  const other = signed(textEvent({ recipient: { id: "888" } }));
  assert.deepEqual((await handleZaloWebhookRequest({ rawBody: other.raw, signatureHeader: other.header, config, now: NOW }, { accept, limiter })).body, { ok: true, ignored: "other_oa" });
  const first = await handleZaloWebhookRequest({ rawBody: ok.raw, signatureHeader: ok.header, config, now: NOW }, { accept, limiter });
  assert.ok("accepted" in first);
  const again = await handleZaloWebhookRequest({ rawBody: ok.raw, signatureHeader: ok.header, config, now: NOW }, { accept, limiter });
  assert.deepEqual(again.body, { ok: true, ignored: "duplicate" });
  assert.equal(accepted.length, 1);
});

test("PA-1: webhook parsing + per-sender rate limit", () => {
  const e = parseZaloWebhookEvent(JSON.stringify(textEvent()));
  assert.equal(e.kind, "text");
  assert.equal(parseZaloWebhookEvent(JSON.stringify(textEvent({ event_name: "user_send_image" }))).kind, "unsupported");
  assert.equal(parseZaloWebhookEvent(JSON.stringify(textEvent({ sender: { id: "abc" } }))).kind, "unsupported");
  assert.equal(parseZaloWebhookEvent("not json").kind, "unsupported");
  const l = new SenderRateLimiter(2, 1000);
  assert.deepEqual([l.allow("a", 0), l.allow("a", 1), l.allow("a", 2), l.allow("b", 2), l.allow("a", 1500)], [true, true, false, true, true]);
});

// ------------------------------------------------------------ router + context
test("PA-1 / 40: deterministic router", () => {
  assert.equal(routeMessage("hướng dẫn").intent, "HELP");
  assert.equal(routeMessage("help").intent, "HELP");
  const r = routeMessage("Tại sao sản phẩm ga chống thấm tuần này giảm doanh số?");
  assert.deepEqual([r.intent, r.productQuery, r.period], ["PRODUCT_ANALYSIS", "ga chống thấm", "this_week"]);
  assert.equal(routeMessage("Quảng cáo hôm qua ROAS thế nào").intent, "ADS_ANALYSIS");
  assert.equal(routeMessage("Shop RUGLUX hôm qua thế nào?").intent, "SHOP_ANALYSIS");
  assert.equal(routeMessage("thời tiết hôm nay").intent, "UNKNOWN");
  assert.equal(routeMessage("LINK ab12cd34").linkCode, "AB12CD34");
});

test("PA-1 / 64: context — 'phân tích sản phẩm X' then 'còn hôm qua?' keeps product X", async () => {
  const { store, deps, requests, msg } = setup();
  linkAdmin(store);
  assert.equal(await handleIncomingConversationMessage(deps, msg("phân tích sản phẩm thảm lông cừu tuần này")), "analysis_placeholder");
  assert.equal(await handleIncomingConversationMessage(deps, msg("còn hôm qua?")), "analysis_placeholder");
  assert.deepEqual(requests.map((r) => [r.intent, r.productQuery, r.period, r.shopId]), [
    ["PRODUCT_ANALYSIS", "thảm lông cừu", "this_week", "shop-a"],
    ["PRODUCT_ANALYSIS", "thảm lông cừu", "yesterday", "shop-a"],
  ]);
  // "routeMessage" alone is pure: without context the follow-up is UNKNOWN
  assert.equal(routeMessage("còn hôm qua?").intent, "UNKNOWN");
});

// ------------------------------------------------------------ idempotency
test("PA-1 / 62: same provider event twice → one stored message, one processing, one reply", async () => {
  const { store, deps, sent, requests, msg } = setup();
  linkAdmin(store);
  const m = msg("sản phẩm thảm tròn hôm qua", "5550001", "zalo-msg-1");
  assert.equal(await handleIncomingConversationMessage(deps, m), "analysis_placeholder");
  assert.equal(await handleIncomingConversationMessage(deps, m), "duplicate");
  assert.equal(store.messages.filter((x) => x.direction === "inbound").length, 1);
  assert.equal(requests.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(store.messages.find((x) => x.direction === "inbound")!.status, "replied");
});

// ------------------------------------------------------------ identity + linking
test("PA-1 / 61: unknown user — one linking notice per day, text not stored, never analysed", async () => {
  const { store, deps, sent, requests, msg } = setup();
  assert.equal(await handleIncomingConversationMessage(deps, msg("sản phẩm thảm tuần này", "9990001")), "unlinked");
  assert.equal(await handleIncomingConversationMessage(deps, msg("alo", "9990001")), "unlinked_silent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, MESSAGES.unlinked);
  assert.equal(requests.length, 0);
  assert.ok(store.messages.filter((m) => m.direction === "inbound").every((m) => m.text === "[người dùng chưa liên kết]"));
});

test("PA-1 / 34: linking — valid one-time code links; reused / expired / non-admin codes fail; code never stored", async () => {
  const { store, deps, sent, msg, now } = setup();
  const good = generateLinkCode(now, () => 0);
  assert.equal(good.code, "AAAAAAAA");
  assert.equal(good.codeHash, hashLinkCode("aaaaaaaa"));
  store.codes.set(good.codeHash, { internalUserId: "u-admin", expiresAt: good.expiresAt, usedAt: null });
  assert.equal(await handleIncomingConversationMessage(deps, msg(`LINK ${good.code}`, "5550002")), "linked");
  assert.equal(store.links.get("5550002")?.internalUserId, "u-admin");
  assert.ok(store.messages.every((m) => !m.text.includes(good.code)), "the code itself is redacted in storage");
  assert.equal(await handleIncomingConversationMessage(deps, msg(`LINK ${good.code}`, "5550003")), "link_failed", "one-time");
  const expired = generateLinkCode(new Date(now.getTime() - 11 * 60_000), () => 1);
  store.codes.set(expired.codeHash, { internalUserId: "u-admin", expiresAt: expired.expiresAt, usedAt: null });
  assert.equal(await handleIncomingConversationMessage(deps, msg(`LINK ${expired.code}`, "5550004")), "link_failed");
  const staff = generateLinkCode(now, () => 2);
  store.codes.set(staff.codeHash, { internalUserId: "u-staff", expiresAt: staff.expiresAt, usedAt: null });
  assert.equal(await handleIncomingConversationMessage(deps, msg(`LINK ${staff.code}`, "5550005")), "link_failed", "early rollout: admin only");
  assert.equal(store.links.has("5550005"), false);
  assert.ok(sent.some((s) => s.text === MESSAGES.linked));
});

test("PA-1 / 34: brute-force limit on link codes", async () => {
  const { deps, msg } = setup();
  const outcomes = [];
  for (let i = 0; i < 7; i++) outcomes.push(await handleIncomingConversationMessage(deps, msg(`LINK WRONG${i}XX`, "5550009")));
  assert.deepEqual(outcomes, Array(7).fill("link_failed"));
  const { sent } = setup();
  assert.equal(sent.length, 0);
});

// ------------------------------------------------------------ authorization
test("PA-1 / 63: user A allowed shop A asks about shop B → denied, analyst never called", async () => {
  const { store, deps, sent, requests, msg } = setup();
  linkAdmin(store, "5550001", "u-admin", ["shop-a"]);
  assert.equal(await handleIncomingConversationMessage(deps, msg("Shop CTV Bedding & decor Store hôm qua thế nào?")), "shop_denied");
  assert.equal(sent.at(-1)!.text, MESSAGES.shopDenied);
  assert.equal(requests.length, 0);
  assert.equal(await handleIncomingConversationMessage(deps, msg("Shop RUGLUX hôm qua thế nào?")), "analysis_placeholder");
  assert.equal(requests[0].shopId, "shop-a");
});

test("PA-1 / 39: context never grants access — a revoked shop grant is not reused from context", async () => {
  const { store, deps, requests, msg } = setup();
  linkAdmin(store, "5550001", "u-admin", ["shop-a", "shop-b"]);
  assert.equal(await handleIncomingConversationMessage(deps, msg("sản phẩm thảm tròn của shop RUGLUX tuần này")), "analysis_placeholder");
  store.access.set("u-admin", new Set(["shop-b"])); // RUGLUX revoked
  assert.equal(await handleIncomingConversationMessage(deps, msg("còn hôm qua?")), "analysis_placeholder");
  assert.equal(requests[1].shopId, "shop-b", "falls back to the only remaining grant, not the remembered shop");
  store.access.set("u-admin", new Set());
  assert.equal(await handleIncomingConversationMessage(deps, msg("còn tuần trước?")), "shop_required");
  assert.equal(requests.length, 2);
});

test("PA-1 / 33: linked but deactivated / demoted profile → no analysis", async () => {
  const { store, deps, requests, msg } = setup();
  linkAdmin(store);
  store.profiles.set("u-admin", { active: false, role: "admin" });
  assert.equal(await handleIncomingConversationMessage(deps, msg("sản phẩm thảm hôm qua")), "not_allowed");
  store.profiles.set("u-admin", { active: true, role: "viewer" });
  assert.equal(await handleIncomingConversationMessage(deps, msg("sản phẩm thảm hôm nay")), "not_allowed");
  assert.equal(requests.length, 0);
});

test("PA-1 / 42: placeholder reply echoes what was understood, never invents analysis", async () => {
  const { store, deps, sent, msg } = setup();
  linkAdmin(store);
  await handleIncomingConversationMessage(deps, msg("Tại sao sản phẩm ga chống thấm tuần này giảm doanh số?"));
  assert.equal(sent[0].text, `Đã ghi nhận: Sản phẩm “ga chống thấm” · RUGLUX · tuần này.\n${PRODUCT_ANALYST_PLACEHOLDER}`);
});

test("PA-1: accept stores pending message before any processing (webhook returns fast)", async () => {
  const { store, deps, sent, msg } = setup();
  linkAdmin(store);
  const a = await acceptIncomingMessage(deps, msg("sản phẩm thảm hôm qua"));
  assert.ok(a);
  assert.equal(store.messages[0].status, "pending");
  assert.equal(sent.length, 0);
});

// ------------------------------------------------------------ agent foundation
test("PA-1 / 65: no Anthropic call — disabled provider even when the flag is on, no network", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("network forbidden in this test");
  }) as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const p = new DisabledProductAnalyst();
    assert.deepEqual(await p.analyze(), { kind: "placeholder", text: PRODUCT_ANALYST_PLACEHOLDER });
    // PA-4: everything is off by default, and a channel flag alone enables nothing
    const off = getProductAnalystConfig({});
    assert.deepEqual([off.enabled, off.zaloEnabled, off.webEnabled], [false, false, false], "default off");
    const channelOnly = getProductAnalystConfig({ AI_PRODUCT_ANALYST_ZALO_ENABLED: "true", AI_PRODUCT_ANALYST_WEB_ENABLED: "true" });
    assert.deepEqual([channelOnly.zaloEnabled, channelOnly.webEnabled], [false, false], "channel flags need the master switch");
    const providerOnly = getProductAnalystConfig({ AI_PRODUCT_ANALYST_ENABLED: "true" });
    assert.deepEqual([providerOnly.enabled, providerOnly.zaloEnabled, providerOnly.webEnabled], [true, false, false], "enabling the provider enables no channel");
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = warn;
  }
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

test("PA-1 / 45 / 65 / 66 (PA-4): static guards — the model SDK only in claude-provider.ts, webhook never imports an analyst implementation, no SQL tool", () => {
  const scoped = [...walk(path.join(SRC, "lib", "conversation")), ...walk(path.join(SRC, "lib", "product-analyst")), ...walk(path.join(SRC, "lib", "zalo")), ...walk(path.join(SRC, "app", "api", "zalo"))].filter((f) => !f.endsWith(".test.ts"));
  assert.ok(scoped.length >= 8);
  for (const f of scoped) {
    // code only: comments may name what is forbidden
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (path.basename(f) !== "claude-provider.ts") assert.doesNotMatch(src, /@anthropic-ai|api\.anthropic\.com|from ["']ai["']|@ai-sdk\//, `${path.basename(f)} must not reach a model`);
    assert.doesNotMatch(src, /execute_sql|raw_query|run_sql|\.rpc\(\s*["']exec/i, `${path.basename(f)} exposes no raw SQL`);
  }
  const webhook = readFileSync(path.join(SRC, "app", "api", "zalo", "webhook", "route.ts"), "utf8");
  assert.doesNotMatch(webhook, /product-analyst/, "webhook goes through the conversation service only");
  for (const t of ANALYST_TOOLS) {
    for (const re of FORBIDDEN_TOOL_PATTERNS) {
      assert.doesNotMatch(t.name, re, `tool ${t.name}`);
      for (const p of Object.keys(t.input_schema.properties)) assert.doesNotMatch(p, re, `${t.name}.${p}`);
    }
  }
  assert.equal(ANALYSIS_RUN_POLICY.scheduledFullCatalogueRuns, false);
});

test("PA-1 / 53-55 (PA-4 shape): output contract — evidence ids required, confidence enum, no actions field", () => {
  const good = {
    summary: "Doanh số giảm cùng lúc với số đơn giảm.",
    data_quality_note: null,
    findings: [{ title: "Số đơn giảm", description: "Đơn và doanh số cùng giảm.", severity: "WARNING", evidence_refs: ["e1"] }],
    hypotheses: [{ statement: "Khả năng vấn đề nằm sau bước click.", confidence: "LOW", supporting_evidence: ["Đơn −18%"], counter_evidence: [], missing_data: ["visitors"] }],
    evidence: [{ id: "e1", text: "Đơn −18%" }],
    confidence: "MEDIUM",
    missing_data: ["traffic source"],
    suggested_checks: ["Kiểm tra giá"],
    follow_up_context: { topic: null },
  };
  assert.equal(validateAnalystOutput(good).ok, true);
  assert.equal(validateAnalystOutput({ ...good, findings: [{ ...good.findings[0], evidence_refs: [] }] }).ok, false, "finding without evidence");
  assert.equal(validateAnalystOutput({ ...good, findings: [{ ...good.findings[0], evidence_refs: ["e9"] }] }).ok, false, "unknown evidence id");
  const withAction = validateAnalystOutput({ ...good, actions: [{ type: "set_budget" }] });
  assert.equal(withAction.ok, false);
  assert.ok(!withAction.ok && withAction.errors.includes("output: unexpected key actions"));
  assert.equal(validateAnalystOutput({ ...good, findings: [{ ...good.findings[0], action: "pause_campaign" }] }).ok, false, "nested extra key");
  assert.equal(validateAnalystOutput({ ...good, confidence: "CERTAIN" }).ok, false);
  assert.equal(validateAnalystOutput({ ...good, hypotheses: [{ ...good.hypotheses[0], supporting_evidence: [] }] }).ok, false, "hypothesis needs support");
});

test("PA-1 / 59 (PA-4): analysis cache key changes with product / period / data / prompt / model / question", () => {
  const base = { shopId: "s", productId: "p", period: "this_week", dataVersion: "d1", promptVersion: "v1", modelFamily: "m", questionHash: "q" };
  assert.equal(analysisCacheKey(base), analysisCacheKey({ ...base }));
  for (const k of ["shopId", "productId", "period", "dataVersion", "promptVersion", "modelFamily", "questionHash"] as const) assert.notEqual(analysisCacheKey(base), analysisCacheKey({ ...base, [k]: "changed" }));
  assert.ok(!analysisCacheKey(base).includes("u-admin"), "no user in the key: access is re-checked before a cached answer is returned");
});

// ------------------------------------------------------------ supplier debt report
test("công nợ NCC: admin gets the report, unlinked / non-admin get nothing, failure is friendly", async () => {
  const { store, deps, sent, requests, msg } = setup();
  const parts = ["CÔNG NỢ NCC 20/11/2026\n\nTuấn Hậu\n- 05/11/2026: 1 đ"];
  let calls = 0;
  deps.supplierDebtReport = async () => (calls++, parts);

  // unlinked: the usual notice, never the report
  assert.equal(await handleIncomingConversationMessage(deps, msg("công nợ NCC", "9990001")), "unlinked");
  assert.equal(calls, 0);

  // linked but not admin: refused, report not even built
  linkAdmin(store, "5550002", "u-staff");
  assert.equal(await handleIncomingConversationMessage(deps, msg("công nợ NCC", "5550002")), "not_allowed");
  assert.equal(calls, 0);

  // admin with NO shop grants: report sent as-is, no shop needed and no analyst call
  linkAdmin(store, "5550001", "u-admin", []);
  assert.equal(await handleIncomingConversationMessage(deps, msg("Công nợ NCC")), "supplier_debt");
  assert.equal(calls, 1);
  assert.equal(sent[sent.length - 1].text, parts[0]);
  assert.equal(requests.length, 0);

  // failure -> friendly text, outcome supplier_debt_failed
  deps.supplierDebtReport = async () => {
    throw new Error("db down");
  };
  assert.equal(await handleIncomingConversationMessage(deps, msg("nợ nhà cung cấp")), "supplier_debt_failed");
  assert.equal(sent[sent.length - 1].text, MESSAGES.supplierDebtFailed);
});
