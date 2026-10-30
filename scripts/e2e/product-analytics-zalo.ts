// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1 — end to end against the LOCAL DB + the real
// Shopee SANDBOX gateway (product probe) + signed Zalo webhook requests.
//
//   ZALO_CONVERSATION_ENABLED=true ZALO_OA_SECRET_KEY=e2e-oa-secret ZALO_ACCESS_TOKEN= \
//   SHOPEE_TOKEN_KEEPALIVE_HOURS=100000 npx next start -p 3100
//   node --env-file=.env.local scripts/e2e/product-analytics-zalo.ts http://localhost:3100
//
// Proves: the admin probe page reads get_item_extra_info for the sandbox
// shop (control 404 + 1 read = 2 requests) and stores one snapshot; the
// /settings/zalo-agent page issues a one-time code and saves shop grants;
// the webhook rejects unsigned requests, accepts a signed "LINK <code>",
// links the account, ignores a redelivery, keeps product context across
// "còn hôm qua?", denies a non-granted shop, ignores unsupported events.
// Outbound Zalo stays OFFLINE: no local Zalo token → the send fails before
// any network call and is recorded as failed (nothing reaches Zalo).
// Throw-away admin + shop; every row created here is removed.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";
import { createHash } from "node:crypto";

const BASE = process.argv[2] ?? "http://localhost:3100";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("E2E này chỉ chạy với DB local.");
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const APP_ID = process.env.ZALO_APP_ID!;
const OA_ID = process.env.ZALO_OA_ID!;
const OA_SECRET = "e2e-oa-secret";
const TAG = Date.now();
const EMAIL = `e2e-pa1-${TAG}@example.test`;
const PASSWORD = `E2e-${Math.random().toString(36).slice(2)}-Pw!`;
const ZALO_USER = `66${TAG}`.slice(0, 15);
const SANDBOX_ITEMS = "803945994, 803946028, 803945993, 803945992";

const results: Array<{ name: string; ok: boolean }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  PASS ${name}${detail ? ` - ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name} - ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
async function webhook(body: Record<string, unknown>, opts: { sign?: boolean } = {}) {
  const ts = String(Date.now());
  const raw = JSON.stringify({ app_id: APP_ID, timestamp: ts, recipient: { id: OA_ID }, ...body });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sign !== false) headers["x-zevent-signature"] = `mac=${createHash("sha256").update(`${APP_ID}${raw}${ts}${OA_SECRET}`).digest("hex")}`;
  const res = await fetch(`${BASE}/api/zalo/webhook`, { method: "POST", headers, body: raw });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const text = (t: string, msgId = `e2e-${TAG}-${++seq}`) => ({ event_name: "user_send_text", sender: { id: ZALO_USER }, message: { msg_id: msgId, text: t } });

async function inboundStatus(msgId: string, want: (s: string) => boolean) {
  for (let i = 0; i < 40; i++) {
    const { data } = await admin.from("ai_messages").select("processing_status").eq("provider_message_id", msgId).eq("direction", "inbound").maybeSingle();
    if (data && want(data.processing_status)) return data.processing_status as string;
    await sleep(250);
  }
  throw new Error(`message ${msgId} not processed`);
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { timeout: 180_000 });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180_000 }), page.click('button[type="submit"]')]);
}

async function main() {
  const { data: sandbox } = await admin.from("shops").select("id, shop_name").eq("channel", "shopee").eq("data_source", "live").limit(1).maybeSingle();
  if (!sandbox) throw new Error("Cần shop sandbox live đang kết nối trong DB local.");
  const { data: beta, error: betaErr } = await admin.from("shops").insert({ channel: "shopee", external_shop_id: `e2epa1${TAG}`, shop_name: `E2E Gối Beta ${TAG}`, data_source: "fixture" }).select("id").single();
  if (betaErr) throw betaErr;
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw error ?? new Error("createUser failed");
  const userId = created.user.id;
  await admin.from("profiles").upsert({ id: userId, role: "admin", is_active: true, full_name: "E2E PA1" });
  const probeSince = new Date().toISOString();

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await login(page);

    await check("probe page: real sandbox get_item_extra_info, 2 requests, 4 items, snapshot stored", async () => {
      await page.goto(`${BASE}/shopee/product-analytics/probe`, { timeout: 180_000 });
      await page.selectOption('select[aria-label="Shop"]', sandbox.id);
      await page.fill('input[aria-label="Item id"]', SANDBOX_ITEMS);
      await page.fill('input[aria-label="Xác nhận chỉ đọc"]', "READ-ONLY");
      await page.click("text=Chạy probe chỉ đọc");
      const result = page.locator('section[aria-label="Kết quả probe"]');
      await result.waitFor({ timeout: 60_000 });
      const banner = await result.innerText();
      expect(banner.includes("2/12 request"), `request count: ${banner.slice(0, 200)}`);
      expect(banner.includes("control: ENDPOINT_NOT_FOUND") && banner.includes("get_item_extra_info: OK"), "classifications");
      const rows = await result.locator("tbody tr").count();
      expect(rows === 4, `rows ${rows}`);
      const { data: snaps } = await admin.from("channel_api_snapshots").select("payload").eq("entity_type", "product_analytics_probe").gte("synced_at", probeSince);
      expect(snaps?.length === 1, `snapshots ${snaps?.length}`);
      const p = snaps![0].payload as { environment: string; comparisons: Array<{ returned: boolean }> };
      expect(p.environment === "sandbox" && p.comparisons.every((c) => c.returned), "snapshot content");
      return "SANDBOX · control 404 · 4/4 returned";
    });

    let code = "";
    await check("zalo-agent page: one-time code shown once, stored as hash; shop grant saved", async () => {
      await page.goto(`${BASE}/settings/zalo-agent`, { timeout: 180_000 });
      await page.click("text=Tạo mã liên kết");
      const codeEl = page.locator("code", { hasText: "LINK " });
      await codeEl.waitFor({ timeout: 30_000 });
      code = (await codeEl.innerText()).replace("LINK ", "").trim();
      expect(/^[A-Z2-9]{8}$/.test(code), `code ${code}`);
      const { data: codes } = await admin.from("zalo_link_codes").select("code_hash").eq("internal_user_id", userId);
      expect(codes?.length === 1 && codes[0].code_hash === createHash("sha256").update(code).digest("hex"), "hash stored, not the code");
      await page.getByLabel(sandbox.shop_name).check();
      await page.click("text=Lưu quyền shop");
      await page.locator("text=Đã lưu quyền shop cho trợ lý.").waitFor({ timeout: 30_000 });
      const { data: access } = await admin.from("ai_user_shop_access").select("shop_id").eq("internal_user_id", userId);
      expect(access?.length === 1 && access[0].shop_id === sandbox.id, "grant");
    });

    await check("webhook: unsigned → 401, bad signature → 401, unsupported event → ignored", async () => {
      expect((await webhook(text("hi"), { sign: false })).status === 401, "unsigned");
      const forged = await fetch(`${BASE}/api/zalo/webhook`, { method: "POST", headers: { "x-zevent-signature": `mac=${"a".repeat(64)}` }, body: JSON.stringify({ app_id: APP_ID, timestamp: String(Date.now()), ...text("hi") }) });
      expect(forged.status === 401, `forged ${forged.status}`);
      const follow = await webhook({ event_name: "follow", follower: { id: ZALO_USER } });
      expect(follow.status === 200 && follow.body.ignored === "unsupported_event", JSON.stringify(follow.body));
      const { count } = await admin.from("ai_conversations").select("id", { count: "exact", head: true }).eq("external_user_id", ZALO_USER);
      expect(count === 0, "nothing stored for rejected / unsupported");
    });

    await check("webhook: signed LINK → linked; redelivery → duplicate (one row)", async () => {
      const msgId = `e2e-link-${TAG}`;
      const r = await webhook(text(`LINK ${code}`, msgId));
      expect(r.status === 200 && r.body.accepted === true, JSON.stringify(r.body));
      await inboundStatus(msgId, (s) => s !== "pending");
      const { data: link } = await admin.from("zalo_user_links").select("internal_user_id, status").eq("zalo_user_id", ZALO_USER).maybeSingle();
      expect(link?.internal_user_id === userId && link.status === "active", "link row");
      const again = await webhook(text(`LINK ${code}`, msgId));
      expect(again.body.ignored === "duplicate", JSON.stringify(again.body));
      const { data: rows } = await admin.from("ai_messages").select("text").eq("provider_message_id", msgId);
      expect(rows?.length === 1 && rows[0].text === "[mã liên kết]", "one redacted row");
    });

    await check("webhook: product question + 'còn hôm qua?' keep the product; outbound offline → recorded failed", async () => {
      const m1 = `e2e-q1-${TAG}`;
      await webhook(text("phân tích sản phẩm thảm lông cừu tuần này", m1));
      await inboundStatus(m1, (s) => s !== "pending");
      const m2 = `e2e-q2-${TAG}`;
      await webhook(text("còn hôm qua?", m2));
      await inboundStatus(m2, (s) => s !== "pending");
      const { data: conv } = await admin.from("ai_conversations").select("id, current_shop_id, last_intent, context").eq("external_user_id", ZALO_USER).single();
      expect(conv.current_shop_id === sandbox.id && conv.last_intent === "PRODUCT_ANALYSIS", "context shop / intent");
      expect(conv.context.productQuery === "thảm lông cừu" && conv.context.period === "yesterday", JSON.stringify(conv.context));
      const { data: out } = await admin.from("ai_messages").select("text, processing_status").eq("conversation_id", conv.id).eq("direction", "outbound").order("created_at");
      const last = out!.at(-1)!;
      expect(last.text.includes("“thảm lông cừu”") && last.text.includes("hôm qua") && last.text.includes("Hệ thống phân tích sản phẩm đang được chuẩn bị."), last.text);
      expect(out!.every((o) => o.processing_status === "failed"), "no Zalo token locally → send failed, nothing left the machine");
      return `${out!.length} outbound rows (failed, offline)`;
    });

    await check("webhook: question about a non-granted shop → denied", async () => {
      const m = `e2e-deny-${TAG}`;
      await webhook(text(`Shop E2E Gối Beta ${TAG} hôm qua thế nào?`, m));
      await inboundStatus(m, (s) => s !== "pending");
      const { data: conv } = await admin.from("ai_conversations").select("id").eq("external_user_id", ZALO_USER).single();
      const { data: out } = await admin.from("ai_messages").select("text").eq("conversation_id", conv.id).eq("direction", "outbound").order("created_at", { ascending: false }).limit(1);
      expect(out?.[0]?.text === "Bạn không có quyền xem shop này.", out?.[0]?.text ?? "none");
    });
  } finally {
    await browser?.close();
    await admin.from("ai_conversations").delete().eq("external_user_id", ZALO_USER);
    await admin.from("zalo_user_links").delete().eq("zalo_user_id", ZALO_USER);
    await admin.from("zalo_link_codes").delete().eq("internal_user_id", userId);
    await admin.from("ai_user_shop_access").delete().eq("internal_user_id", userId);
    await admin.from("channel_api_snapshots").delete().eq("entity_type", "product_analytics_probe").gte("synced_at", probeSince);
    await admin.from("shops").delete().eq("id", beta.id);
    await admin.auth.admin.deleteUser(userId);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
