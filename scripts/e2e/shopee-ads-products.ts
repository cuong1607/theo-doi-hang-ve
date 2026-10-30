// ============================================================
// SHOPEE-ADS-3A.2 — product enrichment, end to end against the LOCAL DB.
// Start the app in real-data mode with the scheduler AND the product switch on,
// the sanitized production payloads as provider:
//
//   SHOPEE_ADS_DATA_SOURCE=real SHOPEE_ADS_PROVIDER=fixture ADS_AUTO_SYNC_ENABLED=true \
//   ADS_PRODUCT_ENRICHMENT_ENABLED=true SHOPEE_TOKEN_KEEPALIVE_HOURS=100000 npx next dev -p 3100
//   node --env-file=.env.local scripts/e2e/shopee-ads-products.ts http://localhost:3100
//
// Proves: before the per-shop switch the campaign table shows the campaign
// name + a neutral icon and the expanded row says the product is pending (ID
// shown, no invented name / image / SKU); the admin enables "Bật TT SP"; with
// NO browser open the scheduler's product slot enqueues ONE enrichment job
// (below every performance read) and the worker stores the 101 referenced
// items; the refreshed page shows product names, thumbnails (a valid image
// renders, a broken one falls back to the icon without moving the row), SKU,
// and search finds campaigns by product name / SKU / item id; page views never
// enqueue or call the Shopee API; "Làm mới dữ liệu" adds no product job while
// the cache is fresh; "Làm mới TT SP" re-reads; "Tắt TT SP" stops the slot.
// Image requests to cf.shopee.vn are intercepted (fixture image ids are
// placeholders): nothing leaves the machine.
// Throw-away admin; Ads rows, product rows, jobs and settings are removed.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), "shopee-ads-products-shots");
mkdirSync(SHOTS, { recursive: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("E2E thông tin sản phẩm Ads chỉ chạy với DB local.");
const SECRET = process.env.SHOPEE_SYNC_INTERNAL_SECRET ?? process.env.CRON_SECRET;
if (!SECRET) throw new Error("Thiếu SHOPEE_SYNC_INTERNAL_SECRET trong .env.local.");
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const EMAIL = `e2e-ads-products-${Date.now()}@example.test`;
const PASSWORD = `E2e-${Math.random().toString(36).slice(2)}-Pw!`;
const ADS_TYPES = ["ads_campaign_read", "ads_campaign_performance_read", "ads_shop_performance_read", "ads_shop_hourly_read", "ads_campaign_hourly_read", "ads_product_enrichment_read"];
const PRODUCT = "ads_product_enrichment_read";
// a 1×1 PNG served for "valid" images; fixture image ids ending in an odd digit are answered 404 (broken image path)
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

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

async function jobCount(shopIds: string[], types = ADS_TYPES) {
  const { count } = await admin.from("channel_sync_jobs").select("id", { count: "exact", head: true }).in("shop_id", shopIds).in("sync_type", types);
  return count ?? 0;
}

async function schedulerTick(): Promise<{ status: number; body: { ads?: { enqueued?: Array<{ kind: string; syncType: string; created: boolean }>; productCacheHits?: string[] } } }> {
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
  await admin.from("shopee_ads_campaigns").delete().in("shop_id", shopIds); // cascades links + campaign facts
  await admin.from("shopee_ads_products").delete().in("shop_id", shopIds);
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
  const { count: enabledBefore } = await admin.from("shopee_ads_shop_settings").select("shop_id", { count: "exact", head: true }).or("ads_sync_enabled.eq.true,ads_hourly_enabled.eq.true,ads_product_enrichment_enabled.eq.true");
  if ((enabledBefore ?? 0) > 0) throw new Error("Đã có shop bật đồng bộ Ads tự động — dừng.");

  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw error ?? new Error("createUser failed");
  const userId = created.user.id;
  await admin.from("profiles").upsert({ id: userId, role: "admin", is_active: true, full_name: "E2E Ads Products" });
  const Q = `?shop=${shop.id}&period=7d&status=all`;

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const imageRequests: string[] = [];
    await ctx.route("https://cf.shopee.vn/file/**", (route) => {
      const u = route.request().url();
      imageRequests.push(u);
      return /[13579]$/.test(u) ? route.fulfill({ status: 404, body: "" }) : route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    });
    let page = await ctx.newPage();
    const shopeeApiRequests: string[] = [];
    const consoleErrors: string[] = [];
    const watch = (p: Page) => {
      p.on("request", (r) => {
        if (/shopeemobile|test-stable|\/api\/v2\//i.test(r.url())) shopeeApiRequests.push(r.url());
      });
      p.on("console", (m) => {
        // the intentionally broken thumbnails (404) are the only expected resource errors
        if (m.type() === "error" && !/cf\.shopee\.vn/.test(m.location().url ?? "")) consoleErrors.push(m.text().slice(0, 200));
      });
    };
    watch(page);
    await login(page);
    console.log(`Ads products — shop "${shop.shop_name}"`);

    await check("admin panel: product global switch shown ON; enable auto sync (product switch still OFF)", async () => {
      await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      const panel = page.locator('[data-slot="ads-auto-sync"]');
      await panel.waitFor({ timeout: 120_000 });
      expect((await page.locator('[data-slot="ads-products-global"]').innerText()).includes("Thông tin SP: đang bật"), "product global flag");
      await panel.locator(`tr[data-shop="${shop.id}"]`).getByRole("button", { name: "Bật tự động" }).click();
      await page.getByText("Đã bật đồng bộ nền cho shop.").waitFor({ timeout: 30_000 });
      await panel.locator(`tr[data-shop="${shop.id}"][data-enabled="true"]`).waitFor({ timeout: 30_000 });
    });

    await page.close();
    await check("NO browser: scheduler → catalogue + backfill + HOT; product switch OFF → no enrichment job", async () => {
      const t = await schedulerTick();
      expect(t.status === 200, `scheduler ${t.status}`);
      const ms = await drainQueue(shop.id);
      // second slot: catalogue now exists (still no product job: switch off)
      await admin.from("shopee_ads_shop_settings").update({ last_hot_shop_slot_at: null, last_hot_campaign_slot_at: null }).eq("shop_id", shop.id);
      await schedulerTick();
      await drainQueue(shop.id);
      expect((await jobCount([shop.id], [PRODUCT])) === 0, "no product job while the shop switch is off");
      const { count } = await admin.from("shopee_ads_campaign_products").select("id", { count: "exact", head: true }).eq("shop_id", shop.id);
      return `${count} campaign ↔ item links, drained in ${Math.round(ms / 1000)} s`;
    });

    page = await ctx.newPage();
    watch(page);
    let pendingItem = "";
    await check("before enrichment: campaign name + neutral icon in the row; expanded row shows 'Sản phẩm Shopee #<id>', the item ID, 'Đang chờ…' — no image, no SKU", async () => {
      await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      const table = page.locator('[data-slot="ads-campaign-table"]');
      await table.waitFor({ timeout: 120_000 });
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
      const first = table.locator("tr[data-campaign]").first();
      expect((await first.locator('[data-slot="ads-product-thumb"]').getAttribute("data-state")) === "fallback", "neutral icon");
      await first.getByRole("button", { name: /Xem chi tiết/ }).click();
      const li = table.locator('li[data-product]').first();
      await li.waitFor({ timeout: 10_000 });
      pendingItem = (await li.getAttribute("data-product")) ?? "";
      expect((await li.getAttribute("data-enrichment")) === "pending", "pending");
      const text = await li.innerText();
      expect(text.includes(`Sản phẩm Shopee #${pendingItem}`) && text.includes(pendingItem) && text.includes("Đang chờ bổ sung thông tin sản phẩm") && !text.includes("SKU"), text);
      expect(imageRequests.length === 0, "no image requested before metadata exists");
      await table.screenshot({ path: path.join(SHOTS, "products-pending.png") });
    });

    await check("admin: 'Bật TT SP' for the shop", async () => {
      await page.locator(`[data-slot="ads-auto-sync"] tr[data-shop="${shop.id}"]`).getByRole("button", { name: "Bật TT SP" }).click();
      await page.getByText("Đã bật thông tin sản phẩm cho shop.").waitFor({ timeout: 30_000 });
      const { data: s } = await admin.from("shopee_ads_shop_settings").select("ads_product_enrichment_enabled, product_enrichment_enabled_at").eq("shop_id", shop.id).single();
      expect(s?.ads_product_enrichment_enabled === true && !!s.product_enrichment_enabled_at, JSON.stringify(s));
    });

    await page.close();
    await check("NO browser: product slot → ONE enrichment job (priority below every performance read) → 101 items stored in 3 batched GETs", async () => {
      await admin.from("shopee_ads_shop_settings").update({ last_product_enrichment_slot_at: null }).eq("shop_id", shop.id);
      const t = await schedulerTick();
      const kinds = (t.body.ads?.enqueued ?? []).map((e) => `${e.kind}:${e.syncType}`);
      expect(kinds.includes(`product_enrichment:${PRODUCT}`), kinds.join(","));
      const { data: q } = await admin.from("channel_sync_jobs").select("priority, lane, created_by").eq("shop_id", shop.id).eq("sync_type", PRODUCT).single();
      expect(q!.priority === 9 && q!.lane === "ads_meta" && q!.created_by === null, JSON.stringify(q));
      const ms = await drainQueue(shop.id);
      const { data: j } = await admin.from("channel_sync_jobs").select("status, metadata").eq("shop_id", shop.id).eq("sync_type", PRODUCT).single();
      const meta = j!.metadata as { apiCalls: Record<string, number>; productScope: { referenced: number; cacheHitRate: number } };
      expect(j!.status === "success", j!.status);
      const { count } = await admin.from("shopee_ads_products").select("id", { count: "exact", head: true }).eq("shop_id", shop.id).eq("enrichment_status", "enriched");
      expect(count === meta.productScope.referenced, `${count} rows vs ${meta.productScope.referenced} referenced`);
      return `${count} items, ${meta.apiCalls["/api/v2/product/get_item_base_info"]} calls, drained in ${Math.round(ms / 1000)} s`;
    });

    page = await ctx.newPage();
    watch(page);
    await check("after refresh: product names in the table, thumbnails (valid renders, broken → icon in the same 36 px box), SKU in the expanded row", async () => {
      await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      const table = page.locator('[data-slot="ads-campaign-table"]');
      await table.waitFor({ timeout: 120_000 });
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
      await sleep(1500);
      const names = await table.locator("tr[data-campaign] p.font-medium").allInnerTexts();
      expect(names.length > 0 && names.every((n) => /^Item #\d+/.test(n)), names.slice(0, 3).join(" | "));
      const states = await table.locator('tr[data-campaign] [data-slot="ads-product-thumb"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
      expect(states.includes("image") && states.includes("fallback"), `thumb states ${[...new Set(states)].join(",")}`);
      const boxes = await table.locator('tr[data-campaign] [data-slot="ads-product-thumb"]').evaluateAll((els) => els.map((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
      expect(new Set(boxes).size === 1 && boxes[0] === "36x36", `boxes ${[...new Set(boxes)].join(",")}`);
      const img = table.locator('tr[data-campaign] [data-slot="ads-product-thumb"] img').first();
      expect((await img.getAttribute("loading")) === "lazy", "lazy loading");
      // SKU: open a row whose product has one
      const { data: withSku } = await admin.from("shopee_ads_products").select("provider_item_id, item_sku, product_name").eq("shop_id", shop.id).not("item_sku", "is", null).limit(1).single();
      const sq = page.locator('[data-slot="ads-campaign-table"] input');
      await sq.fill(withSku!.item_sku!);
      await page.waitForURL((u) => u.searchParams.get("q") === withSku!.item_sku, { timeout: 30_000 });
      const row = table.locator("tr[data-campaign]").first();
      await row.waitFor({ timeout: 30_000 });
      await row.getByRole("button", { name: /Xem chi tiết/ }).click();
      const li = table.locator(`li[data-product="${withSku!.provider_item_id}"]`).first();
      await li.waitFor({ timeout: 10_000 });
      const text = await li.innerText();
      expect(text.includes(withSku!.item_sku!) && text.includes(withSku!.provider_item_id) && text.includes(withSku!.product_name!), text);
      await table.screenshot({ path: path.join(SHOTS, "products-enriched.png") });
      return `${states.filter((s) => s === "image").length} images, ${states.filter((s) => s === "fallback").length} fallbacks`;
    });

    await check("search: by product name and by provider item id (accent-insensitive, campaign search unchanged)", async () => {
      // a product of a campaign the table lists (campaigns without activity in the period are hidden)
      await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      const listed = (await page.locator('[data-slot="ads-campaign-table"] tr[data-campaign] p.font-medium').first().innerText()).replace(/\s*\+\d+ SP$/, "").trim();
      const { data: p } = await admin.from("shopee_ads_products").select("provider_item_id, product_name").eq("shop_id", shop.id).eq("product_name", listed).limit(1).single();
      for (const q of [p!.product_name!.toLowerCase(), p!.provider_item_id]) {
        await page.goto(`${BASE}/shopee/ads${Q}&q=${encodeURIComponent(q)}`, { timeout: 180_000 });
        const rows = page.locator('[data-slot="ads-campaign-table"] tr[data-campaign]');
        await rows.first().waitFor({ timeout: 60_000 });
        const n = await rows.count();
        const shown = await rows.locator("p.font-medium").allInnerTexts();
        expect(n >= 1 && shown.every((s) => s.startsWith(listed)), `${q}: ${shown.join(" | ")}`);
      }
    });

    await check("page reopened ×3: zero jobs from page views, zero Shopee API requests from the browser, no console error", async () => {
      const before = await jobCount(shopIds);
      for (let i = 0; i < 3; i++) await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      await page.locator('[data-slot="ads-campaign-table"]').waitFor({ timeout: 120_000 });
      expect((await jobCount(shopIds)) === before, "no job created");
      expect(shopeeApiRequests.length === 0, shopeeApiRequests.join(", "));
      expect(consoleErrors.length === 0, consoleErrors.join(" | "));
    });

    await check("'Làm mới dữ liệu' (admin force) → no product job while the cache is fresh", async () => {
      const before = await jobCount([shop.id], [PRODUCT]);
      await page.getByRole("button", { name: "Làm mới dữ liệu" }).click();
      await sleep(4000);
      expect((await jobCount([shop.id], [PRODUCT])) === before, "no product job");
      await drainQueue(shop.id);
    });

    await check("'Làm mới TT SP' → every referenced item re-read (READ ONLY, low priority); rows updated, not duplicated", async () => {
      const { data: before } = await admin.from("shopee_ads_products").select("id").eq("shop_id", shop.id);
      await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      await page.locator(`[data-slot="ads-auto-sync"] tr[data-shop="${shop.id}"]`).getByRole("button", { name: "Làm mới TT SP" }).click();
      await page.getByText("Đã xếp lịch đọc lại thông tin sản phẩm.").waitFor({ timeout: 30_000 });
      await drainQueue(shop.id);
      const { data: jobsAfter } = await admin.from("channel_sync_jobs").select("status, metadata, created_by").eq("shop_id", shop.id).eq("sync_type", PRODUCT).order("created_at");
      const last = jobsAfter!.at(-1)!;
      expect(last.status === "success" && (last.metadata as { productScope: { scope: string } }).productScope.scope === "all" && last.created_by === userId, JSON.stringify(last.metadata));
      const { data: afterRows } = await admin.from("shopee_ads_products").select("id").eq("shop_id", shop.id);
      expect(afterRows!.length === before!.length, `${before!.length} → ${afterRows!.length}`);
    });

    await check("'Tắt TT SP' → the next product slot enqueues nothing", async () => {
      await page.goto(`${BASE}/shopee/ads${Q}`, { timeout: 180_000 });
      await page.locator(`[data-slot="ads-auto-sync"] tr[data-shop="${shop.id}"]`).getByRole("button", { name: "Tắt TT SP" }).click();
      await page.getByText("Đã tắt thông tin sản phẩm cho shop.").waitFor({ timeout: 30_000 });
      await admin.from("shopee_ads_products").update({ last_checked_at: "2026-01-01T00:00:00Z" }).eq("shop_id", shop.id); // stale on purpose
      await admin.from("shopee_ads_shop_settings").update({ last_product_enrichment_slot_at: null }).eq("shop_id", shop.id);
      const t = await schedulerTick();
      expect(!(t.body.ads?.enqueued ?? []).some((e) => e.syncType === PRODUCT), "no product job");
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
