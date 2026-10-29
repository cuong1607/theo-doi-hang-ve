// ============================================================
// SHOPEE-ADS-2 — background Ads sync, end to end against the LOCAL database.
// Start the app in real-data mode with the scheduler switch ON and the
// sanitized production payloads as provider (the sandbox has no Ads API):
//
//   SHOPEE_ADS_DATA_SOURCE=real SHOPEE_ADS_PROVIDER=fixture ADS_AUTO_SYNC_ENABLED=true \
//   SHOPEE_TOKEN_KEEPALIVE_HOURS=100000 npx next dev -p 3100
//   node --env-file=.env.local scripts/e2e/shopee-ads-scheduler.ts http://localhost:3100
//
// Proves: page views never enqueue / call Shopee; the admin switch enables a
// shop; with NO browser open, the scheduler endpoint (what pg_cron calls every
// minute) enqueues and the worker writes the canonical tables; the dashboard
// then opens already fresh; a manual refresh right after a HOT sync is
// deduped ("Dữ liệu vừa được đồng bộ"). Throw-away admin; Ads rows, jobs and
// the settings row of the shop are removed at the end.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";

const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? "http://localhost:3100";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("E2E Ads scheduler chỉ chạy với DB local.");
const SECRET = process.env.SHOPEE_SYNC_INTERNAL_SECRET ?? process.env.CRON_SECRET;
if (!SECRET) throw new Error("Thiếu SHOPEE_SYNC_INTERNAL_SECRET trong .env.local.");
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const EMAIL = `e2e-ads-sched-${Date.now()}@example.test`;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { timeout: 180_000 });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 180_000 }), page.click('button[type="submit"]')]);
}

async function adsJobCount(shopIds: string[]) {
  const { count } = await admin.from("channel_sync_jobs").select("id", { count: "exact", head: true }).in("shop_id", shopIds).in("sync_type", ADS_TYPES);
  return count ?? 0;
}

async function schedulerTick(): Promise<{ status: number; body: { ads?: { enqueued?: Array<{ kind: string; syncType: string; created: boolean }>; slotsClaimed?: number; shops?: number } | { error: string }; workerTriggered?: boolean } }> {
  const r = await fetch(`${BASE}/api/internal/shopee/sync-scheduler`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
  return { status: r.status, body: await r.json() };
}

async function cleanup(shopIds: string[]) {
  await admin.from("shopee_ads_campaigns").delete().in("shop_id", shopIds);
  await admin.from("shopee_ads_shop_daily_performance").delete().in("shop_id", shopIds);
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
  const { count: enabledBefore } = await admin.from("shopee_ads_shop_settings").select("shop_id", { count: "exact", head: true }).eq("ads_sync_enabled", true);
  if ((enabledBefore ?? 0) > 0) throw new Error("Đã có shop bật đồng bộ Ads tự động — dừng.");

  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw error ?? new Error("createUser failed");
  const userId = created.user.id;
  await admin.from("profiles").upsert({ id: userId, role: "admin", is_active: true, full_name: "E2E Ads Scheduler" });
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
    console.log(`Ads background sync — shop "${shop.shop_name}"`);

    await check("page views (×3) enqueue nothing and never call Shopee", async () => {
      const before = await adsJobCount(shopIds);
      for (let i = 0; i < 3; i++) await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      await page.locator('[data-slot="ads-auto-sync"]').waitFor({ timeout: 60_000 });
      expect((await adsJobCount(shopIds)) === before, "no job created by a page view");
      expect(shopeeRequests.length === 0, shopeeRequests.join(", "));
    });

    await check("admin panel: scheduler ON, 'Bật tự động' enables the shop (rollout switch)", async () => {
      const panel = page.locator('[data-slot="ads-auto-sync"]');
      expect((await panel.innerText()).includes("Bộ lập lịch Ads: đang bật"), "global switch shown");
      const row = panel.locator(`tr[data-shop="${shop.id}"]`);
      await row.getByRole("button", { name: "Bật tự động" }).click();
      await page.getByText("Đã bật đồng bộ nền cho shop.").waitFor({ timeout: 30_000 });
      await panel.locator(`tr[data-shop="${shop.id}"][data-enabled="true"]`).waitFor({ timeout: 30_000 });
      const { data: s } = await admin.from("shopee_ads_shop_settings").select("ads_sync_enabled, updated_by").eq("shop_id", shop.id).single();
      expect(s?.ads_sync_enabled === true && s.updated_by === userId, JSON.stringify(s));
    });

    await page.close();
    let firstTickAt = 0;
    await check("NO browser open: scheduler tick (pg_cron call) → Ads read jobs enqueued → worker → canonical DB", async () => {
      firstTickAt = Date.now();
      const t = await schedulerTick();
      expect(t.status === 200, `scheduler ${t.status}`);
      const ads = t.body.ads as { enqueued: Array<{ kind: string; syncType: string; created: boolean }> };
      const kinds = ads.enqueued.map((e) => e.kind).sort();
      expect(kinds.filter((k) => k === "backfill").length === 2 && kinds.includes("hot_shop") && kinds.includes("metadata"), `enqueued ${kinds.join(",")}`);
      // pg_cron calls every minute; here every 8 s until the queue is empty (each call starts a bounded worker burst)
      for (let i = 0; i < 30; i++) {
        await sleep(8000);
        const { count: active } = await admin.from("channel_sync_jobs").select("id", { count: "exact", head: true }).eq("shop_id", shop.id).in("sync_type", ADS_TYPES).in("status", ["pending", "running", "retry"]);
        if (!active) break;
        await schedulerTick();
      }
      const { data: jobs } = await admin.from("channel_sync_jobs").select("sync_type, status, lane, mode, created_by").eq("shop_id", shop.id).in("sync_type", ADS_TYPES);
      expect((jobs ?? []).length >= 4 && (jobs ?? []).every((j) => j.status === "success"), JSON.stringify(jobs));
      expect((jobs ?? []).every((j) => j.created_by === null && j.mode !== "manual"), "created by the scheduler, not a user");
      const { count: campaigns } = await admin.from("shopee_ads_campaigns").select("id", { count: "exact", head: true }).eq("shop_id", shop.id);
      const { count: shopDays } = await admin.from("shopee_ads_shop_daily_performance").select("id", { count: "exact", head: true }).eq("shop_id", shop.id);
      expect(campaigns === 143 && (shopDays ?? 0) >= 30, `campaigns ${campaigns}, shop days ${shopDays}`);
      return `${jobs?.length} jobs (${[...new Set((jobs ?? []).map((j) => j.lane))].join(", ")}), drained in ${Math.round((Date.now() - firstTickAt) / 1000)} s`;
    });

    await check("repeated tick in the same slot schedules nothing new (no duplicate jobs)", async () => {
      const before = await adsJobCount([shop.id]);
      const t = await schedulerTick();
      const ads = t.body.ads as { enqueued: Array<{ kind: string; created: boolean }> };
      const created = ads.enqueued.filter((e) => e.created && !e.kind.startsWith("hot_"));
      expect(created.length === 0, `unexpected ${JSON.stringify(created)}`);
      const added = (await adsJobCount([shop.id])) - before;
      return `${added} new job(s) (only when a new 15-min HOT slot began meanwhile)`;
    });

    page = await ctx.newPage();
    watch(page);
    await check("dashboard opened afterwards: data already fresh, background sync noted, freshness per part", async () => {
      await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      await page.waitForSelector('[data-slot="ads-hero"]', { timeout: 180_000 });
      const state = await page.locator("[data-sync-state]").first().getAttribute("data-sync-state");
      expect(state === "fresh", `sync state ${state}`);
      expect(await page.getByText("Đồng bộ nền tự động ~15 phút/lần, không cần mở trang.").isVisible(), "auto-sync note");
      for (const key of ["shop_today", "campaign_today", "metadata"]) expect((await page.locator(`[data-freshness="${key}"][data-stale="false"]`).count()) === 1, `${key} fresh`);
    });

    await check("manual refresh right after the HOT sync → 'Dữ liệu vừa được đồng bộ', no duplicate provider work", async () => {
      const before = await adsJobCount([shop.id]);
      await page.getByRole("button", { name: "Làm mới dữ liệu" }).click();
      await page.getByText("Dữ liệu vừa được đồng bộ").waitFor({ timeout: 30_000 });
      expect((await adsJobCount([shop.id])) === before, "no job enqueued");
    });

    await check("page reopened ×3: still zero jobs from page views, zero Shopee requests from the browser", async () => {
      const before = await adsJobCount(shopIds);
      for (let i = 0; i < 3; i++) await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      expect((await adsJobCount(shopIds)) === before, "no job created");
      expect(shopeeRequests.length === 0, shopeeRequests.join(", "));
      expect(consoleErrors.length === 0, consoleErrors.join(" | "));
    });

    await check("'Tắt tự động' disables the shop: the next tick enqueues nothing for it", async () => {
      await page.locator(`[data-slot="ads-auto-sync"] tr[data-shop="${shop.id}"]`).getByRole("button", { name: "Tắt tự động" }).click();
      await page.getByText("Đã tắt đồng bộ nền cho shop.").waitFor({ timeout: 30_000 });
      const t = await schedulerTick();
      const ads = t.body.ads as { shops: number; enqueued: unknown[] };
      expect(ads.shops === 0 && ads.enqueued.length === 0, JSON.stringify(ads));
    });
  } finally {
    await browser?.close();
    await cleanup(shopIds);
    await admin.auth.admin.deleteUser(userId);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
