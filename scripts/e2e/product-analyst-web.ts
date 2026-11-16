// ============================================================
// PRODUCT-ANALYTICS-4 — web Product Analyst (Playwright) on the local replica.
// The dev server must run with the FAKE provider (no Anthropic call):
//   AI_PRODUCT_ANALYST_ENABLED=true AI_PRODUCT_ANALYST_WEB_ENABLED=true AI_PRODUCT_ANALYST_PROVIDER=fake next dev -p 3100
//
//   node --env-file=.env.local scripts/e2e/product-analyst-web.ts http://localhost:3100 <outDir> [devServerLog]
//
// Checks: entry from product detail (no model call on open), context bar,
// suggested question, structured answer, follow-up, one analysis at a time,
// shop-level question, permission change, staff (not in rollout), mobile
// 390 px, dark mode, keyboard, 0 Shopee calls. Throw-away users, removed after.
// ============================================================
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.argv[3] ?? ".";
const DEV_LOG = process.argv[4];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const TAG = `pa4web${Date.now()}`;
const PASSWORD = `Pw-${TAG}-x!`;
const results: Array<{ name: string; ok: boolean; msg?: string }> = [];
const facts: Record<string, unknown> = {};

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS ${name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 400) : String(e);
    results.push({ name, ok: false, msg });
    console.log(`  FAIL ${name} - ${msg}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const settle = (p: Page) => p.waitForLoadState("networkidle", { timeout: 180_000 }).catch(() => undefined);
const shot = async (p: Page, name: string) => {
  await p.waitForTimeout(700);
  await p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
};
async function login(p: Page, email: string) {
  await p.goto(`${BASE}/login`, { timeout: 180_000 });
  await p.fill('input[name="email"]', email);
  await p.fill('input[name="password"]', PASSWORD);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180_000 }), p.click('button[type="submit"]')]);
  await settle(p);
}
async function createUser(email: string, role: "admin" | "staff") {
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser");
  await db.from("profiles").update({ role, is_active: true, full_name: `PA4 ${role}` }).eq("id", data.user.id);
  return data.user.id;
}
const usage = async (uid: string) => (await db.from("ai_usage_logs").select("status, tool_trace, channel").eq("internal_user_id", uid).order("created_at")).data ?? [];
const apiCallsInLog = () => (DEV_LOG && existsSync(DEV_LOG) ? (readFileSync(DEV_LOG, "utf8").match(/shopee_api_call/g) ?? []).length : null);
const anthropicInLog = () => (DEV_LOG && existsSync(DEV_LOG) ? (readFileSync(DEV_LOG, "utf8").match(/api\.anthropic\.com/g) ?? []).length : null);
const answers = (p: Page) => p.locator('[data-role="assistant"]');

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { data: shops } = await db.from("shops").select("id, shop_name").like("shop_name", "[replica]%").order("shop_name");
  if (!shops?.length) throw new Error("load the replica first");
  const counts = await Promise.all(shops.map(async (s) => ({ ...s, n: (await db.from("shopee_product_sales_facts").select("id", { count: "exact", head: true }).eq("shop_id", s.id)).count ?? 0 })));
  counts.sort((a, b) => b.n - a.n);
  const shop = counts[0];
  const { data: sold } = await db.from("shopee_product_sales_facts").select("provider_item_id").eq("shop_id", shop.id).order("report_date", { ascending: false }).limit(1);
  const { data: product } = await db.from("shopee_products").select("id, name").eq("shop_id", shop.id).eq("provider_item_id", sold![0].provider_item_id).single();
  const admin = await createUser(`${TAG}a@example.test`, "admin");
  const staff = await createUser(`${TAG}s@example.test`, "staff");
  await db.from("ai_user_shop_access").insert([{ internal_user_id: admin, shop_id: shop.id }, { internal_user_id: staff, shop_id: shop.id }]);
  const jobs0 = (await db.from("channel_sync_jobs").select("*", { count: "exact", head: true })).count;
  const log0 = apiCallsInLog();

  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];
  const ctx = async (o: Parameters<Browser["newContext"]>[0] = {}) => {
    const c = await browser!.newContext({ viewport: { width: 1440, height: 900 }, ...o });
    contexts.push(c);
    return c;
  };
  try {
    browser = await chromium.launch();
    const page = await (await ctx()).newPage();
    await login(page, `${TAG}a@example.test`);

    await step("entry: product detail 'Phân tích với AI' opens the assistant with shop + product + period, no model call", async () => {
      await page.goto(`${BASE}/shopee/product-analytics/${product!.id}?period=30d`, { timeout: 180_000 });
      await settle(page);
      const ask = page.locator('[data-slot="ask-ai"]');
      expect(await ask.count() === 1, "button present");
      await Promise.all([page.waitForURL((u) => u.pathname === "/apps/shopee/ai", { timeout: 180_000 }), ask.click()]);
      await settle(page);
      const u = new URL(page.url());
      expect(u.searchParams.get("shop") === shop.id && u.searchParams.get("product") === product!.id && u.searchParams.get("period") === "30d", page.url());
      expect((await page.locator('[data-slot="assistant-product"]').innerText()).length > 3, "product chip");
      expect((await page.locator('[role="radio"][aria-checked="true"]').innerText()) === "30 ngày", "period");
      expect((await usage(admin)).length === 0, "opening the page never calls the analyst");
      const active = await page.locator('[data-slot="sidebar"] a[aria-current="page"]').allInnerTexts();
      expect(active.join().includes("Trợ lý phân tích"), `nav active ${active}`);
      await shot(page, "01-assistant-open");
    });

    await step("ask: suggested question → structured answer (summary, confidence, evidence), one usage row", async () => {
      await page.getByRole("button", { name: "Tại sao doanh số sản phẩm này giảm?" }).click();
      await answers(page).first().waitFor({ timeout: 120_000 });
      const card = answers(page).first().locator('[data-slot="analysis-card"]');
      await card.waitFor({ timeout: 60_000 });
      const text = await card.innerText();
      facts.first_answer = text.slice(0, 300);
      expect(/Độ tin cậy/.test(text), "confidence badge");
      expect(!/get_product|tool_use|\{"/.test(text), "no internals");
      const rows = await usage(admin);
      expect(rows.length === 1 && rows[0].status === "completed" && rows[0].channel === "web", JSON.stringify(rows));
      facts.first_tools = rows[0].tool_trace;
      await shot(page, "02-assistant-answer");
    });

    await step("follow-up with the keyboard (Enter), one analysis at a time", async () => {
      const input = page.locator("#assistant-input");
      await input.focus();
      await input.fill("Còn Ads thì sao?");
      await input.press("Enter");
      await input.press("Enter"); // ignored: empty / pending
      await page.waitForFunction(() => document.querySelectorAll('[data-role="assistant"]').length >= 2, null, { timeout: 120_000 });
      const rows = await usage(admin);
      expect(rows.length === 2, `usage rows ${rows.length}`);
      const { data: conv } = await db.from("ai_conversations").select("id").eq("channel", "web").eq("external_user_id", admin).single();
      const { count } = await db.from("ai_messages").select("id", { count: "exact", head: true }).eq("conversation_id", conv!.id).eq("direction", "inbound");
      expect(count === 2, `inbound ${count}`);
    });

    await step("shop-level question after clearing the product (shop attention tool)", async () => {
      await page.getByRole("button", { name: "Bỏ chọn sản phẩm (hỏi cấp shop)" }).click();
      await page.waitForURL((u) => !u.searchParams.get("product"), { timeout: 60_000 });
      await settle(page);
      await page.getByRole("button", { name: /Sản phẩm nào cần chú ý nhất/ }).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-role="assistant"]').length >= 3, null, { timeout: 120_000 });
      const rows = await usage(admin);
      expect(rows.at(-1)!.tool_trace.includes("get_shop_product_attention_summary"), JSON.stringify(rows.at(-1)));
      expect(rows.every((r) => r.status === "completed"), `every analysis completed: ${JSON.stringify(rows.map((r) => r.status))}`);
      expect((await answers(page).last().locator('[data-slot="analysis-card"]').count()) === 1, "shop answer is an analysis card");
      await shot(page, "03-assistant-shop-level");
    });

    await step("mutation request is refused without analysis", async () => {
      const before = (await usage(admin)).length;
      const input = page.locator("#assistant-input");
      await input.fill("Tăng budget chiến dịch lên 500k");
      await input.press("Enter");
      await page.waitForFunction(() => document.querySelectorAll('[data-role="assistant"]').length >= 4, null, { timeout: 60_000 });
      expect(/không thay đổi chiến dịch/.test(await answers(page).last().innerText()), "refusal text");
      expect((await usage(admin)).length === before, "no analysis run");
    });

    await step("permission change: revoked shop grant → denied answer, then the page asks to choose shops", async () => {
      await db.from("ai_user_shop_access").delete().eq("internal_user_id", admin);
      const input = page.locator("#assistant-input");
      await input.fill("Sản phẩm nào yếu nhất kỳ này?");
      await input.press("Enter");
      await page.waitForFunction(() => document.querySelectorAll('[data-role="assistant"]').length >= 5, null, { timeout: 60_000 });
      expect(/không có quyền/.test(await answers(page).last().innerText()), "denied");
      await page.reload();
      await settle(page);
      expect((await page.getByText("Bạn chưa chọn shop nào cho trợ lý").count()) === 1, "no-grant state");
      await db.from("ai_user_shop_access").insert({ internal_user_id: admin, shop_id: shop.id });
    });

    await step("staff (not in rollout): assistant not available, nav shows 'Sắp có', no analysis possible", async () => {
      const p = await (await ctx()).newPage();
      await login(p, `${TAG}s@example.test`);
      await p.goto(`${BASE}/apps/shopee/ai`);
      await settle(p);
      expect((await p.getByText("Trợ lý phân tích đang mở cho quản trị viên trước").count()) === 1, "rollout notice");
      expect((await p.locator('[data-slot="sidebar"] [data-nav-soon]', { hasText: "Trợ lý phân tích" }).count()) === 1, "nav soon");
      expect((await p.locator("#assistant-input").count()) === 0, "no composer");
      expect((await usage(staff)).length === 0);
    });

    await step("390 px: no horizontal overflow, composer reachable, answer readable", async () => {
      const m = await (await ctx({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
      await login(m, `${TAG}a@example.test`);
      await m.goto(`${BASE}/apps/shopee/ai?shop=${shop.id}&product=${product!.id}`);
      await settle(m);
      const ov = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      facts.mobile_overflow = ov;
      expect(ov <= 0, `overflow ${ov}`);
      const box = await m.locator("#assistant-input").boundingBox();
      expect(box && box.height >= 36, "composer present");
      await m.locator("#assistant-input").scrollIntoViewIfNeeded();
      const inView = await m.locator("#assistant-input").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom <= window.innerHeight && r.top >= 0;
      });
      expect(inView, "composer in the viewport");
      await shot(m, "04-assistant-mobile");
    });

    await step("dark mode: assistant on dark tokens", async () => {
      const dctx = await ctx({ colorScheme: "dark" });
      await dctx.addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark")));
      const d = await dctx.newPage();
      await login(d, `${TAG}a@example.test`);
      await d.goto(`${BASE}/apps/shopee/ai?shop=${shop.id}`);
      await settle(d);
      await d.evaluate(() => document.documentElement.classList.add("dark"));
      const bg = await d.evaluate(() => getComputedStyle(document.body).backgroundColor);
      facts.dark_bg = bg;
      const m = bg.match(/[\d.]+/g)?.map(Number) ?? [255];
      expect((bg.startsWith("lab") || bg.startsWith("oklch") ? m[0] : (m[0] / 255) * 100) < 30, `dark bg ${bg}`);
      await shot(d, "05-assistant-dark");
    });

    await step("zero Shopee calls; the fake provider never reached Anthropic", async () => {
      const jobs1 = (await db.from("channel_sync_jobs").select("*", { count: "exact", head: true })).count;
      facts.jobs = { before: jobs0, after: jobs1, shopee_api_call_log: [log0, apiCallsInLog()], anthropic_in_log: anthropicInLog() };
      expect(jobs1 === jobs0, `jobs ${jobs0} → ${jobs1}`);
      if (log0 !== null) expect(apiCallsInLog() === log0, "shopee_api_call");
      expect(!anthropicInLog(), "no Anthropic endpoint");
      const rows = await usage(admin);
      facts.usage = rows.map((r) => [r.status, r.tool_trace.length]);
    });
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
    for (const id of [admin, staff]) {
      await db.from("ai_usage_logs").delete().eq("internal_user_id", id);
      await db.from("ai_conversations").delete().eq("internal_user_id", id);
      await db.from("ai_user_shop_access").delete().eq("internal_user_id", id);
      await db.auth.admin.deleteUser(id);
    }
    await db.from("ai_analysis_cache").delete().eq("shop_id", shop.id);
  }
  console.log(JSON.stringify({ facts }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
