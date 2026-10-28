// ============================================================
// SHOPEE-ADS-1B — browser checks for /shopee/ads in REAL-DATA mode against
// the LOCAL database. Start the app with the Ads read sync enabled and the
// sanitized production payloads as provider (the sandbox has no Ads API):
//
//   SHOPEE_ADS_DATA_SOURCE=real SHOPEE_ADS_PROVIDER=fixture npx next dev -p 3100
//   node --env-file=.env.local scripts/e2e/shopee-ads-real.ts http://localhost:3100
//
// Flow: no Ads data → "Làm mới dữ liệu" (enqueue → worker → provider →
// canonical DB) → dashboard reads the DB: overview = SHOP facts, table =
// CAMPAIGN facts, Broad / Direct, outside-product-campaigns delta, CPC =
// spend / clicks, today-partial notice, filters, search, freshness.
// Throw-away admin; the Ads rows of the local live shop(s) are removed at the end.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), "shopee-ads-real-shots");
mkdirSync(SHOTS, { recursive: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("E2E Ads thật chỉ chạy với DB local.");
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const EMAIL = `e2e-ads-real-${Date.now()}@example.test`;
const PASSWORD = `E2e-${Math.random().toString(36).slice(2)}-Pw!`;
const ADS_TYPES = ["ads_campaign_read", "ads_campaign_performance_read", "ads_shop_performance_read"];

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? undefined });
    console.log(`  PASS ${name}${detail ? ` - ${detail}` : ""}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    results.push({ name, ok: false, detail: msg });
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

const open = async (page: Page, q = "") => {
  await page.goto(`${BASE}/shopee/ads${q}`, { timeout: 180_000 });
  await page.waitForSelector('[data-slot="ads-hero"]', { timeout: 180_000 });
};
const metricValue = async (page: Page, metric: string) => Number(await page.locator(`[data-metric="${metric}"] [data-value]`).first().getAttribute("data-value"));

async function cleanupAds(shopIds: string[]) {
  if (!shopIds.length) return;
  await admin.from("shopee_ads_campaigns").delete().in("shop_id", shopIds); // cascades links + campaign facts
  await admin.from("shopee_ads_shop_daily_performance").delete().in("shop_id", shopIds);
  await admin.from("channel_api_snapshots").delete().in("shop_id", shopIds).eq("entity_type", "ads");
  await admin.from("channel_sync_logs").delete().in("shop_id", shopIds).in("sync_type", ADS_TYPES);
  await admin.from("channel_sync_jobs").delete().in("shop_id", shopIds).in("sync_type", ADS_TYPES);
  await admin.from("channel_sync_states").delete().in("shop_id", shopIds).in("sync_type", ADS_TYPES);
}

async function main() {
  const { data: shops } = await admin.from("shops").select("id, shop_name").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true);
  const shopIds = (shops ?? []).map((s) => s.id as string);
  if (!shopIds.length) throw new Error("Cần ít nhất 1 shop Shopee live trong DB local.");
  const { count: preexisting } = await admin.from("shopee_ads_campaigns").select("id", { count: "exact", head: true }).in("shop_id", shopIds);
  if ((preexisting ?? 0) > 0) throw new Error("DB local đã có dữ liệu Ads cho shop live — dừng để không xoá nhầm.");

  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw error ?? new Error("createUser failed");
  const userId = created.user.id;
  await admin.from("profiles").upsert({ id: userId, role: "admin", is_active: true, full_name: "E2E Ads Real" });

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors: string[] = [];
    const shopeeRequests: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`[${new URL(page.url()).pathname}${new URL(page.url()).search}] ${m.text().slice(0, 300)}`);
    });
    page.on("request", (r) => {
      if (/shopee\.(sg|vn|com)|shopeemobile|test-stable/i.test(r.url())) shopeeRequests.push(r.url());
    });
    await login(page);
    const Q27 = "?period=custom&from=2026-10-27&to=2026-10-27";

    console.log("Ads dashboard - real data mode");
    await check("before any sync: real mode, no fixture data, 'Chưa đồng bộ Ads' + refresh CTA", async () => {
      await open(page, Q27);
      expect((await page.getByText("Dữ liệu mẫu", { exact: true }).count()) === 0, "no fixture badge in real mode");
      await page.getByText("Chưa đồng bộ Ads").first().waitFor({ timeout: 30_000 });
      expect(await page.getByText(/Bấm “Làm mới dữ liệu” để đồng bộ/).isVisible(), "real empty-state copy");
    });

    await check("manual refresh: queue → worker → DB → dashboard (old view kept while syncing, success toast)", async () => {
      const t0 = Date.now();
      await page.getByRole("button", { name: "Làm mới dữ liệu" }).click();
      await page.getByRole("button", { name: "Đang làm mới…" }).waitFor({ timeout: 5000 });
      await page.getByText("Đã làm mới dữ liệu quảng cáo").waitFor({ timeout: 240_000 });
      await page.waitForSelector('[data-slot="ads-metric-card"]', { timeout: 60_000 });
      const { data: jobs } = await admin.from("channel_sync_jobs").select("sync_type, status, mode").in("shop_id", shopIds).in("sync_type", ADS_TYPES);
      expect((jobs ?? []).length >= 3 && (jobs ?? []).every((j) => j.status === "success" && j.mode === "manual"), JSON.stringify(jobs));
      return `${Math.round((Date.now() - t0) / 1000)} s, ${(jobs ?? []).length} read jobs`;
    });

    let dbSpend = 0;
    await check("overview = SHOP-level facts (27/10: 1.104.162 đ), CPC = spend / clicks, Broad vs Direct", async () => {
      await open(page, Q27);
      const { data: f } = await admin.from("shopee_ads_shop_daily_performance").select("expense, clicks, broad_gmv, direct_gmv").in("shop_id", shopIds).eq("report_date", "2026-10-27");
      dbSpend = (f ?? []).reduce((a, r) => a + Number(r.expense), 0);
      const clicks = (f ?? []).reduce((a, r) => a + Number(r.clicks), 0);
      expect((await metricValue(page, "spend")) === dbSpend, `spend card ${await metricValue(page, "spend")} vs DB ${dbSpend}`);
      expect(dbSpend === 1104162 * shopIds.length, `fixture spend ${dbSpend}`);
      const cpc = await metricValue(page, "cpc");
      expect(Math.abs(cpc - dbSpend / clicks) < 1e-6, `CPC ${cpc} vs ${dbSpend / clicks}`);
      expect(Math.round(cpc) !== 20000, "never Shopee's campaign cpc");
      expect((await metricValue(page, "revenue")) === (f ?? []).reduce((a, r) => a + Number(r.broad_gmv), 0), "Doanh số Broad card");
      for (const label of ["Doanh số Broad", "ROAS Broad", "ACOS Broad", "Broad & Direct", "Doanh số Direct"]) expect((await page.getByText(label, { exact: true }).count()) > 0, label);
      return `spend ${dbSpend}, CPC ${cpc.toFixed(2)}`;
    });

    await check("'Ngoài chiến dịch sản phẩm' = shop − Σ campaigns, cautious label + explanation", async () => {
      const box = page.locator('[data-slot="ads-outside-campaigns"]');
      await box.waitFor();
      const text = await box.innerText();
      expect(text.includes("Ngoài chiến dịch sản phẩm") && text.includes("chưa cung cấp đủ thông tin"), text.slice(0, 120));
      expect(/31\.491/.test(text) || shopIds.length > 1, `31.491 đ delta in: ${text.slice(0, 160)}`);
      expect(!/Shop Ads|Quảng cáo Shop/.test(text), "not labelled as a specific ad type");
    });

    await check("campaign table = CAMPAIGN facts (Σ 1.072.671 đ, 43 with spend), Ngân sách/ngày, raw Shopee values in the detail", async () => {
      const table = page.locator('[data-slot="ads-campaign-table"]');
      await table.scrollIntoViewIfNeeded();
      const headers = await table.locator("thead").innerText();
      for (const h of ["Ngân sách/ngày", "Doanh số Broad", "Đơn Broad", "ROAS Broad", "CPC"]) expect(headers.includes(h), `header ${h}`);
      const { data: sums } = await admin.rpc("ads_dashboard_campaigns", { p_shop_ids: shopIds, p_from: "2026-10-27", p_to: "2026-10-27" });
      const withSpend = (sums as Array<{ expense: number }>).filter((r) => Number(r.expense) > 0);
      expect(withSpend.length === 43 * shopIds.length, `campaigns with spend ${withSpend.length}`);
      expect(withSpend.reduce((a, r) => a + Number(r.expense), 0) === 1072671 * shopIds.length, "Σ campaign spend");
      expect(dbSpend > withSpend.reduce((a, r) => a + Number(r.expense), 0), "shop total stays larger than Σ campaigns");
      const firstToggle = table.locator("tbody button[aria-expanded]").first();
      await firstToggle.click();
      await page.getByText(/Shopee: trạng thái/).first().waitFor({ timeout: 10_000 });
      return `${withSpend.length} campaigns with spend`;
    });

    await check("campaign search (q) narrows the table to the matching campaign", async () => {
      await open(page, `${Q27}&q=${encodeURIComponent("Ad #40")}#ads-campaigns`);
      const rows = page.locator('[data-slot="ads-campaign-table"] tbody tr[data-campaign]');
      const n = await rows.count();
      const names = await page.locator('[data-slot="ads-campaign-table"] tbody').innerText();
      expect(names.includes("Ad #40") && n >= 1 && n <= shopIds.length, `${n} rows`);
      return `${n} row(s)`;
    });

    await check("date filter: 7 days / 30 days change the overview from shop facts; 'Hôm nay' shows the partial-data notice", async () => {
      await open(page, "?period=7d");
      const s7 = await metricValue(page, "spend");
      await open(page, "?period=30d");
      const s30 = await metricValue(page, "spend");
      expect(s30 > s7 && s7 > 0, `${s7} / ${s30}`);
      await open(page, "?period=today");
      await page.locator('[data-slot="ads-today-partial"]').waitFor({ timeout: 10_000 });
      expect((await page.locator('[data-slot="ads-today-partial"]').innerText()).includes("Hôm nay — dữ liệu có thể chưa hoàn tất"), "notice text");
      return `7d ${s7}, 30d ${s30}`;
    });

    await check("shop filter: selecting the shop keeps shop-level totals of that shop only", async () => {
      await open(page, `${Q27}&shop=${shopIds[0]}`);
      expect((await metricValue(page, "spend")) === 1104162, "single shop spend");
    });

    await check("freshness: three read jobs listed with their last success; report-through date shown", async () => {
      await open(page, Q27);
      const box = page.locator('[data-slot="ads-freshness"]');
      await box.scrollIntoViewIfNeeded();
      const t = await box.innerText();
      for (const l of ["Danh mục chiến dịch", "Hiệu quả chiến dịch", "Tổng quảng cáo cấp shop"]) expect(t.includes(l), l);
      expect((t.match(/Thành công:/g) ?? []).length === 3, t.slice(0, 200));
      expect(/có số liệu đến ngày 28\/10\/2026/.test(t), "report through 28/10");
      expect((await page.locator('[data-sync-state="fresh"]').count()) >= 1, "status fresh");
      await page.screenshot({ path: path.join(SHOTS, "ads-real-27-10.png"), fullPage: true, caret: "initial", animations: "disabled" });
    });

    await check("no browser request to any Shopee host (page reads the DB only)", async () => {
      expect(shopeeRequests.length === 0, shopeeRequests.slice(0, 3).join(", "));
    });
    await check("no console errors", async () => {
      expect(consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
    });
  } finally {
    await browser?.close();
    await cleanupAds(shopIds);
    await admin.from("profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed - screenshots: ${SHOTS}`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
