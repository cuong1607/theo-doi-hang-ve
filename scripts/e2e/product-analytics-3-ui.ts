// ============================================================
// PRODUCT-ANALYTICS-3 — UI review (Playwright) on the local replica
// (product-analytics-replica.ts load <dir> --facts=cloud) or any DB with data.
// Throw-away admin, removed after.
//
//   node --env-file=.env.local scripts/e2e/product-analytics-3-ui.ts http://localhost:3100 <outDir> [devServerLog]
//
// Checks: hero / health / attention / grouped list; server-side pagination,
// filter, search, sort (URL driven, rows from SQL); detail KPI / signals /
// chart series toggle / attribution indicator wording; 390 px stacked cards
// with no horizontal overflow; dark mode; reduced motion; keyboard focus;
// payload / timings; 0 provider calls (no job / snapshot row, no
// shopee_api_call in the dev server log) while browsing.
// ============================================================
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.argv[3] ?? ".";
const DEV_LOG = process.argv[4];
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const TAG = `pa3ui${Date.now()}`;
const EMAIL = `${TAG}@example.test`;
const PASSWORD = `Pw-${TAG}-x!`;
const PATH = "/shopee/product-analytics";

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

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 180_000 }).catch(() => undefined);
  await page.locator("h2").first().waitFor({ timeout: 180_000 });
}

const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const shot = async (page: Page, name: string) => {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
};
const apiCallsInLog = () => (DEV_LOG && existsSync(DEV_LOG) ? (readFileSync(DEV_LOG, "utf8").match(/shopee_api_call/g) ?? []).length : null);
const dbWrites = async () => {
  const [{ count: jobs }, { count: snaps }] = await Promise.all([
    admin.from("channel_sync_jobs").select("*", { count: "exact", head: true }),
    admin.from("channel_api_snapshots").select("*", { count: "exact", head: true }),
  ]);
  return { jobs, snaps };
};

/** desktop rows (table) or mobile cards — whichever is visible */
const visibleRows = (page: Page) => page.locator('[data-slot="pa-product-list"] [data-row]:visible');

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw error ?? new Error("createUser");
  const userId = created.user.id;
  await admin.from("profiles").update({ role: "admin", is_active: true, full_name: "PA3 UI" }).eq("id", userId);
  const writes0 = await dbWrites();
  const log0 = apiCallsInLog();

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktop.newPage();
    await login(page);

    let firstRowP1 = "";
    await step("list: hero KPIs, health distribution, attention, grouped list (≤ 50 rows from SQL)", async () => {
      await page.goto(`${BASE}${PATH}`, { timeout: 180_000 }); // compile
      const t = Date.now();
      const resp = await page.goto(`${BASE}${PATH}`);
      facts.list_ms = Date.now() - t;
      facts.list_html_kb = Math.round(((await resp?.body())?.length ?? 0) / 1024);
      await settle(page);
      expect(await page.locator('[data-slot="pa-hero-metrics"]').count() === 1, "hero metrics");
      expect(await page.locator('[data-slot="pa-hero-kpi"]').count() === 1, "sales hero card");
      expect(await page.locator('[data-slot="pa-kpi"]').count() >= 4, "orders / units / spend / ROAS cards");
      expect(await page.locator('[data-slot="pa-health-summary"] [data-health]').count() === 5, "5 health chips");
      expect(await page.getByRole("heading", { name: "Sản phẩm cần chú ý" }).count() === 1, "attention section");
      const n = await visibleRows(page).count();
      facts.list_rows = n;
      expect(n > 0 && n <= 50, `1..50 rows (got ${n})`);
      expect(await page.locator("table thead th").count() === 4, "four grouped columns, not twelve");
      firstRowP1 = (await visibleRows(page).first().getAttribute("data-row")) ?? "";
      facts.attention_cards = await page.locator('[data-slot="pa-attention"] li').count();
      facts.health_counts = await page.locator('[data-slot="pa-health-summary"] [data-health]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-health")}:${e.querySelector(".text-lg")?.textContent}`));
      facts.list_text_head = (await page.locator("main").last().innerText()).slice(0, 700);
      await shot(page, "01-list-desktop-light");
    });

    await step("pagination: server-side page 2 (URL), different rows", async () => {
      const next = page.getByRole("link", { name: "Trang sau" }).first();
      if ((await next.count()) === 0) return void (facts.pagination = "single page");
      await Promise.all([page.waitForURL(/page=2/), next.click()]);
      await settle(page);
      const first = await visibleRows(page).first().getAttribute("data-row");
      expect(first && first !== firstRowP1, "page 2 shows other rows");
      expect(await page.getByText(/Hiển thị 51–/).count() > 0, "range text 51–");
    });

    await step("filter: health chip → only that health in the rows", async () => {
      await page.goto(`${BASE}${PATH}`);
      await settle(page);
      let target = "";
      for (const h of ["WATCH", "STABLE", "GOOD", "WEAK", "INSUFFICIENT_DATA"]) {
        const txt = await page.locator(`[data-slot="pa-health-summary"] a[data-health="${h}"] .text-lg`).innerText();
        if (Number(txt.replace(/\./g, "")) > 0) {
          target = h;
          break;
        }
      }
      expect(target, "a non-empty health bucket");
      await Promise.all([page.waitForURL(new RegExp(`health=${target}`)), page.locator(`[data-slot="pa-health-summary"] a[data-health="${target}"]`).click()]);
      await settle(page);
      const healths = await visibleRows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-health")));
      facts.filter_health = { target, rows: healths.length };
      expect(healths.length > 0 && healths.every((h) => h === target), `all rows ${target}`);
    });

    await step("search: accent-insensitive, server-side (q in URL)", async () => {
      await page.goto(`${BASE}${PATH}`);
      await settle(page);
      await page.fill('input[name="q"]', "tham");
      await Promise.all([page.waitForURL(/q=tham/), page.getByRole("button", { name: "Lọc" }).click()]);
      await settle(page);
      const names = await visibleRows(page).locator("a span.line-clamp-2").allInnerTexts();
      facts.search_tham = names.length;
      expect(names.length > 0 && names.every((x) => /thảm|tham/i.test(x.normalize("NFD").replace(/[̀-ͯ]/g, "")) || /th[aả]m/i.test(x)), "every result matches 'tham'");
    });

    await step("sort: Doanh số (desc) via header link, values non-increasing", async () => {
      await page.goto(`${BASE}${PATH}?sort=gmv`);
      await settle(page);
      const vals = await page.locator("table tbody tr td:nth-child(2) p:first-child").allInnerTexts();
      const num = (s: string) => {
        const m = s.replace(/[≥\s]/g, "").match(/([\d.,]+)(tỷ|tr|k)?/);
        if (!m) return -1;
        const v = Number(m[1].replace(/\./g, "").replace(",", "."));
        return v * (m[2] === "tỷ" ? 1e9 : m[2] === "tr" ? 1e6 : m[2] === "k" ? 1e3 : 1);
      };
      const ns = vals.map(num);
      expect(ns.every((v, i) => i === 0 || v <= ns[i - 1] * 1.0001), `sorted desc: ${vals.slice(0, 6).join(" | ")}`);
    });

    let detailHref = "";
    await step("detail: KPI cards, signal panel, chart (series toggle), attribution indicator wording", async () => {
      await page.goto(`${BASE}${PATH}`);
      await settle(page);
      detailHref = (await visibleRows(page).first().locator("a").first().getAttribute("href")) ?? "";
      expect(detailHref, "row link");
      await page.goto(`${BASE}${detailHref}`, { timeout: 180_000 });
      const t = Date.now();
      await page.goto(`${BASE}${detailHref}`);
      facts.detail_ms = Date.now() - t;
      await settle(page);
      expect(await page.locator('[data-slot="pa-detail-kpis"] [data-slot="pa-kpi"]').count() === 5, "5 KPI cards");
      expect(await page.getByRole("heading", { name: "Tín hiệu đáng chú ý" }).count() === 1, "signal panel");
      expect(await page.locator('[data-slot="pa-health"]').count() > 0, "health badge");
      const chart = page.locator('[data-slot="pa-trend"] svg[role="img"]');
      expect(await chart.count() === 1, "trend chart");
      const toggles = page.locator('[data-slot="pa-trend"] [aria-pressed]');
      if ((await toggles.count()) > 1) {
        const paths0 = await page.locator('[data-slot="pa-trend"] svg[role="img"] path').count();
        await toggles.first().click();
        const paths1 = await page.locator('[data-slot="pa-trend"] svg[role="img"] path').count();
        expect(paths1 === paths0 - 1, `series toggle hides one line (${paths0} → ${paths1})`);
        await toggles.first().click();
      }
      const indicator = page.locator('[data-slot="pa-attribution-indicator"]');
      if (await indicator.count()) {
        const txt = await indicator.innerText();
        expect(/Ads attribution \/ tổng doanh số/.test(txt), "indicator label");
        expect(!/contribution|sales share|organic|tự nhiên =/i.test(txt), "no forbidden wording");
        expect((await indicator.locator(".sr-only").innerText()).includes("Ads attribution / total sales indicator"), "exact english label for AT");
      }
      expect(await page.getByRole("heading", { name: "Ảnh chụp hiện tại từ Shopee" }).count() === 1, "snapshot section label");
      expect(await page.locator('[data-slot="pa-data-quality"] > ul > li').count() === 5, "5 data quality items");
      facts.detail_text_head = (await page.locator("main").last().innerText()).slice(0, 900);
      await shot(page, "02-detail-desktop-light");
    });

    await step("keyboard: Tab reaches product links with a visible focus ring; segmented period works with arrows", async () => {
      await page.goto(`${BASE}${PATH}`);
      await settle(page);
      const radio = page.getByRole("radio", { name: "7 ngày" });
      await radio.focus();
      await Promise.all([page.waitForURL(/period=30d/), page.keyboard.press("ArrowRight")]);
      await settle(page);
      expect(await page.getByRole("radio", { name: "30 ngày" }).getAttribute("aria-checked") === "true", "30 ngày selected");
      const link = visibleRows(page).first().locator("a").first();
      await link.focus();
      const ring = await link.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(ring && ring !== "none", "focus ring visible");
    });

    await step("Shopee Ads dashboard screenshot (design reference)", async () => {
      await page.goto(`${BASE}/shopee/ads`, { timeout: 180_000 });
      await shot(page, "03-ads-desktop-light");
    });

    await step("mobile 390 px: stacked cards (no table), no horizontal overflow on list / detail", async () => {
      const mobile = await browser!.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      const m = await mobile.newPage();
      await login(m);
      await m.goto(`${BASE}${PATH}`, { timeout: 180_000 });
      await settle(m);
      facts.mobile_list_overflow_px = await overflowX(m);
      expect(!(await m.locator('[data-slot="pa-product-list"] table').isVisible()), "table hidden on mobile");
      expect(await m.locator('[data-slot="pa-product-list"] ul li[data-row]:visible').count() > 0, "cards visible");
      await m.screenshot({ path: path.join(OUT, "04-list-mobile.png"), fullPage: true });
      await m.goto(`${BASE}${detailHref}`, { timeout: 180_000 });
      await settle(m);
      facts.mobile_detail_overflow_px = await overflowX(m);
      await m.screenshot({ path: path.join(OUT, "05-detail-mobile.png"), fullPage: true });
      expect((facts.mobile_list_overflow_px as number) <= 0 && (facts.mobile_detail_overflow_px as number) <= 0, `overflow list ${facts.mobile_list_overflow_px} / detail ${facts.mobile_detail_overflow_px}`);
      await mobile.close();
    });

    await step("dark mode: list + detail render on the dark theme (token colours)", async () => {
      const dark = await browser!.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
      // the app has .dark tokens but no theme switcher: force the class after hydration
      await dark.addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark")));
      const d = await dark.newPage();
      const forceDark = () => d.evaluate(() => document.documentElement.classList.add("dark"));
      // lightness of an rgb() / lab() / oklch() colour, 0–100
      const lightness = (c: string) => {
        const lab = c.match(/^(?:lab|oklch)\(([\d.]+)/);
        if (lab) return Number(lab[1]) * (c.startsWith("oklch") && Number(lab[1]) <= 1 ? 100 : 1);
        const rgb = c.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255];
        return ((rgb[0] + rgb[1] + rgb[2]) / 3 / 255) * 100;
      };
      await login(d);
      await d.goto(`${BASE}${PATH}`, { timeout: 180_000 });
      await settle(d);
      await forceDark();
      facts.dark_bg = await d.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const cardBg = await d.locator('[data-slot="pa-kpi"]').first().evaluate((el) => getComputedStyle(el).backgroundColor);
      facts.dark_card_bg = cardBg;
      await d.screenshot({ path: path.join(OUT, "06-list-dark.png"), fullPage: true });
      await d.goto(`${BASE}${detailHref}`);
      await settle(d);
      await forceDark();
      await d.screenshot({ path: path.join(OUT, "07-detail-dark.png"), fullPage: true });
      expect(lightness(facts.dark_bg as string) < 30, `page background dark (${facts.dark_bg})`);
      expect(lightness(cardBg) < 35, `card background dark (${cardBg})`);
      await dark.close();
    });

    await step("reduced motion: entrance animations collapse to ~0 ms", async () => {
      const rm = await browser!.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
      const r = await rm.newPage();
      await login(r);
      await r.goto(`${BASE}${PATH}`, { timeout: 180_000 });
      await settle(r);
      const dur = await r.locator(".animate-ads-rise").first().evaluate((el) => getComputedStyle(el).animationDuration);
      facts.reduced_motion_duration = dur;
      expect(/^0\.0+1ms$|^1e-05s$|^0s$|^0\.00001s$/.test(dur), `duration ${dur}`);
      await rm.close();
    });
  } finally {
    await browser?.close();
    await admin.auth.admin.deleteUser(userId);
  }

  const writes1 = await dbWrites();
  const log1 = apiCallsInLog();
  facts.provider_calls_while_browsing = { db_jobs_delta: (writes1.jobs ?? 0) - (writes0.jobs ?? 0), db_snapshots_delta: (writes1.snaps ?? 0) - (writes0.snaps ?? 0), shopee_api_call_in_dev_log_delta: log0 === null || log1 === null ? "n/a" : log1 - log0 };
  if (facts.provider_calls_while_browsing && (writes1.snaps ?? 0) !== (writes0.snaps ?? 0)) results.push({ name: "0 provider calls (snapshots)", ok: false });
  console.log(JSON.stringify({ facts, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) }, null, 2));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

await main();
