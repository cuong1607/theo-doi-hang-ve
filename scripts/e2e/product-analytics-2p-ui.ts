// ============================================================
// PRODUCT-ANALYTICS-2P — UI review on the local replica (load --facts=cloud):
// production facts as they are (no shop backfilled). Throw-away admin, removed after.
//
//   node --env-file=.env.local scripts/e2e/product-analytics-2p-ui.ts http://localhost:3100 <outDir>
//
// Checks: missing ≠ zero (no exact sales / Δ for non-backfilled shops), callouts,
// mobile horizontal overflow, dark mode, payload / timing; screenshots of
// Product Analytics next to the Shopee Ads dashboard for the design review.
// ============================================================
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.argv[3] ?? ".";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const TAG = `pa2pui${Date.now()}`;
const EMAIL = `${TAG}@example.test`;
const PASSWORD = `Pw-${TAG}-x!`;

const results: Array<{ name: string; ok: boolean; msg?: string }> = [];
const facts: Record<string, unknown> = {};
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS ${name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : String(e);
    results.push({ name, ok: false, msg });
    console.log(`  FAIL ${name} - ${msg}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { timeout: 180_000 });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180_000 }), page.click('button[type="submit"]')]);
}

async function overflowX(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 180_000 }).catch(() => undefined);
  await page.locator("h1").first().waitFor({ timeout: 180_000 });
}

async function shot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { data: shops } = await admin.from("shops").select("id, shop_name").like("shop_name", "[replica]%").order("shop_name");
  expect(shops && shops.length === 5, "cần replica 5 shop (product-analytics-replica.ts load <dir> --facts=cloud)");
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw error ?? new Error("createUser");
  const userId = created.user.id;
  await admin.from("profiles").update({ role: "admin", is_active: true, full_name: "PA2P UI" }).eq("id", userId);

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const desktop: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktop.newPage();
    await login(page);

    await step("list (all shops, 7d): non-backfilled shops show lower bound / '—', never an exact sales Δ", async () => {
      await page.goto(`${BASE}/shopee/product-analytics?period=7d`, { timeout: 180_000 });
      await page.goto(`${BASE}/shopee/product-analytics?period=7d`); // warm
      const t = Date.now();
      const resp = await page.goto(`${BASE}/shopee/product-analytics?period=7d`);
      facts.list_all_7d_ms = Date.now() - t;
      facts.list_all_7d_html_kb = Math.round(((await resp?.body())?.length ?? 0) / 1024);
      await settle(page);
      await page.screenshot({ path: path.join(OUT, "00-debug.png"), fullPage: false });
      facts.list_text_head = (await page.locator("main").last().innerText()).slice(0, 900);
      facts.list_all_7d_server_ms = await page.locator("header, main").first().evaluate(() => (document.body.innerText.match(/(\d+) ms/) ?? [])[1] ?? null);
      expect(await page.getByText("Doanh số chưa đầy đủ").count() > 0, "callout 'Doanh số chưa đầy đủ'");
      const rows = page.locator("table").first().locator("tbody tr");
      const n = await rows.count();
      expect(n > 0, "rows");
      let lowerBound = 0;
      let exactDelta = 0;
      for (let i = 0; i < Math.min(n, 50); i++) {
        const cells = rows.nth(i).locator("td");
        const sales = (await cells.nth(1).innerText()).trim();
        const delta = (await cells.nth(4).innerText()).trim();
        if (sales.startsWith("≥") || sales === "—") lowerBound++;
        if (/%/.test(delta)) exactDelta++;
      }
      facts.list_rows_checked = Math.min(n, 50);
      expect(lowerBound === Math.min(n, 50), `every sales cell is ≥ / — (got ${lowerBound}/${Math.min(n, 50)})`);
      expect(exactDelta === 0, `no sales Δ % (got ${exactDelta})`);
      expect(await page.getByText("Chưa đủ dữ liệu").count() > 0, "row badge");
      await shot(page, "01-list-desktop-light");
    });

    await step("list (all shops, 30d) timing + payload", async () => {
      const t = Date.now();
      const resp = await page.goto(`${BASE}/shopee/product-analytics?period=30d`);
      facts.list_all_30d_ms = Date.now() - t;
      facts.list_all_30d_html_kb = Math.round(((await resp?.body())?.length ?? 0) / 1024);
      facts.list_dom_rows = await page.locator("table").first().locator("tbody tr").count();
      const nav = await page.evaluate(() => {
        const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        return { ttfb: Math.round(e.responseStart), domContentLoaded: Math.round(e.domContentLoadedEventEnd), load: Math.round(e.loadEventEnd) };
      });
      facts.list_all_30d_nav = nav;
    });

    const { data: top } = await admin.from("shopee_product_sales_facts").select("shop_id, provider_item_id").in("shop_id", shops.map((s) => s.id)).limit(2000);
    const perShop = new Map<string, string>();
    for (const f of top ?? []) if (!perShop.has(f.shop_id)) perShop.set(f.shop_id, f.provider_item_id);
    let i = 0;
    for (const s of shops) {
      const item = perShop.get(s.id);
      const { data: p } = item
        ? await admin.from("shopee_products").select("id").eq("shop_id", s.id).eq("provider_item_id", item).single()
        : await admin.from("shopee_products").select("id").eq("shop_id", s.id).limit(1).single();
      if (!p) continue;
      i++;
      await step(`detail ${s.shop_name}: coverage callout, sales tiles not exact, chart note`, async () => {
        const t = Date.now();
        await page.goto(`${BASE}/shopee/product-analytics/${p.id}?period=7d`, { timeout: 180_000 });
        facts[`detail_${i}_ms`] = Date.now() - t;
        await settle(page);
        if (i === 1) facts.detail_text_head = (await page.locator("main").last().innerText()).slice(0, 1500);
        expect(await page.getByText("Doanh số chưa đầy đủ").count() > 0, "callout");
        expect(await page.getByText("chưa đủ dữ liệu", { exact: false }).count() > 0, "tile state");
        expect(await page.getByText("Chưa có ngày nào đủ dữ liệu đơn hàng", { exact: false }).count() > 0, "chart note");
        if (i === 1) await shot(page, "02-detail-desktop-light");
      });
    }

    await step("Shopee Ads dashboard screenshot (design reference)", async () => {
      await page.goto(`${BASE}/shopee/ads`, { timeout: 180_000 });
      await shot(page, "03-ads-desktop-light");
    });

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const m = await mobile.newPage();
    await login(m);
    await step("mobile 390 px: horizontal overflow of list / detail / Ads", async () => {
      await m.goto(`${BASE}/shopee/product-analytics?period=7d`, { timeout: 180_000 });
      facts.mobile_list_overflow_px = await overflowX(m);
      await shot(m, "04-list-mobile");
      const firstLink = m.locator("table").first().locator("tbody tr a").first();
      await firstLink.click();
      await m.waitForURL(/product-analytics\/[0-9a-f-]{36}/, { timeout: 180_000 });
      facts.mobile_detail_overflow_px = await overflowX(m);
      await shot(m, "05-detail-mobile");
      await m.goto(`${BASE}/shopee/ads`, { timeout: 180_000 });
      facts.mobile_ads_overflow_px = await overflowX(m);
      await shot(m, "06-ads-mobile");
    });

    const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    // the app has .dark tokens but no theme switcher: force the class to review both pages on them
    await dark.addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark")));
    const d = await dark.newPage();
    await login(d);
    await step("dark mode: list + detail render on dark background", async () => {
      await d.goto(`${BASE}/shopee/product-analytics?period=7d`, { timeout: 180_000 });
      facts.dark_bg = await d.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await shot(d, "07-list-desktop-dark");
      await d.locator("table").first().locator("tbody tr a").first().click();
      await d.waitForURL(/product-analytics\/[0-9a-f-]{36}/, { timeout: 180_000 });
      await shot(d, "08-detail-desktop-dark");
      await d.goto(`${BASE}/shopee/ads`, { timeout: 180_000 });
      await shot(d, "09-ads-desktop-dark");
    });
  } finally {
    await browser?.close();
    await admin.auth.admin.deleteUser(userId);
  }
  console.log(JSON.stringify({ facts, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) }, null, 2));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

await main();
