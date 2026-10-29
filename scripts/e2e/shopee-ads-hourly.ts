// ============================================================
// SHOPEE-ADS-3A.1 — hourly TODAY intraday, end to end against the LOCAL DB.
// Start the app in real-data mode with the scheduler AND the hourly switch on,
// the sanitized production payloads as provider (no capture exists for
// "today": the fixture provider replays the captured day's hourly profile):
//
//   SHOPEE_ADS_DATA_SOURCE=real SHOPEE_ADS_PROVIDER=fixture ADS_AUTO_SYNC_ENABLED=true \
//   ADS_HOURLY_SYNC_ENABLED=true SHOPEE_TOKEN_KEEPALIVE_HOURS=100000 npx next dev -p 3100
//   node --env-file=.env.local scripts/e2e/shopee-ads-hourly.ts http://localhost:3100
//
// Proves: before the per-shop switch the section says hourly is off; the admin
// enables auto sync + "Theo giờ"; with NO browser open the scheduler endpoint
// enqueues the hourly reads in the HOT slot and the worker writes 00h → current
// hour only; the dashboard then shows "Hôm nay theo giờ" (current hour "Đang
// diễn ra", tooltip with Broad / Direct + CPC = spend / clicks, views,
// cumulative toggle, table); page views never enqueue or call Shopee; manual
// refresh right after is deduped; "Tắt theo giờ" stops hourly jobs.
// Throw-away admin; Ads rows, jobs and the settings row are removed at the end.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), "shopee-ads-hourly-shots");
mkdirSync(SHOTS, { recursive: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("E2E Ads theo giờ chỉ chạy với DB local.");
const SECRET = process.env.SHOPEE_SYNC_INTERNAL_SECRET ?? process.env.CRON_SECRET;
if (!SECRET) throw new Error("Thiếu SHOPEE_SYNC_INTERNAL_SECRET trong .env.local.");
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const EMAIL = `e2e-ads-hourly-${Date.now()}@example.test`;
const PASSWORD = `E2e-${Math.random().toString(36).slice(2)}-Pw!`;
const ADS_TYPES = ["ads_campaign_read", "ads_campaign_performance_read", "ads_shop_performance_read", "ads_shop_hourly_read", "ads_campaign_hourly_read"];
const HOURLY_TYPES = ["ads_shop_hourly_read", "ads_campaign_hourly_read"];

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shop-local (VN) date + hour, as the provider reports them. */
function vnNow() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date());
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return { date: `${v("year")}-${v("month")}-${v("day")}`, hour: Number(v("hour")) % 24 };
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { timeout: 180_000 });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180_000 }), page.click('button[type="submit"]')]);
}

async function jobCount(shopIds: string[], types = ADS_TYPES) {
  const { count } = await admin.from("channel_sync_jobs").select("id", { count: "exact", head: true }).in("shop_id", shopIds).in("sync_type", types);
  return count ?? 0;
}

async function schedulerTick(): Promise<{ status: number; body: { ads?: { enqueued?: Array<{ kind: string; syncType: string; created: boolean }>; shops?: number } } }> {
  const r = await fetch(`${BASE}/api/internal/shopee/sync-scheduler`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
  return { status: r.status, body: await r.json() };
}

async function drainQueue(shopId: string, maxMs = 300_000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await sleep(8000);
    const { count: active } = await admin.from("channel_sync_jobs").select("id", { count: "exact", head: true }).eq("shop_id", shopId).in("sync_type", ADS_TYPES).in("status", ["pending", "running", "retry"]);
    if (!active) return Date.now() - started;
    await schedulerTick();
  }
  throw new Error("queue not drained in time");
}

async function cleanup(shopIds: string[]) {
  await admin.from("shopee_ads_campaigns").delete().in("shop_id", shopIds); // cascades links + campaign daily / hourly facts
  await admin.from("shopee_ads_shop_daily_performance").delete().in("shop_id", shopIds);
  await admin.from("shopee_ads_shop_hourly_performance").delete().in("shop_id", shopIds);
  await admin.from("channel_api_snapshots").delete().in("shop_id", shopIds).eq("entity_type", "ads");
  await admin.from("channel_sync_logs").delete().in("shop_id", shopIds).in("sync_type", ADS_TYPES);
  await admin.from("channel_sync_jobs").delete().in("shop_id", shopIds).in("sync_type", ADS_TYPES);
  await admin.from("channel_sync_states").delete().in("shop_id", shopIds).in("sync_type", ADS_TYPES);
  await admin.from("shopee_ads_shop_settings").delete().in("shop_id", shopIds);
}

async function main() {
  const { data: shops } = await admin.from("shops").select("id, shop_name, shop_connections(connection_status)").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true).order("shop_name");
  const all = (shops ?? []) as Array<{ id: string; shop_name: string; shop_connections: Array<{ connection_status: string }> | null }>;
  const shop = all.find((s) => s.shop_connections?.[0]?.connection_status === "connected");
  if (!shop) throw new Error("Cần 1 shop Shopee live đang kết nối trong DB local.");
  const shopIds = all.map((s) => s.id);
  const { count: preexisting } = await admin.from("shopee_ads_campaigns").select("id", { count: "exact", head: true }).in("shop_id", shopIds);
  if ((preexisting ?? 0) > 0) throw new Error("DB local đã có dữ liệu Ads cho shop live — dừng để không xoá nhầm.");
  const { count: enabledBefore } = await admin.from("shopee_ads_shop_settings").select("shop_id", { count: "exact", head: true }).or("ads_sync_enabled.eq.true,ads_hourly_enabled.eq.true");
  if ((enabledBefore ?? 0) > 0) throw new Error("Đã có shop bật đồng bộ Ads tự động / theo giờ — dừng.");

  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw error ?? new Error("createUser failed");
  const userId = created.user.id;
  await admin.from("profiles").upsert({ id: userId, role: "admin", is_active: true, full_name: "E2E Ads Hourly" });
  const Q = `?shop=${shop.id}&period=7d`;

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let page = await ctx.newPage();
    const shopeeRequests: string[] = [];
    const consoleErrors: string[] = [];
    const watch = (p: Page) => {
      p.on("request", (r) => {
        if (/shopee\.(sg|vn|com)|shopeemobile|test-stable/i.test(r.url())) shopeeRequests.push(r.url());
      });
      p.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
      });
    };
    watch(page);
    await login(page);
    console.log(`Ads hourly — shop "${shop.shop_name}"`);

    await check("admin panel: hourly global switch shown ON; enable auto sync + 'Bật theo giờ' for the shop", async () => {
      await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      const panel = page.locator('[data-slot="ads-auto-sync"]');
      await panel.waitFor({ timeout: 120_000 });
      expect((await page.locator('[data-slot="ads-hourly-global"]').innerText()).includes("Theo giờ: đang bật"), "hourly global flag");
      const row = panel.locator(`tr[data-shop="${shop.id}"]`);
      await row.getByRole("button", { name: "Bật tự động" }).click();
      await page.getByText("Đã bật đồng bộ nền cho shop.").waitFor({ timeout: 30_000 });
      await panel.locator(`tr[data-shop="${shop.id}"][data-enabled="true"]`).waitFor({ timeout: 30_000 });
      await panel.locator(`tr[data-shop="${shop.id}"]`).getByRole("button", { name: "Bật theo giờ" }).click();
      await page.getByText("Đã bật dữ liệu theo giờ cho shop.").waitFor({ timeout: 30_000 });
      const { data: s } = await admin.from("shopee_ads_shop_settings").select("ads_sync_enabled, ads_hourly_enabled, hourly_enabled_at").eq("shop_id", shop.id).single();
      expect(s?.ads_sync_enabled === true && s.ads_hourly_enabled === true && !!s.hourly_enabled_at, JSON.stringify(s));
    });

    await page.close();
    await check("NO browser open: scheduler tick → hourly reads in the HOT slot (below daily HOT) → worker → hourly tables (00h → current hour only)", async () => {
      const t = await schedulerTick();
      expect(t.status === 200, `scheduler ${t.status}`);
      const kinds = (t.body.ads?.enqueued ?? []).map((e) => `${e.kind}:${e.syncType}`);
      // brand-new shop: no campaign catalogue yet → only the SHOP hourly read (campaign hourly needs the catalogue, like daily HOT)
      expect(kinds.includes("hot_hourly:ads_shop_hourly_read") && !kinds.includes("hot_hourly:ads_campaign_hourly_read"), kinds.join(","));
      const { data: queued } = await admin.from("channel_sync_jobs").select("sync_type, priority, metadata").eq("shop_id", shop.id).in("status", ["pending", "retry"]);
      const pr = (type: string, strategy: string) => (queued ?? []).find((j) => j.sync_type === type && (j.metadata as { strategy: string }).strategy === strategy)?.priority as number;
      expect(pr("ads_shop_performance_read", "hot") < pr("ads_shop_hourly_read", "hot"), "daily HOT before hourly");
      let ms = await drainQueue(shop.id);
      // the next 15-minute HOT slot (simulated: slot bookkeeping rewound): the catalogue exists → campaign hourly too
      await admin.from("shopee_ads_shop_settings").update({ last_hot_shop_slot_at: null, last_hot_campaign_slot_at: null, last_hot_hourly_slot_at: null }).eq("shop_id", shop.id);
      const next = await schedulerTick();
      const nextKinds = (next.body.ads?.enqueued ?? []).map((e) => `${e.kind}:${e.syncType}`);
      expect(nextKinds.includes("hot_hourly:ads_campaign_hourly_read") && nextKinds.includes("hot_campaign:ads_campaign_performance_read"), nextKinds.join(","));
      ms += await drainQueue(shop.id);
      const { data: jobs } = await admin.from("channel_sync_jobs").select("sync_type, status, created_by, metadata").eq("shop_id", shop.id).in("sync_type", HOURLY_TYPES);
      expect((jobs ?? []).length >= 2 && (jobs ?? []).every((j) => j.status === "success" && j.created_by === null), JSON.stringify(jobs?.map((j) => [j.sync_type, j.status])));
      const vn = vnNow();
      const { data: rows } = await admin.from("shopee_ads_shop_hourly_performance").select("report_hour").eq("shop_id", shop.id).eq("report_date", vn.date);
      const hours = (rows ?? []).map((r) => r.report_hour as number);
      expect(hours.length >= vn.hour && hours.length <= vn.hour + 1 && Math.max(...hours) <= vn.hour, `stored hours ${hours.length} (VN hour ${vn.hour})`);
      const { count: campaignRows } = await admin.from("shopee_ads_campaign_hourly_performance").select("id", { count: "exact", head: true }).eq("shop_id", shop.id).eq("report_date", vn.date);
      return `${hours.length} shop hours, ${campaignRows} campaign-hour rows, drained in ${Math.round(ms / 1000)} s`;
    });

    page = await ctx.newPage();
    watch(page);
    const vn = vnNow();
    await check("'Hôm nay theo giờ': 00h → current hour, current hour 'Đang diễn ra', freshness, totals; KPI above still the DAILY fact", async () => {
      await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      const section = page.locator('[data-slot="ads-intraday"]');
      await section.waitFor({ timeout: 120_000 });
      // dev mode: let the first render settle (route compile / freshness refresh) before interacting
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
      await sleep(1500);
      expect((await section.getAttribute("data-status")) === "ok", `status ${await section.getAttribute("data-status")}`);
      expect(Number(await section.getAttribute("data-current-hour")) === vn.hour, "current VN hour");
      expect(Number(await section.getAttribute("data-hours")) === vn.hour + 1, "no future hours");
      expect(await section.locator('[data-slot="ads-intraday-current"]').getByText("Đang diễn ra").isVisible(), "current hour marker");
      expect((await page.locator('[data-slot="ads-intraday-freshness"]').innerText()).startsWith("Cập nhật theo giờ"), "freshness");
      expect((await page.locator('[data-slot="ads-intraday-freshness"]').getAttribute("data-stale")) === "false", "hourly fresh");
      expect((await page.locator('[data-slot="ads-intraday-totals"]').innerText()).includes("Doanh số Broad"), "Broad label");
      await section.screenshot({ path: path.join(SHOTS, "intraday-desktop.png") });
    });

    await check("tooltip: hour, spend, impressions, clicks, Broad / Direct orders + GMV + ROAS, CPC", async () => {
      const svg = page.locator('[data-slot="ads-intraday"] svg[role="img"]');
      await svg.scrollIntoViewIfNeeded();
      const box = await svg.boundingBox();
      expect(box, "chart");
      await page.mouse.move(box!.x + 70, box!.y + box!.height / 2);
      await page.mouse.move(box!.x + 80, box!.y + box!.height / 2);
      const tip = page.locator('[data-slot="ads-intraday-tooltip"]');
      await tip.waitFor({ timeout: 10_000 });
      const text = await tip.innerText();
      for (const label of ["Chi tiêu", "Lượt hiển thị", "Lượt nhấp", "Đơn Broad", "Đơn Direct", "Doanh số Broad", "Doanh số Direct", "ROAS Broad", "ROAS Direct", "CPC"]) expect(text.includes(label), `tooltip: ${label}`);
      await tip.screenshot({ path: path.join(SHOTS, "intraday-tooltip.png") });
    });

    await check("table: CPC = spend / clicks of the stored hour (never Shopee's campaign cpc)", async () => {
      await page.getByText("Xem số liệu theo giờ dạng bảng").click();
      const { data: h0 } = await admin.from("shopee_ads_shop_hourly_performance").select("expense, clicks").eq("shop_id", shop.id).eq("report_date", vn.date).eq("report_hour", 0).single();
      const tr = page.locator('[data-slot="ads-intraday-table"] tr[data-hour="0"]');
      const cpc = Number(await tr.getAttribute("data-cpc"));
      expect(Math.abs(cpc - Number(h0!.expense) / Number(h0!.clicks)) < 1e-6, `cpc ${cpc} vs ${Number(h0!.expense) / Number(h0!.clicks)}`);
      expect((await page.locator('[data-slot="ads-intraday-table"] tbody tr').count()) === vn.hour + 1, "one row per hour so far");
      expect((await page.locator(`[data-slot="ads-intraday-table"] tr[data-hour="${vn.hour}"]`).getAttribute("data-state")) === "current", "current hour row");
      return `00h: ${h0!.expense} đ / ${h0!.clicks} clicks = ${cpc.toFixed(2)} đ`;
    });

    await check("views + toggles: Đơn Broad / Direct, Lượt nhấp, ROAS Broad, Doanh số Direct off by default, 'Lũy kế'", async () => {
      const section = page.locator('[data-slot="ads-intraday"]');
      expect((await section.locator('[data-series="directRevenue"]').getAttribute("aria-pressed")) === "false", "Direct revenue hidden by default");
      await section.locator('[data-action="cumulative"]').click();
      expect((await section.locator('[data-action="cumulative"]').getAttribute("aria-pressed")) === "true", "cumulative on");
      for (const label of ["Đơn Broad / Direct", "Lượt nhấp", "ROAS Broad", "Chi tiêu & Doanh số"]) {
        await section.getByRole("radio", { name: label }).click();
        await sleep(150);
      }
      expect((await section.getAttribute("data-mode")) === "money", "back to the default view");
    });

    await check("mobile 390 px: section renders without horizontal page scroll", async () => {
      const m = await ctx.newPage();
      await m.setViewportSize({ width: 390, height: 844 });
      await m.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      const s = m.locator('[data-slot="ads-intraday"]');
      await s.waitFor({ timeout: 120_000 });
      await m.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
      await s.scrollIntoViewIfNeeded();
      await sleep(1500); // entrance animation
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow <= 1, `horizontal overflow ${overflow}px`);
      await s.screenshot({ path: path.join(SHOTS, "intraday-mobile.png") });
      await m.close();
    });

    await check("page reopened ×3: zero jobs from page views, zero Shopee requests from the browser, no console error", async () => {
      const before = await jobCount(shopIds);
      for (let i = 0; i < 3; i++) await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      await page.locator('[data-slot="ads-intraday"]').waitFor({ timeout: 120_000 });
      expect((await jobCount(shopIds)) === before, "no job created");
      expect(shopeeRequests.length === 0, shopeeRequests.join(", "));
      expect(consoleErrors.length === 0, consoleErrors.join(" | "));
    });

    await check("manual refresh right after → deduped: no hourly job (written < 5 min ago)", async () => {
      const before = await jobCount([shop.id], HOURLY_TYPES);
      await page.getByRole("button", { name: "Làm mới dữ liệu" }).click();
      await page.getByText("Dữ liệu vừa được đồng bộ").waitFor({ timeout: 30_000 });
      expect((await jobCount([shop.id], HOURLY_TYPES)) === before, "no hourly job");
    });

    await check("'Tắt theo giờ': the next tick enqueues no hourly job (daily HOT unaffected)", async () => {
      await page.locator(`[data-slot="ads-auto-sync"] tr[data-shop="${shop.id}"]`).getByRole("button", { name: "Tắt theo giờ" }).click();
      await page.getByText("Đã tắt dữ liệu theo giờ cho shop.").waitFor({ timeout: 30_000 });
      await admin.from("shopee_ads_shop_settings").update({ last_hot_shop_slot_at: null, last_hot_campaign_slot_at: null, last_hot_hourly_slot_at: null }).eq("shop_id", shop.id);
      const t = await schedulerTick();
      const kinds = (t.body.ads?.enqueued ?? []).map((e) => e.kind);
      expect(!kinds.some((k) => k.includes("hourly")) && kinds.includes("hot_shop"), kinds.join(","));
    });
  } finally {
    await browser?.close();
    await cleanup(shopIds);
    await admin.auth.admin.deleteUser(userId);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (screenshots: ${SHOTS})`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
