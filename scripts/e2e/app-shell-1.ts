// ============================================================
// APP-SHELL-1 — multi-app launcher + domain shells (Playwright) on the local
// stack. Throw-away admin / staff / viewer users, removed after.
//
//   node --env-file=.env.local scripts/e2e/app-shell-1.ts http://localhost:3100 <outDir> [devServerLog]
//
// Checks: auth (anonymous, deep link kept, plain login → /apps), hub cards
// (open / soon / hidden), card + keyboard navigation, app switcher (Shopee →
// accounting → hub), domain sidebars, active item from URL, direct routes,
// limited access (staff, viewer), aliases, coming-soon shells, regression
// (Ads, product analytics, legacy redirect), 390 px drawer, dark mode,
// reduced motion, 0 provider calls while browsing.
// ============================================================
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.argv[3] ?? ".";
const DEV_LOG = process.argv[4];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const TAG = `shell${Date.now()}`;
const users = { admin: `${TAG}a@example.test`, staff: `${TAG}s@example.test`, viewer: `${TAG}v@example.test` } as const;
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

async function login(page: Page, email: string, startPath = "/login") {
  await page.goto(`${BASE}${startPath}`, { timeout: 180_000 });
  await page.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 180_000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180_000 }), page.click('button[type="submit"]')]);
  await settle(page);
}
async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 180_000 }).catch(() => undefined);
}
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
// entrances play once (~300 ms + stagger): let them finish before the picture
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
};
const apiCallsInLog = () => (DEV_LOG && existsSync(DEV_LOG) ? (readFileSync(DEV_LOG, "utf8").match(/shopee_api_call/g) ?? []).length : null);
const dbWrites = async () => {
  const [{ count: jobs }, { count: snaps }] = await Promise.all([
    db.from("channel_sync_jobs").select("*", { count: "exact", head: true }),
    db.from("channel_api_snapshots").select("*", { count: "exact", head: true }),
  ]);
  return { jobs, snaps };
};
const shell = (page: Page) => page.locator("[data-app-shell]").first().getAttribute("data-app-shell");
const sidebarLinks = (page: Page) => page.locator('[data-slot="sidebar"] nav a').allInnerTexts().then((t) => t.map((s) => s.trim()).filter(Boolean));
const lightness = (rgb: string) => {
  const m = rgb.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255];
  if (rgb.startsWith("oklch") || rgb.startsWith("lab")) return m[0] <= 1 ? m[0] * 100 : m[0];
  return ((Math.max(m[0], m[1], m[2]) + Math.min(m[0], m[1], m[2])) / 2 / 255) * 100;
};

async function createUser(email: string, role: "admin" | "staff" | "viewer") {
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser");
  await db.from("profiles").update({ role, is_active: true, full_name: `Shell ${role[0].toUpperCase()}${role.slice(1)}` }).eq("id", data.user.id);
  return data.user.id;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const ids = [await createUser(users.admin, "admin"), await createUser(users.staff, "staff"), await createUser(users.viewer, "viewer")];
  const writes0 = await dbWrites();
  const log0 = apiCallsInLog();
  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];
  const ctx = async (opts: Parameters<Browser["newContext"]>[0] = {}) => {
    const c = await browser!.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
    contexts.push(c);
    return c;
  };
  try {
    browser = await chromium.launch();

    // ---------------------------------------------------------------- auth
    await step("auth: anonymous /apps and /apps/shopee → /login with ?next (no loop)", async () => {
      const p = await (await ctx()).newPage();
      for (const target of ["/apps", "/apps/shopee", "/shopee/ads"]) {
        await p.goto(`${BASE}${target}`, { timeout: 180_000 });
        const u = new URL(p.url());
        expect(u.pathname === "/login" && u.searchParams.get("next") === target, `${target} → ${p.url()}`);
      }
      const res = await p.request.get(`${BASE}/apps`, { maxRedirects: 0 });
      expect(res.status() === 307 || res.status() === 302, `anonymous /apps status ${res.status()}`);
    });

    await step("auth: deep link survives login (/shopee/ads → login → /shopee/ads)", async () => {
      const p = await (await ctx()).newPage();
      await login(p, users.admin, "/shopee/ads");
      expect(new URL(p.url()).pathname === "/shopee/ads", `landed on ${p.url()}`);
      expect((await shell(p)) === "shopee", "Ads renders inside the Shopee shell");
    });

    const adminCtx = await ctx();
    const page = await adminCtx.newPage();
    await step("auth: plain login → /apps (App Hub), '/' → /apps, /login while signed in → /apps", async () => {
      await login(page, users.admin);
      expect(new URL(page.url()).pathname === "/apps", `after login: ${page.url()}`);
      await page.goto(`${BASE}/`);
      await page.waitForURL((u) => u.pathname === "/apps", { timeout: 60_000 });
      await page.goto(`${BASE}/login`);
      expect(new URL(page.url()).pathname === "/apps", `/login signed in → ${page.url()}`);
    });

    // ---------------------------------------------------------------- hub
    await step("hub: greeting + 6 cards for admin (2+1 open, 3 'Sắp có'), Shopee live status", async () => {
      await page.goto(`${BASE}/apps`);
      await settle(page);
      expect((await page.locator("h1").innerText()).includes("Bạn muốn làm gì hôm nay?"), "greeting h1");
      expect(await page.getByText("Chọn một khu vực để bắt đầu").isVisible(), "subtext");
      const cards = await page.locator("[data-app-card]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-app-card"), e.getAttribute("data-access"), e.tagName]));
      facts.hub_cards = cards;
      expect(JSON.stringify(cards) === JSON.stringify([["accounting", "open", "A"], ["shopee", "open", "A"], ["purchasing", "soon", "DIV"], ["creative", "soon", "DIV"], ["marketing", "soon", "DIV"], ["system", "open", "A"]]), JSON.stringify(cards));
      expect((await page.locator('[data-app-card="accounting"] h2').innerText()) === "Theo dõi hàng về", "accounting card name");
      const status = await page.locator('[data-app-card="shopee"] [data-slot="hub-card-status"]').innerText().catch(() => "");
      facts.shopee_card_status = status;
      expect(/shop/.test(status), `shopee status: ${status}`);
      await shot(page, "01-hub-desktop");
      const cols = await page.locator("ul[aria-label='Ứng dụng']").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      expect(cols === 3, `desktop grid has ${cols} columns`);
    });

    await step("hub: disabled cards don't navigate (no href, aria-disabled, click stays)", async () => {
      const soon = page.locator('[data-app-card="purchasing"]');
      expect((await soon.getAttribute("aria-disabled")) === "true" && (await soon.getAttribute("href")) === null, "inert");
      await soon.click();
      await page.waitForTimeout(400);
      expect(new URL(page.url()).pathname === "/apps", `stayed on hub (${page.url()})`);
    });

    await step("hub: keyboard — Tab reaches open cards only, Enter opens the app", async () => {
      await page.goto(`${BASE}/apps`);
      await settle(page);
      const reached: string[] = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        const id = await page.evaluate(() => document.activeElement?.getAttribute("data-app-card") ?? null);
        if (id) reached.push(id);
        if (id === "shopee") break;
      }
      expect(reached.join() === "accounting,shopee", `tab order ${reached.join()}`);
      const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow);
      expect(ring && ring !== "none", "visible focus ring");
      await Promise.all([page.waitForURL((u) => u.pathname === "/apps/shopee", { timeout: 120_000 }), page.keyboard.press("Enter")]);
      await settle(page);
    });

    // ---------------------------------------------------------------- shopee shell
    await step("shopee shell: landing, own sidebar only, AI assistant 'Sắp có', sync health per shop", async () => {
      expect((await shell(page)) === "shopee", "shopee shell");
      const links = await sidebarLinks(page);
      facts.shopee_sidebar = links;
      for (const t of ["Tổng quan", "Quảng cáo", "Phân tích sản phẩm", "Sản phẩm cần chú ý", "Shop Shopee", "Sức khỏe đồng bộ"]) expect(links.includes(t), `has ${t}`);
      for (const t of ["Giá vốn", "Hóa đơn", "Công nợ NCC", "Đối soát", "Dòng tiền", "Hoàn trả"]) expect(!links.includes(t), `no ${t}`);
      const ai = page.locator('[data-slot="sidebar"] [data-nav-soon]', { hasText: "Trợ lý phân tích" });
      expect((await ai.count()) === 1 && (await ai.isDisabled()), "assistant disabled");
      expect((await page.locator('[data-slot="sidebar"] a', { hasText: "Trợ lý phân tích" }).count()) === 0, "assistant is not a link");
      const shops = await page.locator("[data-shop-health]").count();
      facts.shopee_landing_shops = shops;
      const { count: live } = await db.from("shops").select("*", { count: "exact", head: true }).eq("channel", "shopee").eq("data_source", "live").eq("is_active", true);
      expect(shops === (live ?? 0), `health cards ${shops} = live shops ${live}`);
      facts.shopee_health_text = (await page.locator("#suc-khoe-dong-bo").innerText()).slice(0, 400);
      expect((await page.locator('[aria-current="page"]', { hasText: "Tổng quan" }).count()) === 1, "Tổng quan active");
      await shot(page, "02-shopee-landing");
    });

    await step("switcher: Shopee → Theo dõi hàng về → Tất cả ứng dụng (current marked, soon disabled)", async () => {
      await page.locator('[data-slot="app-switcher"]').click();
      const menu = page.locator('[data-slot="dropdown-menu-content"]');
      await menu.waitFor();
      expect((await menu.locator('[data-app-id="shopee"][data-current]').count()) === 1, "Shopee marked current");
      expect((await menu.locator('[data-app-id="purchasing"][data-disabled]').count()) === 1, "Gọi hàng disabled");
      await shot(page, "03-switcher-open");
      await Promise.all([page.waitForURL((u) => u.pathname === "/dashboard", { timeout: 120_000 }), menu.locator('[data-app-id="accounting"]').click()]);
      await settle(page);
      expect((await shell(page)) === "accounting", "accounting shell");
      const links = await sidebarLinks(page);
      facts.accounting_sidebar = links;
      for (const t of ["Tổng quan", "Nhập hàng", "Lịch sử hàng về", "Hóa đơn", "Giá vốn", "Nhà cung cấp"]) expect(links.includes(t), `has ${t}`);
      for (const t of ["Quảng cáo", "Phân tích sản phẩm", "Trợ lý phân tích", "Đơn hàng Shopee", "Đối soát"]) expect(!links.includes(t), `no ${t}`);
      const crumbs = await page.locator('nav[aria-label="Đường dẫn"]').innerText();
      expect(crumbs.includes("Ứng dụng") && crumbs.includes("Theo dõi hàng về"), `crumbs ${crumbs}`);
      await shot(page, "04-accounting-dashboard");
      await page.locator('[data-slot="app-switcher"]').click();
      await Promise.all([page.waitForURL((u) => u.pathname === "/apps", { timeout: 120_000 }), page.locator('[data-slot="dropdown-menu-content"]').getByText("Tất cả ứng dụng").click()]);
    });

    await step("direct route: /shopee/product-analytics?health=ATTENTION → Shopee shell, 'Sản phẩm cần chú ý' active, breadcrumb", async () => {
      await page.goto(`${BASE}/shopee/product-analytics?health=ATTENTION`, { timeout: 180_000 });
      await settle(page);
      expect((await shell(page)) === "shopee", "shopee shell");
      const active = await page.locator('[data-slot="sidebar"] a[aria-current="page"]').allInnerTexts();
      expect(active.length === 1 && active[0].includes("Sản phẩm cần chú ý"), `active ${active}`);
      expect((await page.locator("header h1").innerText()) === "Sản phẩm cần chú ý", "title");
      expect((await page.locator('nav[aria-label="Đường dẫn"]').innerText()).includes("Phân tích Shopee"), "crumb app");
      await page.goto(`${BASE}/shopee/product-analytics`);
      await settle(page);
      const active2 = await page.locator('[data-slot="sidebar"] a[aria-current="page"]').allInnerTexts();
      expect(active2.length === 1 && active2[0].includes("Phân tích sản phẩm"), `active ${active2}`);
      expect((await page.locator('[data-slot="pa-filter-bar"]').count()) === 1, "PA-3 page still renders (filters + list / empty state)");
      await shot(page, "05-product-analytics-in-shell");
    });

    await step("regression: Ads page (read only) + detail page + legacy redirect + aliases", async () => {
      await page.goto(`${BASE}/shopee/ads`, { timeout: 180_000 });
      await settle(page);
      expect((await shell(page)) === "shopee", "ads in shopee shell");
      expect((await page.locator("[data-ads-root]").count()) > 0, "Ads dashboard rendered");
      expect((await page.locator('[data-slot="sidebar"] a[aria-current="page"]').allInnerTexts()).join() .includes("Quảng cáo"), "Quảng cáo active");
      await page.goto(`${BASE}/shopee/payouts`);
      expect(new URL(page.url()).pathname === "/shopee/ads", `legacy /shopee/payouts → ${page.url()}`);
      await page.goto(`${BASE}/apps/accounting`);
      expect(new URL(page.url()).pathname === "/dashboard", `/apps/accounting → ${page.url()}`);
      await page.goto(`${BASE}/apps/system`);
      expect(new URL(page.url()).pathname === "/users", `/apps/system → ${page.url()}`);
      expect((await shell(page)) === "system", "users in system shell");
    });

    await step("coming-soon shell: /apps/purchasing landing + disabled planned items, no fake data", async () => {
      await page.goto(`${BASE}/apps/purchasing`);
      await settle(page);
      expect((await shell(page)) === "purchasing", "purchasing shell");
      expect((await page.locator('[data-coming-soon="purchasing"]').count()) === 1, "landing");
      const soon = await page.locator('[data-slot="sidebar"] [data-nav-soon]').count();
      expect(soon === 4, `4 disabled planned items (${soon})`);
      expect((await page.locator('[data-coming-soon] a').count()) === 1, "only the 'Tất cả ứng dụng' link");
      await shot(page, "06-purchasing-soon");
    });

    // ---------------------------------------------------------------- limited access
    await step("staff: no system card; /users, /apps/system, /settings/notifications → /forbidden (no loop)", async () => {
      const p = await (await ctx()).newPage();
      await login(p, users.staff);
      expect(new URL(p.url()).pathname === "/apps", "staff lands on hub");
      const cards = await p.locator("[data-app-card]").evaluateAll((els) => els.map((e) => e.getAttribute("data-app-card")));
      expect(!cards.includes("system") && cards.length === 5, `staff cards ${cards}`);
      for (const target of ["/users", "/apps/system", "/settings/notifications", "/settings/shopee"]) {
        await p.goto(`${BASE}${target}`);
        await settle(p);
        expect(new URL(p.url()).pathname === "/forbidden", `${target} → ${p.url()}`);
      }
      expect((await p.getByText("Bạn không có quyền truy cập trang này.").count()) === 1, "403 page");
      await p.locator("a", { hasText: "Về trang ứng dụng" }).click();
      await p.waitForURL((u) => u.pathname === "/apps");
      await p.goto(`${BASE}/apps/shopee`);
      await settle(p);
      const links = await sidebarLinks(p);
      expect(!links.includes("Shop Shopee"), "staff: no shop connection settings link");
    });

    await step("viewer: accounting without 'Nhập hàng'; admin-only /users still refused by its page", async () => {
      const p = await (await ctx()).newPage();
      await login(p, users.viewer);
      await p.goto(`${BASE}/dashboard`);
      await settle(p);
      const links = await sidebarLinks(p);
      expect(!links.includes("Nhập hàng") && links.includes("Lịch sử hàng về"), `viewer links ${links}`);
      await p.goto(`${BASE}/users`);
      await settle(p);
      expect(new URL(p.url()).pathname === "/forbidden", `viewer /users → ${p.url()}`);
    });

    // ---------------------------------------------------------------- mobile / theme / motion
    await step("390 px: hub 1 column, no overflow; Shopee drawer opens, navigates, closes", async () => {
      const m = await (await ctx({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
      await login(m, users.admin);
      const cols = await m.locator("ul[aria-label='Ứng dụng']").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      const ov = await overflowX(m);
      facts.mobile_hub_overflow = ov;
      expect(cols === 1 && ov <= 0, `hub cols ${cols} overflow ${ov}`);
      const tap = await m.locator('[data-app-card="shopee"]').boundingBox();
      expect(tap && tap.height >= 44, "card is comfortable to tap");
      await shot(m, "07-hub-mobile");
      await m.locator('[data-app-card="shopee"]').tap();
      await m.waitForURL((u) => u.pathname === "/apps/shopee", { timeout: 120_000 });
      await settle(m);
      expect((await overflowX(m)) <= 0, "landing no overflow");
      await shot(m, "08-shopee-mobile");
      await m.getByRole("button", { name: "Mở / thu gọn menu" }).tap();
      const sheet = m.locator('[data-mobile="true"]');
      await sheet.waitFor({ timeout: 30_000 });
      await shot(m, "09-shopee-drawer");
      await Promise.all([m.waitForURL((u) => u.pathname === "/shopee/product-analytics", { timeout: 180_000 }), sheet.getByRole("link", { name: "Phân tích sản phẩm" }).tap()]);
      await settle(m);
      await sheet.waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
      expect(!(await sheet.isVisible().catch(() => false)), "drawer closed after navigation");
      expect((await overflowX(m)) <= 0, "PA page no overflow");
    });

    await step("dark mode: hub + Shopee shell on dark tokens", async () => {
      const dctx = await ctx({ colorScheme: "dark" });
      await dctx.addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark")));
      const d = await dctx.newPage();
      await login(d, users.admin);
      await d.evaluate(() => document.documentElement.classList.add("dark"));
      const bg = await d.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const card = await d.locator('[data-app-card="shopee"]').evaluate((el) => getComputedStyle(el).backgroundColor);
      const cardImg = await d.locator('[data-app-card="shopee"]').evaluate((el) => getComputedStyle(el).backgroundImage);
      facts.dark = { bg, card, cardImg: cardImg.slice(0, 120) };
      expect(lightness(bg) < 30, `dark page bg ${bg}`);
      await shot(d, "10-hub-dark");
      await d.goto(`${BASE}/apps/shopee`);
      await settle(d);
      await d.evaluate(() => document.documentElement.classList.add("dark"));
      const sb = await d.locator('[data-slot="sidebar-inner"], [data-sidebar="sidebar"]').first().evaluate((el) => getComputedStyle(el).backgroundColor);
      facts.dark_sidebar = sb;
      expect(lightness(sb) < 30, `dark sidebar ${sb}`);
      await shot(d, "11-shopee-dark");
    });

    await step("reduced motion: hub entrance animations collapse to ~0 ms", async () => {
      const r = await (await ctx({ reducedMotion: "reduce" })).newPage();
      await login(r, users.admin);
      const dur = await r.locator(".animate-ads-rise").first().evaluate((el) => getComputedStyle(el).animationDuration);
      facts.reduced_motion_duration = dur;
      expect(parseFloat(dur) < 0.01, `duration ${dur}`);
    });

    await step("zero provider calls while browsing (no job / snapshot rows, no shopee_api_call in the log)", async () => {
      const w = await dbWrites();
      const log1 = apiCallsInLog();
      facts.writes = { before: writes0, after: w, log_before: log0, log_after: log1 };
      expect(w.snaps === writes0.snaps, `snapshots ${writes0.snaps} → ${w.snaps}`);
      expect(w.jobs === writes0.jobs, `jobs ${writes0.jobs} → ${w.jobs}`);
      if (log0 !== null) expect(log1 === log0, `shopee_api_call ${log0} → ${log1}`);
    });
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
    for (const id of ids) await db.auth.admin.deleteUser(id);
  }
  const left = await db.from("profiles").select("id", { count: "exact", head: true }).in("id", ids);
  facts.cleanup_profiles_left = left.count;
  console.log(JSON.stringify({ facts }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
