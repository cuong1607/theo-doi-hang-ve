// ============================================================
// SHOPEE-ADS-UI-1 — browser checks for /shopee/ads (Playwright, real app +
// local DB). Needs a running app (default http://localhost:3000):
//
//   node --env-file=.env.local scripts/e2e/shopee-ads-ui.ts [baseUrl]
//
// Creates a throw-away admin, logs in, checks the dashboard (filters,
// presets, shop selector, KPIs, chart, table, row expansion, loading /
// empty / error / refresh states, reduced motion, keyboard, responsive
// layout, dark tokens, no Shopee network calls, legacy still retired),
// writes screenshots to $E2E_SHOTS (or the OS temp dir), then deletes the
// user. Exit code 1 on any failure.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), "shopee-ads-ui-shots");
mkdirSync(SHOTS, { recursive: true });

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const EMAIL = `e2e-ads-${Date.now()}@example.test`;
const PASSWORD = `E2e-${Math.random().toString(36).slice(2)}-Pw!`;

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? undefined });
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    results.push({ name, ok: false, detail: msg });
    console.log(`  ✘ ${name} — ${msg}`);
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

const ads = (q = "") => `${BASE}/shopee/ads${q}`;
async function open(page: Page, q = "") {
  await page.goto(ads(q), { timeout: 180_000 });
  await page.waitForSelector('[data-slot="ads-hero"]', { timeout: 180_000 });
}
const waitUrl = (page: Page, re: RegExp) => page.waitForURL(re, { timeout: 60_000 });

async function main() {
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw error ?? new Error("createUser failed");
  const userId = created.user.id;
  await admin.from("profiles").upsert({ id: userId, role: "admin", is_active: true, full_name: "E2E Ads" });

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors: string[] = [];
    const shopeeRequests: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`[${new URL(page.url()).pathname}${new URL(page.url()).search}] ${m.text()}`);
    });
    page.on("request", (r) => {
      if (/shopee\.(sg|vn|com)|shopeemobile|test-stable/i.test(r.url())) shopeeRequests.push(r.url());
    });
    await login(page);

    console.log("Ads dashboard");
    await check("page loads: hero, fixture badge, sections", async () => {
      await open(page);
      expect(await page.locator('[data-slot="ads-hero"]').getByRole("heading", { name: "Quảng cáo Shopee" }).isVisible(), "title");
      expect(await page.getByText("Theo dõi chi phí, doanh thu và hiệu quả quảng cáo.").isVisible(), "subtitle");
      expect((await page.getByText("Dữ liệu mẫu", { exact: true }).count()) >= 1, "fixture badge");
      for (const id of ["ads-trend", "ads-insights", "ads-campaigns", "ads-top", "ads-efficiency", "ads-sync"]) expect(await page.locator(`#${id}`).isVisible(), id);
      await page.screenshot({ path: path.join(SHOTS, "desktop-1440.png"), fullPage: true, caret: "initial", animations: "disabled" });
    });

    await check("navigation still Ads-only (no legacy Shopee items)", async () => {
      const nav = await page.locator('[data-sidebar="sidebar"], aside, nav').first().innerText();
      expect(nav.includes("Quảng cáo Shopee"), "Ads item");
      for (const legacy of ["Đơn hàng Shopee", "Hàng hoàn", "Giải ngân", "Phân tích", "Đồng bộ Shopee"]) expect(!nav.includes(legacy), `legacy item ${legacy}`);
    });

    await check("KPI cards: hero ROAS + 8 distinct metric cards, formatted vi-VN", async () => {
      const hero = await page.locator('[data-slot="ads-hero-metric"]').innerText();
      expect(/\d+,\d{2}x/.test(hero), `ROAS format: ${hero.slice(0, 40)}`);
      const metrics = await page.locator('[data-slot="ads-metric-card"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-metric")));
      expect(metrics.join(",") === "spend,revenue,orders,clicks,impressions,ctr,cpc,acos", metrics.join(","));
      const spend = await page.locator('[data-metric="spend"]').first().innerText();
      expect(/triệu ₫|tỷ ₫/.test(spend), `spend compact: ${spend}`);
      const cpc = await page.locator('[data-slot="ads-metric-card"][data-metric="cpc"]').innerText();
      expect(/\d\.\d{3} ₫/.test(cpc), `cpc full: ${cpc}`);
      const ctr = await page.locator('[data-slot="ads-metric-card"][data-metric="ctr"]').innerText();
      expect(/\d,\d{2}%/.test(ctr), `ctr: ${ctr}`);
      const colors = await page.locator('[data-slot="ads-metric-card"] [data-ads-icon] svg').evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
      expect(new Set(colors).size >= 7, `distinct icon colours: ${new Set(colors).size}`);
      const tones = await page.locator("[data-delta-tone]").evaluateAll((els) => els.map((e) => e.getAttribute("data-delta-tone")));
      return `delta tones ${[...new Set(tones)].join("/")}`;
    });

    await check("metric definition tooltip (ROAS / CTR)", async () => {
      await page.getByRole("button", { name: "Định nghĩa CTR" }).hover();
      await page.getByText("Clicks / Impressions").waitFor({ timeout: 5000 });
      await page.mouse.move(5, 5);
    });

    await check("date presets change the trend (7 → 30 days → hôm nay hourly)", async () => {
      const rows7 = await page.locator("#ads-trend details tbody tr").count();
      const before = await page.locator('[data-slot="ads-metric-card"][data-metric="spend"] [data-value]').getAttribute("data-value");
      await page.getByRole("radio", { name: "30 ngày" }).click();
      await waitUrl(page, /period=30d/);
      await page.waitForFunction(() => document.querySelectorAll("#ads-trend details tbody tr").length === 30, null, { timeout: 30_000 });
      const after = await page.locator('[data-slot="ads-metric-card"][data-metric="spend"] [data-value]').getAttribute("data-value");
      expect(before !== after, "KPI value changed");
      await page.getByRole("radio", { name: "Hôm nay" }).click();
      await waitUrl(page, /period=today/);
      await page.getByText("Theo giờ").waitFor({ timeout: 30_000 });
      const hourly = await page.locator("#ads-trend details tbody tr").count();
      expect(hourly >= 1 && hourly <= 24, `hourly rows ${hourly}`);
      return `7d=${rows7} rows, 30d=30, today=${hourly} hours`;
    });

    await check("keyboard: ←/→ on the preset radiogroup moves the period", async () => {
      await page.getByRole("radio", { name: "Hôm nay" }).focus();
      await page.keyboard.press("ArrowRight");
      await waitUrl(page, /period=yesterday/);
      expect((await page.evaluate(() => document.activeElement?.textContent)) === "Hôm qua", "focus follows selection");
    });

    await check("custom range shows date inputs", async () => {
      await page.getByRole("radio", { name: "Tùy chỉnh" }).click();
      await waitUrl(page, /period=custom/);
      await page.getByLabel("Từ ngày").waitFor({ timeout: 30_000 });
      expect(await page.getByLabel("Đến ngày").isVisible(), "to date");
      await open(page, "?period=7d");
    });

    await check("shop selector: Tất cả shop / Shop 1 / Shop 2", async () => {
      await page.getByRole("combobox", { name: "Shop" }).click();
      await page.getByRole("option", { name: /Shop 2/ }).waitFor({ timeout: 10_000 });
      const opts = await page.getByRole("option").allInnerTexts();
      expect(opts.map((o) => o.replace(/^\S{1,2}\s*/, "").trim()).join("|").includes("Tất cả shop") && opts.some((o) => o.includes("Shop 2")), opts.join("|"));
      await page.getByRole("option", { name: /Shop 2/ }).click();
      await waitUrl(page, /shop=demo-shop-2/);
      await page.waitForFunction(() => [...document.querySelectorAll("[data-campaign]")].every((r) => r.textContent?.includes("Shop 2")), null, { timeout: 30_000 });
      return `${await page.locator("[data-campaign]").count()} Shop 2 campaigns`;
    });

    await check("status chips filter the table (Tạm dừng)", async () => {
      await open(page, "?period=30d");
      await page.locator('[data-slot="ads-campaign-table"]').getByRole("button", { name: /^Tạm dừng/ }).click();
      await waitUrl(page, /status=paused/);
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll("[data-campaign]")];
        return rows.length > 0 && rows.every((r) => r.textContent?.includes("Tạm dừng"));
      }, null, { timeout: 30_000 });
    });

    await check("campaign table: search, sort, sticky header", async () => {
      await open(page, "?period=30d&q=combo");
      expect((await page.locator("[data-campaign]").count()) === 2, "search 'combo' → 2 rows");
      await open(page, "?period=30d");
      await page.locator('[data-slot="ads-campaign-table"] thead').getByRole("link", { name: /ROAS/ }).click();
      await waitUrl(page, /sort=roas/);
      await page.waitForFunction(() => document.querySelector('[data-slot="ads-campaign-table"] thead th[aria-sort]')?.textContent?.includes("ROAS"), null, { timeout: 30_000 });
      const first = await page.locator("[data-campaign]").first().innerText();
      expect(first.includes("Brand Keywords"), `top ROAS first: ${first.slice(0, 40)}`);
      const sticky = await page.locator('[data-slot="ads-campaign-table"] thead').evaluate((e) => getComputedStyle(e).position);
      expect(sticky === "sticky", `thead position ${sticky}`);
    });

    await check("row expansion: smooth open/close, keyboard, details", async () => {
      await open(page, "?period=30d");
      const btn = page.locator("[data-campaign] button[aria-expanded]").first();
      const detailId = await btn.getAttribute("aria-controls");
      await btn.click();
      expect((await btn.getAttribute("aria-expanded")) === "true", "aria-expanded");
      const detail = page.locator(`[id="${detailId}"]`);
      await page.waitForTimeout(450);
      const h = await detail.evaluate((e) => e.getBoundingClientRect().height);
      expect(h > 80, `open height ${h}`);
      expect((await detail.innerText()).includes("Sản phẩm được quảng cáo"), "top products");
      expect((await detail.innerText()).includes("Ngân sách đã dùng"), "budget usage");
      const transition = await detail.evaluate((e) => getComputedStyle(e).transitionProperty);
      expect(/grid-template-rows/.test(transition), `transition ${transition}`);
      await btn.focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(450);
      const closed = await detail.evaluate((e) => e.getBoundingClientRect().height);
      expect(closed < 2, `closed height ${closed}`);
      expect(await detail.evaluate((e) => e.hasAttribute("inert")), "inert when closed");
      return `open ${Math.round(h)}px → closed ${closed}px`;
    });

    await check("chart: hover tooltip + series modes (ROAS target line)", async () => {
      const svg = page.locator('[data-slot="ads-trend-chart"] svg[role="img"]');
      await svg.scrollIntoViewIfNeeded();
      const box = await svg.boundingBox();
      expect(box, "chart svg");
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
      await page.locator('[data-slot="ads-trend-chart"] .animate-ads-pop').waitFor({ timeout: 5000 });
      const tip = await page.locator('[data-slot="ads-trend-chart"] .animate-ads-pop').innerText();
      expect(tip.includes("Doanh thu") && tip.includes("Chi tiêu"), tip);
      await page.getByRole("radio", { name: "ROAS", exact: true }).click();
      expect((await page.locator('[data-slot="ads-trend-chart"]').getAttribute("data-mode")) === "roas", "mode");
      expect(await page.getByText(/Mục tiêu 4,00x/).first().isVisible(), "target line label");
      await page.getByRole("radio", { name: "Chi tiêu & Doanh thu" }).click();
    });

    await check("refresh: old data stays, loading → success toast → 'vừa xong'", async () => {
      await open(page, "?period=7d");
      const btn = page.getByRole("button", { name: "Làm mới dữ liệu" });
      await btn.click();
      await page.getByRole("button", { name: "Đang làm mới…" }).waitFor({ timeout: 3000 });
      expect((await page.locator('[data-slot="ads-metric-card"]').count()) === 8, "KPIs still visible while refreshing");
      expect((await page.locator('[data-sync-state="refreshing"]').count()) >= 1, "sync status refreshing");
      await page.getByText("Đã làm mới dữ liệu quảng cáo").waitFor({ timeout: 30_000 });
      await page.getByText("Cập nhật vừa xong").first().waitFor({ timeout: 10_000 });
    });

    await check("loading state: tinted skeleton while data loads (?demo=slow)", async () => {
      await page.goto(ads("?demo=slow"), { waitUntil: "commit" });
      const sk = page.locator('[aria-busy="true"] .ads-shimmer').first();
      await sk.waitFor({ timeout: 10_000 });
      const bg = await sk.evaluate((e) => getComputedStyle(e).backgroundImage);
      expect(bg.includes("gradient"), "shimmer gradient");
      await page.waitForSelector('[data-slot="ads-hero-metric"]', { timeout: 30_000 });
    });

    await check("empty state (?demo=empty) with CTA", async () => {
      await open(page, "?demo=empty");
      await page.getByText("Chưa có dữ liệu quảng cáo trong khoảng thời gian này.").first().waitFor();
      expect(await page.getByRole("link", { name: "Đổi khoảng thời gian" }).isVisible(), "CTA");
    });

    await check("unsynced state (?demo=unsynced)", async () => {
      await open(page, "?demo=unsynced");
      expect((await page.getByText("Chưa đồng bộ Ads").count()) >= 2, "status + empty title");
      expect(await page.getByRole("link", { name: "Kiểm tra kết nối" }).isVisible(), "CTA");
    });

    await check("error state (?demo=error): friendly, retry, no raw error", async () => {
      await open(page, "?demo=error");
      const alert = page.locator('[data-slot="ads-error-state"]');
      expect((await alert.innerText()).includes("Không tải được dữ liệu quảng cáo."), "message");
      expect(await alert.getByRole("button", { name: "Thử lại" }).isVisible(), "retry");
      const body = await page.locator("body").innerText();
      expect(!/fixture|simulated|stack|Error:/i.test(body), "no raw error text");
      await alert.getByRole("button", { name: "Thử lại" }).click();
      await page.waitForTimeout(500);
    });

    await check("100+ campaigns (?demo=large&size=100): render + pagination", async () => {
      const t0 = Date.now();
      await open(page, "?demo=large&period=30d&size=100");
      const ms = Date.now() - t0;
      expect((await page.locator("[data-campaign]").count()) === 100, "100 rows");
      const footer = await page.getByRole("navigation", { name: "Phân trang" }).innerText();
      expect(/Hiển thị 1–100 \/ 1\d\d/.test(footer), footer);
      // shared DataTablePagination: base-ui Button renders the Link with role="button"
      await page.getByRole("navigation", { name: "Phân trang" }).getByLabel("Sau").click();
      await waitUrl(page, /page=2/);
      await page.waitForFunction(() => document.querySelectorAll("[data-campaign]").length > 0 && document.querySelectorAll("[data-campaign]").length < 100, null, { timeout: 30_000 });
      // long tasks during a period switch with 100 rows
      await page.evaluate(() => {
        (window as unknown as { __lt: number[] }).__lt = [];
        new PerformanceObserver((l) => l.getEntries().forEach((e) => (window as unknown as { __lt: number[] }).__lt.push(e.duration))).observe({ type: "longtask", buffered: false });
      });
      await page.getByRole("radio", { name: "7 ngày" }).click();
      await waitUrl(page, /period=7d/);
      await page.waitForTimeout(800);
      const lt = await page.evaluate(() => (window as unknown as { __lt: number[] }).__lt);
      const worst = Math.max(0, ...lt);
      return `page load ${ms} ms; long tasks on switch: ${lt.length} (max ${Math.round(worst)} ms, dev build)`;
    });

    await check("no request to any Shopee host from the Ads page", async () => {
      expect(shopeeRequests.length === 0, shopeeRequests.join(", "));
    });

    console.log("Reduced motion / responsive / theme");
    await check("prefers-reduced-motion: no stagger, no count-up animation", async () => {
      const rctx = await browser!.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const rp = await rctx.newPage();
      await login(rp);
      await open(rp, "?period=7d");
      const hero = await rp.locator('[data-slot="ads-hero"]').evaluate((e) => getComputedStyle(e).animationDuration);
      const delay = await rp.locator('[data-slot="ads-metric-card"]').nth(5).evaluate((e) => getComputedStyle(e).animationDelay);
      expect(parseFloat(hero) < 0.01, `hero animation ${hero}`);
      expect(delay === "0s", `card delay ${delay}`);
      await rp.getByRole("radio", { name: "30 ngày" }).click();
      await rp.waitForURL(/period=30d/);
      // value is final immediately (no intermediate frames)
      const shown = await rp.locator('[data-slot="ads-metric-card"][data-metric="orders"] [data-value] > span[aria-hidden="true"]').first().innerText();
      const target = await rp.locator('[data-slot="ads-metric-card"][data-metric="orders"] [data-value] > .sr-only').first().innerText();
      await rctx.close();
      expect(shown === target, `reduced motion shows the final value at once (${shown} vs ${target})`);
      return `hero ${hero}, delay ${delay}, orders ${shown} = ${target}`;
    });

    for (const vp of [
      { name: "desktop-1366", width: 1366, height: 768 },
      { name: "tablet-820", width: 820, height: 1180 },
      { name: "mobile-390", width: 390, height: 844 },
    ]) {
      await check(`responsive ${vp.name}: no horizontal page scroll`, async () => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await open(page, "?period=7d");
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow <= 1, `page overflows by ${overflow}px`);
        await page.screenshot({ path: path.join(SHOTS, `${vp.name}.png`), fullPage: true, caret: "initial", animations: "disabled" });
        if (vp.width < 640) {
          const snap = await page.locator('[data-slot="ads-metric-card"]').first().evaluate((e) => getComputedStyle(e.parentElement!).scrollSnapType);
          expect(snap.includes("x"), `KPI swipe snap: ${snap}`);
          const table = await page.locator('[data-slot="table-container"]').evaluate((e) => e.scrollWidth > e.clientWidth);
          expect(table, "table scrolls horizontally inside its container");
        }
        if (vp.width >= 640 && vp.width < 1024) {
          const cols = await page.locator('[data-slot="ads-metric-card"]').first().evaluate((e) => getComputedStyle(e.parentElement!).gridTemplateColumns.split(" ").length);
          expect(cols === 2, `tablet KPI columns ${cols}`);
        }
      });
    }

    await check("dark theme tokens keep Ads colours usable", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, "?period=7d");
      const light = await page.locator('[data-slot="ads-metric-card"][data-metric="revenue"] [data-value]').evaluate((e) => getComputedStyle(e).color);
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await page.waitForTimeout(250);
      const dark = await page.locator('[data-slot="ads-metric-card"][data-metric="revenue"] [data-value]').evaluate((e) => getComputedStyle(e).color);
      await page.screenshot({ path: path.join(SHOTS, "desktop-dark.png"), fullPage: true, caret: "initial", animations: "disabled" });
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      expect(light !== dark, "metric text colour switches in dark mode");
      return `${light} → ${dark}`;
    });

    console.log("Regression");
    await check("legacy Shopee routes stay retired", async () => {
      await page.goto(`${BASE}/shopee/orders`, { timeout: 120_000 });
      expect(new URL(page.url()).pathname === "/shopee/ads", `redirected to ${page.url()}`);
      const api = await page.request.get(`${BASE}/api/shopee/analytics`);
      expect(api.status() === 404, `legacy api ${api.status()}`);
    });

    await check("core pages still load", async () => {
      const out: string[] = [];
      for (const p of ["/dashboard", "/products", "/receipts", "/invoices", "/settings/shopee"]) {
        const res = await page.goto(`${BASE}${p}`, { timeout: 180_000 });
        expect(res && res.status() < 400, `${p} ${res?.status()}`);
        expect((await page.locator('[role="alert"]:has-text("Không tải được")').count()) === 0, `${p} error boundary`);
        out.push(`${p} ${res!.status()}`);
      }
      return out.join(", ");
    });

    await check("no console errors on Ads pages", async () => {
      const relevant = consoleErrors.filter((e) => !/favicon|Failed to load resource.*404/.test(e));
      if (relevant.length) console.log(relevant.map((e) => e.slice(0, 9000)).join("\n---\n"));
      expect(relevant.length === 0, relevant.slice(0, 3).map((e) => e.slice(0, 200)).join(" | "));
    });
  } finally {
    await browser?.close();
    await admin.from("profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots: ${SHOTS}`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
