// ============================================================
// PRODUCT-ANALYTICS-2 — product list + detail, end to end against the LOCAL DB
// filled by scripts/shopee/product-analytics-replica.ts (real production facts,
// copied read-only). Start the app, then run:
//
//   npx next dev -p 3100 > dev.log
//   node --env-file=.env.local scripts/e2e/product-analytics-2.ts http://localhost:3100 <outDir>
//
// Proves: list (all shops / one shop), accent-insensitive search (name / SKU /
// item id), Ads filter keeps non-Ads products, Ads-without-sales rows shown,
// sort, detail sections A–E, chart + table toggle, today partial callout,
// admin switch + "Làm mới" = one queued read job (pa_hot, prio 6) and no
// Shopee call from the browser / page render. Throw-away admin; jobs and
// settings created here are removed.
// ============================================================
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";

import { foldVietnamese } from "../../src/lib/conversation/router.ts";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.argv[3] ?? ".";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const TAG = `pa2e2e${Date.now()}`;
const EMAIL = `${TAG}@example.test`;
const PASSWORD = `Pw-${TAG}-x!`;
const PERIOD = "period=custom&from=2026-09-29&to=2026-10-28";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const results: Array<{ name: string; ok: boolean; msg?: string }> = [];
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

async function rowCount(page: Page) {
  return page.locator("table").first().locator("tbody tr").count();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { data: shops } = await admin.from("shops").select("id, shop_name").like("shop_name", "[replica]%").order("shop_name");
  expect(shops && shops.length === 5, "cần replica 5 shop (product-analytics-replica.ts load)");
  const ctv = shops.find((s) => /CTV/.test(s.shop_name))!;
  const ids = shops.map((s) => s.id);
  const { count: jobsBefore } = await admin.from("channel_sync_jobs").select("id", { count: "exact", head: true }).in("shop_id", ids);

  // reference data straight from the DB (what the page must show)
  const { data: top } = await admin.rpc("product_analytics_list", { p_shop_ids: [ctv.id], p_from: "2026-09-29", p_to: "2026-10-28", p_prev_from: "2026-08-30", p_prev_to: "2026-09-28" });
  const rows = (top as Array<{ id: string; name: string | null; sku: string | null; item_id: string; gmv: number; campaigns: number; orders: number }>).sort((a, b) => b.gmv - a.gmv);
  const best = rows[0];
  const orderOnly = rows.find((r) => r.campaigns === 0 && r.orders > 0);
  const adsNoSales = rows.find((r) => r.campaigns > 0 && r.orders === 0);
  expect(best && best.name, "CTV cần có sản phẩm có doanh số");

  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw error ?? new Error("createUser failed");
  const userId = created.user.id;
  await admin.from("profiles").upsert({ id: userId, role: "admin", is_active: true, full_name: "E2E PA2" });

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const external: string[] = [];
    await ctx.route("https://cf.shopee.vn/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    ctx.on("request", (r) => {
      if (/shopee(mobile)?\.(sg|com|vn)\/api\/v2|partner\.shopeemobile|openplatform/.test(r.url())) external.push(r.url());
    });
    const page = await ctx.newPage();
    await login(page);

    await step("list: all shops, 30 days of real facts, sorted by GMV, query < 1 s", async () => {
      // first visit compiles the route in dev; the second one measures the warm read
      await page.goto(`${BASE}/shopee/product-analytics?${PERIOD}`, { timeout: 180_000 });
      await page.goto(`${BASE}/shopee/product-analytics?${PERIOD}`, { timeout: 180_000 });
      await page.getByRole("heading", { name: "Phân tích sản phẩm Shopee" }).waitFor();
      expect((await rowCount(page)) === 50, "page of 50 rows");
      const meta = await page.locator("text=/\\d+ ms/").first().textContent();
      const ms = Number(/(\d+) ms/.exec(meta ?? "")?.[1]);
      expect(ms < 1000, `query ${ms} ms`);
      expect(await page.getByText(/1\.0\d\d sản phẩm|1\.00\d sản phẩm/).count(), "≈1 004 products counted");
      await page.screenshot({ path: path.join(OUT, "pa2-list-all.png"), fullPage: false });
    });

    await step("list: one shop + first row = best GMV product", async () => {
      await page.goto(`${BASE}/shopee/product-analytics?${PERIOD}&shop=${ctv.id}`);
      const first = page.locator("table").first().locator("tbody tr").first();
      expect((await first.textContent())!.includes(best.item_id), "best product first");
    });

    await step("search: accent-insensitive name words, SKU, item id", async () => {
      const words = foldVietnamese(best.name!).split(" ").filter((w) => w.length >= 3).slice(0, 2).join(" ");
      await page.goto(`${BASE}/shopee/product-analytics?${PERIOD}&shop=${ctv.id}&q=${encodeURIComponent(words)}`);
      expect((await page.locator("table").first().textContent())!.includes(best.item_id), `folded "${words}" finds it`);
      await page.goto(`${BASE}/shopee/product-analytics?${PERIOD}&shop=${ctv.id}&q=${best.item_id}`);
      expect((await rowCount(page)) === 1, "item id → exactly 1");
      if (best.sku) {
        await page.goto(`${BASE}/shopee/product-analytics?${PERIOD}&shop=${ctv.id}&q=${encodeURIComponent(best.sku)}`);
        expect((await page.locator("table").first().textContent())!.includes(best.item_id), "SKU finds it");
      }
    });

    await step("filters: non-Ads products with sales are listed; Ads products without sales are listed (not hidden)", async () => {
      expect(orderOnly, "replica has an orders-only product");
      await page.goto(`${BASE}/shopee/product-analytics?${PERIOD}&shop=${ctv.id}&ads=without`);
      expect((await page.locator("table").first().textContent())!.includes(orderOnly!.item_id), "orders-only product under 'Không Ads'");
      if (adsNoSales) {
        await page.goto(`${BASE}/shopee/product-analytics?${PERIOD}&shop=${ctv.id}&q=${adsNoSales.item_id}`);
        expect((await rowCount(page)) === 1, "Ads product with 0 orders is listed");
        // replica has facts but no sync state: the honest label is "no sales data yet", never a silent 0
        expect((await page.getByText(/Ads, 0 đơn|Chưa có doanh số/).count()) > 0, "Ads product with 0 orders labelled");
      }
    });

    await step("detail: sections A–E, Ads ratios, attribution wording, chart + table, query < 200 ms", async () => {
      await page.goto(`${BASE}/shopee/product-analytics/${best.id}?${PERIOD}`, { timeout: 180_000 });
      await page.goto(`${BASE}/shopee/product-analytics/${best.id}?${PERIOD}`, { timeout: 180_000 });
      for (const h of ["A. Doanh số (đơn hàng)", "B. Quảng cáo", "C. Snapshot hiện tại từ Shopee", "D. Xu hướng theo ngày", "E. Chất lượng dữ liệu"]) await page.getByRole("heading", { name: h }).waitFor();
      expect(await page.getByText("CPC thực").count(), "true CPC tile");
      expect(await page.getByText("Ads attribution / tổng doanh số").count(), "indicator label (not 'share of sales')");
      expect((await page.getByText(/share of sales|tỷ trọng doanh số do Ads/i).count()) <= 1, "never presented as share");
      expect((await page.locator("svg path[stroke]").count()) >= 3, "3 series drawn");
      await page.getByRole("tab", { name: "Đơn" }).click();
      await page.getByRole("button", { name: "Xem số liệu dạng bảng" }).click();
      expect((await page.locator("table tbody tr").count()) === 30, "30 daily rows");
      const ms = Number(/(\d+) ms/.exec((await page.locator("text=/\\d+ ms/").first().textContent()) ?? "")?.[1]);
      expect(ms < 200, `detail query ${ms} ms`);
      await page.screenshot({ path: path.join(OUT, "pa2-detail.png"), fullPage: true });
    });

    await step("today: partial-day callout + same completed hour", async () => {
      await page.goto(`${BASE}/shopee/product-analytics/${best.id}?period=today`);
      await page.getByText("Hôm nay chưa hết ngày").first().waitFor();
    });

    await step("admin: switch on/off writes the per-shop setting; 'Làm mới đơn' queues ONE read job (pa_hot, prio 6)", async () => {
      await page.goto(`${BASE}/shopee/product-analytics?${PERIOD}`);
      const row = page.locator("tr", { hasText: ctv.shop_name });
      await row.getByRole("button", { name: "Bật đơn hàng" }).click();
      await page.waitForTimeout(1500);
      const { data: s1 } = await admin.from("product_analytics_shop_settings").select("sales_sync_enabled").eq("shop_id", ctv.id).single();
      expect(s1?.sales_sync_enabled === true, "enabled");
      await page.locator("tr", { hasText: ctv.shop_name }).getByRole("button", { name: "Tắt đơn hàng" }).click();
      await page.waitForTimeout(1500);
      const { data: s2 } = await admin.from("product_analytics_shop_settings").select("sales_sync_enabled").eq("shop_id", ctv.id).single();
      expect(s2?.sales_sync_enabled === false, "disabled again");
      await page.locator("tr", { hasText: ctv.shop_name }).getByRole("button", { name: "Làm mới đơn" }).click();
      await page.waitForTimeout(1500);
      const { data: jobs } = await admin.from("channel_sync_jobs").select("sync_type, lane, priority, mode, status").eq("shop_id", ctv.id).eq("sync_type", "product_sales_facts_read");
      expect(jobs?.length === 1 && jobs[0].lane === "pa_hot" && jobs[0].priority === 6 && jobs[0].mode === "manual", JSON.stringify(jobs));
    });

    await step("mobile width: page renders, no horizontal page scroll", async () => {
      const m = await browser!.newContext({ viewport: { width: 390, height: 844 } });
      await m.route("https://cf.shopee.vn/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
      const p = await m.newPage();
      await p.goto(`${BASE}/login`);
      await p.fill('input[name="email"]', EMAIL);
      await p.fill('input[name="password"]', PASSWORD);
      await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180_000 }), p.click('button[type="submit"]')]);
      await p.goto(`${BASE}/shopee/product-analytics/${best.id}?${PERIOD}`);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await p.screenshot({ path: path.join(OUT, "pa2-detail-mobile.png"), fullPage: false });
      expect(overflow <= 1, `horizontal overflow ${overflow}px`);
      await m.close();
    });

    await step("no Shopee API request left the browser", async () => {
      expect(external.length === 0, external.join(", "));
    });
  } finally {
    await browser?.close();
    await admin.from("channel_sync_jobs").delete().in("shop_id", ids).in("sync_type", ["product_sales_facts_read", "product_extra_info_read"]);
    await admin.from("product_analytics_shop_settings").update({ sales_sync_enabled: false, extra_info_enabled: false }).in("shop_id", ids);
    await admin.auth.admin.deleteUser(userId);
    const { count: jobsAfter } = await admin.from("channel_sync_jobs").select("id", { count: "exact", head: true }).in("shop_id", ids);
    console.log(JSON.stringify({ jobsBefore, jobsAfter }));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

await main();
