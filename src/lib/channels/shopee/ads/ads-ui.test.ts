// ============================================================
// SHOPEE-ADS-UI-1 — Ads dashboard logic (pure: no DOM, no DB, no network):
//   node --test src/lib/channels/shopee/ads/ads-ui.test.ts
//
// formatting, metric direction semantics, date presets / URL filters,
// fixture realism + determinism, shop / status / type filters, campaign
// table search / sort / paging, demo states (empty / error / unsynced /
// large), and static guards: no Ads endpoint call, no Ads migration.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ADS_DEFAULT_PRESET,
  formatAdsRange,
  parseAdsDemo,
  parseAdsFilters,
  parseAdsTableQuery,
  queryCampaigns,
} from "./filters.ts";
import { buildFixtureDashboard, FIXTURE_CAMPAIGNS, FIXTURE_SHOPS, largeFixtureCampaigns } from "./fixtures.ts";
import {
  adsDeltaPercent,
  adsDeltaTone,
  deriveMetrics,
  formatAdsPercent,
  formatDelta,
  formatInt,
  formatMetric,
  formatRoas,
  formatVndCompact,
  formatVndFull,
  gaugeFill,
  meetsTarget,
} from "./metrics.ts";
import { AdsDataUnavailableError, FixtureAdsDashboardSource } from "./source.ts";
import { sanitizeAdsPayload } from "./sanitize.ts";

// 14:30 Vietnam time, Tue 28/10/2026
const NOW = new Date("2026-10-28T07:30:00Z");
const ROOT = path.resolve(import.meta.dirname, "../../../../..");

test("16. number formatting (vi-VN)", () => {
  assert.equal(formatVndCompact(12_542_300), "12,5 triệu ₫");
  assert.equal(formatVndCompact(12_000_000), "12 triệu ₫");
  assert.equal(formatVndCompact(1_770_000_000), "1,77 tỷ ₫");
  assert.equal(formatVndCompact(850_000), "850.000 ₫");
  assert.equal(formatVndFull(12_542_300), "12.542.300 ₫");
  assert.equal(formatRoas(4.82), "4,82x");
  assert.equal(formatAdsPercent(0.0342), "3,42%");
  assert.equal(formatAdsPercent(0.214, 1), "21,4%");
  assert.equal(formatMetric("cpc", 1850), "1.850 ₫");
  assert.equal(formatMetric("acos", 0.214), "21,4%");
  assert.equal(formatInt(12345), "12.345");
  assert.equal(formatDelta(12.44), "+12,4%");
  assert.equal(formatDelta(-3.06), "−3,1%");
  for (const f of [formatVndCompact, formatVndFull, formatRoas, formatInt]) assert.equal(f(null), "—");
});

test("derived ratios are zero-safe (null, never Infinity / NaN)", () => {
  const m = deriveMetrics({ spend: 1_000_000, revenue: 4_820_000, orders: 30, clicks: 500, impressions: 14_620 });
  assert.equal(m.roas?.toFixed(2), "4.82");
  assert.equal(m.acos?.toFixed(4), "0.2075");
  assert.equal(m.cpc, 2000);
  assert.equal(m.conversionRate, 0.06);
  const z = deriveMetrics({ spend: 0, revenue: 0, orders: 0, clicks: 0, impressions: 0 });
  assert.deepEqual([z.roas, z.acos, z.ctr, z.cpc, z.conversionRate], [null, null, null, null, null]);
  assert.equal(adsDeltaPercent(10, 0), null);
  assert.equal(adsDeltaPercent(null, 5), null);
  assert.equal(adsDeltaPercent(110, 100), 10);
});

test("15. delta semantics: rising is not always good", () => {
  assert.equal(adsDeltaTone("roas", 12), "good");
  assert.equal(adsDeltaTone("revenue", 5), "good");
  assert.equal(adsDeltaTone("revenue", -5), "bad");
  assert.equal(adsDeltaTone("acos", 8), "bad");
  assert.equal(adsDeltaTone("acos", -8), "good");
  assert.equal(adsDeltaTone("cpc", 4), "bad");
  // spend: neutral when revenue keeps up, warning when it lags / falls
  assert.equal(adsDeltaTone("spend", 10, { revenueDelta: 15 }), "neutral");
  assert.equal(adsDeltaTone("spend", 10, { revenueDelta: 2 }), "warning");
  assert.equal(adsDeltaTone("spend", 10, { revenueDelta: null }), "warning");
  assert.equal(adsDeltaTone("spend", -10, { revenueDelta: -20 }), "neutral");
  assert.equal(adsDeltaTone("roas", 0.2), "neutral", "flat");
  assert.equal(adsDeltaTone("roas", null), "neutral");
});

test("efficiency targets respect metric direction", () => {
  assert.equal(meetsTarget("roas", 4.5), true);
  assert.equal(meetsTarget("roas", 3), false);
  assert.equal(meetsTarget("acos", 0.2), true);
  assert.equal(meetsTarget("acos", 0.3), false);
  assert.equal(meetsTarget("cpc", 2500), false);
  assert.equal(meetsTarget("ctr", null), null);
  assert.equal(gaugeFill("roas", 4), 0.5, "target sits mid-bar");
  assert.equal(gaugeFill("roas", 100), 1);
  assert.equal(gaugeFill("roas", null), 0);
});

test("9. date presets → VN calendar ranges (default 7 ngày)", () => {
  const r = (period?: string, extra: Record<string, string> = {}) => parseAdsFilters({ period, ...extra }, NOW);
  assert.equal(ADS_DEFAULT_PRESET, "7d");
  assert.deepEqual([r().from, r().to, r().preset], ["2026-10-22", "2026-10-28", "7d"]);
  assert.deepEqual([r("today").from, r("today").to], ["2026-10-28", "2026-10-28"]);
  assert.deepEqual([r("yesterday").from, r("yesterday").to], ["2026-10-27", "2026-10-27"]);
  assert.deepEqual([r("30d").from, r("30d").to], ["2026-09-29", "2026-10-28"]);
  assert.deepEqual([r("this_month").from, r("this_month").to], ["2026-10-01", "2026-10-28"]);
  assert.deepEqual([r("last_month").from, r("last_month").to], ["2026-09-01", "2026-09-30"]);
  const c = r("custom", { from: "2026-10-10", to: "2026-10-03" });
  assert.deepEqual([c.preset, c.from, c.to], ["custom", "2026-10-03", "2026-10-10"], "swapped");
  assert.equal(r("bogus").preset, "7d");
  assert.equal(formatAdsRange("2026-10-22", "2026-10-28"), "22/10 – 28/10/2026");
  assert.equal(formatAdsRange("2026-10-28", "2026-10-28"), "28/10/2026");
});

test("URL filters are validated (shop / status / type / demo / table)", () => {
  const f = parseAdsFilters({ shop: "demo-shop-2", status: "paused", type: "search" }, NOW);
  assert.deepEqual([f.shop, f.status, f.type], ["demo-shop-2", "paused", "search"]);
  const bad = parseAdsFilters({ shop: "x'; drop", status: "deleted", type: "tv" }, NOW);
  assert.deepEqual([bad.shop, bad.status, bad.type], ["all", "all", "all"]);
  assert.equal(parseAdsDemo({ demo: "error" }), "error");
  assert.equal(parseAdsDemo({ demo: "hack" }), null);
  const t = parseAdsTableQuery({ sort: "roas", dir: "asc", page: "2", size: "50", q: "  search " });
  assert.deepEqual([t.sort, t.desc, t.page, t.size, t.q], ["roas", false, 2, 50, "search"]);
  const d = parseAdsTableQuery({ sort: "drop table", size: "7" });
  assert.deepEqual([d.sort, d.desc, d.page, d.size], ["spend", true, 1, 25]);
});

test("51. fixtures cover every campaign archetype with generic names", () => {
  const d = buildFixtureDashboard(parseAdsFilters({ period: "30d" }, NOW), { now: NOW });
  const by = (name: string) => d.campaigns.find((c) => c.name === name);
  const roasOf = (name: string) => by(name)?.metrics.roas ?? 0;
  assert.ok(roasOf("Search - Brand Keywords") > 8, "high-ROAS");
  assert.ok(roasOf("Search - Best Sellers") > 4, "high-performing");
  assert.ok(roasOf("Discovery - New Arrivals") < 1.5, "low-performing");
  const zero = by("Discovery - Combo Test");
  assert.ok(zero && zero.metrics.spend > 0 && zero.metrics.orders === 0, "zero-order");
  const spends = d.campaigns.map((c) => c.metrics.spend);
  assert.equal(by("Search - Main SKUs")?.metrics.spend, Math.max(...spends), "high-spend");
  assert.ok(d.campaigns.some((c) => c.status === "paused"));
  assert.ok(d.campaigns.some((c) => c.status === "ended"));
  assert.ok(d.campaigns.some((c) => c.status === "warning"));
  for (const c of FIXTURE_CAMPAIGNS) assert.match(c.name, /^(Search|Discovery|Retargeting|Shop Ads|Auto) - /);
  // totals add up: overview = Σ campaigns
  const sum = d.campaigns.reduce((a, c) => a + c.metrics.spend, 0);
  assert.equal(d.overview.current.spend, sum);
  // ROAS overall is realistic
  assert.ok(d.overview.current.roas! > 2 && d.overview.current.roas! < 9);
});

test("52. trend changes by preset (hourly today, daily 7 / 30 days)", () => {
  const today = buildFixtureDashboard(parseAdsFilters({ period: "today" }, NOW), { now: NOW });
  assert.equal(today.granularity, "hour");
  assert.equal(today.trend.length, 15, "00h…14h — only hours that already happened");
  const yesterday = buildFixtureDashboard(parseAdsFilters({ period: "yesterday" }, NOW), { now: NOW });
  assert.equal(yesterday.trend.length, 24);
  const d7 = buildFixtureDashboard(parseAdsFilters({ period: "7d" }, NOW), { now: NOW });
  const d30 = buildFixtureDashboard(parseAdsFilters({ period: "30d" }, NOW), { now: NOW });
  assert.equal(d7.granularity, "day");
  assert.equal(d7.trend.length, 7);
  assert.equal(d30.trend.length, 30);
  assert.ok(d30.overview.current.spend > d7.overview.current.spend * 3);
  assert.ok(d7.trend.every((p) => p.spend > 0 && p.revenue > 0), "every day has activity");
  assert.deepEqual(d7.trend.map((p) => p.key), d30.trend.slice(-7).map((p) => p.key), "same calendar days at the end");
  const year = buildFixtureDashboard(parseAdsFilters({ period: "custom", from: "2025-11-01", to: "2026-10-28" }, NOW), { now: NOW });
  assert.equal(year.granularity, "week");
  assert.ok(year.trend.length <= 53);
  // previous period comparison exists
  assert.ok(d7.overview.previous.spend > 0);
  assert.deepEqual(d7.previousRange, { from: "2026-10-15", to: "2026-10-21" });
});

test("fixtures are deterministic (same URL → same dashboard)", () => {
  const f = parseAdsFilters({ period: "30d" }, NOW);
  assert.deepEqual(buildFixtureDashboard(f, { now: NOW }).overview, buildFixtureDashboard(f, { now: NOW }).overview);
});

test("31. shop / status / type filters narrow the data; counts ignore the status filter", () => {
  const all = buildFixtureDashboard(parseAdsFilters({ period: "30d" }, NOW), { now: NOW });
  const s1 = buildFixtureDashboard(parseAdsFilters({ period: "30d", shop: "demo-shop-1" }, NOW), { now: NOW });
  const s2 = buildFixtureDashboard(parseAdsFilters({ period: "30d", shop: "demo-shop-2" }, NOW), { now: NOW });
  assert.equal(all.shops.length, 2);
  assert.deepEqual(all.shops.map((s) => s.name), FIXTURE_SHOPS.map((s) => s.name));
  assert.ok(s1.campaigns.every((c) => c.shopId === "demo-shop-1"));
  assert.equal(s1.overview.current.spend + s2.overview.current.spend, all.overview.current.spend);
  const paused = buildFixtureDashboard(parseAdsFilters({ period: "30d", status: "paused" }, NOW), { now: NOW });
  assert.ok(paused.campaigns.length > 0 && paused.campaigns.every((c) => c.status === "paused"));
  assert.equal(paused.statusCounts.all, all.statusCounts.all, "chip counts ignore the status filter");
  assert.equal(paused.statusCounts.paused, paused.campaigns.length);
  const search = buildFixtureDashboard(parseAdsFilters({ period: "30d", type: "search" }, NOW), { now: NOW });
  assert.ok(search.campaigns.every((c) => c.type === "search"));
  const unknown = buildFixtureDashboard(parseAdsFilters({ period: "30d", shop: "real-shop-uuid" }, NOW), { now: NOW });
  assert.equal(unknown.filters.shop, "all", "unknown shop falls back to all");
});

test("21–22. campaign table: accent-insensitive search, sort (nulls last), paging", () => {
  const d = buildFixtureDashboard(parseAdsFilters({ period: "30d" }, NOW), { now: NOW });
  const q = (o: Record<string, string>) => queryCampaigns(d.campaigns, parseAdsTableQuery(o));
  const bySpend = q({});
  assert.equal(bySpend.rows[0].name, "Search - Main SKUs", "default: spend desc");
  const byRoasAsc = q({ sort: "roas", dir: "asc" });
  assert.ok(byRoasAsc.rows[0].metrics.roas! <= byRoasAsc.rows[1].metrics.roas!);
  assert.equal(q({ q: "combo" }).total, 2);
  assert.equal(q({ q: "SHOP 2" }).rows.every((r) => r.shopName === "Shop 2"), true);
  const byName = q({ sort: "name", dir: "asc" });
  assert.deepEqual(byName.rows.map((r) => r.name), [...byName.rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b, "vi")));
  const empty = q({ q: "khong co gi" });
  assert.deepEqual([empty.total, empty.rows.length], [0, 0]);
});

test("60. 100+ campaigns: large fixture pages quickly and stays consistent", () => {
  assert.equal(largeFixtureCampaigns().length, 120);
  const t0 = performance.now();
  const d = buildFixtureDashboard(parseAdsFilters({ period: "30d" }, NOW), { now: NOW, scenario: "large" });
  const ms = performance.now() - t0;
  assert.ok(d.campaigns.length >= 100, `${d.campaigns.length} rows`);
  assert.ok(ms < 1000, `built in ${ms.toFixed(0)} ms`);
  const page3 = queryCampaigns(d.campaigns, parseAdsTableQuery({ page: "3", size: "25" }));
  assert.deepEqual([page3.page, page3.rows.length, page3.total], [3, 25, d.campaigns.length]);
  const beyond = queryCampaigns(d.campaigns, parseAdsTableQuery({ page: "99" }));
  assert.equal(beyond.page, Math.ceil(d.campaigns.length / 25), "clamped to last page");
});

test("35–38. demo states: empty, unsynced, error (friendly), sync freshness", async () => {
  const f = parseAdsFilters({ period: "7d" }, NOW);
  const fresh = await new FixtureAdsDashboardSource({ now: () => NOW }).load(f);
  assert.equal(fresh.sync.state, "fresh");
  assert.equal(fresh.sync.source, "fixture");
  assert.equal(Date.parse(fresh.sync.lastSyncedAt!), NOW.getTime() - 3 * 60_000, "\"Cập nhật 3 phút trước\"");
  const empty = await new FixtureAdsDashboardSource({ scenario: "empty", now: () => NOW }).load(f);
  assert.deepEqual([empty.campaigns.length, empty.statusCounts.all, empty.overview.current.spend, empty.overview.current.roas], [0, 0, 0, null]);
  const unsynced = await new FixtureAdsDashboardSource({ scenario: "unsynced", now: () => NOW }).load(f);
  assert.deepEqual([unsynced.sync.state, unsynced.sync.lastSyncedAt], ["never", null]);
  await assert.rejects(new FixtureAdsDashboardSource({ scenario: "error" }).load(f), (e: unknown) => {
    assert.ok(e instanceof AdsDataUnavailableError);
    assert.equal(e.message, "Không tải được dữ liệu quảng cáo.");
    assert.doesNotMatch(e.message, /fixture|simulated/i, "no raw cause in the message");
    return true;
  });
});

test("27. demo insights are short and tone-tagged", () => {
  const d = buildFixtureDashboard(parseAdsFilters({ period: "30d" }, NOW), { now: NOW });
  assert.ok(d.insights.length > 0 && d.insights.length <= 4);
  assert.ok(d.insights.some((i) => i.title === "Campaign tiêu ngân sách nhưng chưa có đơn"));
  for (const i of d.insights) {
    assert.ok(["success", "warning", "danger", "info"].includes(i.tone));
    assert.ok(i.title.length <= 60 && i.description.length <= 160, i.id);
  }
});

function filesUnder(dir: string, pred: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(rel, pred));
    else if (pred(rel)) out.push(rel);
  }
  return out;
}

test("64. no real Ads API call: Ads UI code never imports the Shopee client / fetches", () => {
  const files = [
    ...filesUnder("src/lib/channels/shopee/ads", (p) => /\.tsx?$/.test(p) && !p.endsWith(".test.ts")),
    ...filesUnder("src/components/ads", (p) => /\.tsx?$/.test(p)),
    ...filesUnder("src/app/(authenticated)/shopee/ads", (p) => /\.tsx?$/.test(p)),
  ];
  assert.ok(files.length >= 15, `${files.length} files`);
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /\bfetch\(/, f);
    assert.doesNotMatch(src, /from ["'][^"']*shopee\/(client|connection|server|signing|real-provider)/, f);
    assert.doesNotMatch(src, /\/api\/v2\/(ads|marketing)/i, `${f}: no guessed Ads endpoint`);
  }
});

test("65. no Ads DB migration / production Ads tables", () => {
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"));
  for (const m of migrations) {
    const sql = readFileSync(path.join(ROOT, "supabase/migrations", m), "utf8");
    assert.doesNotMatch(sql, /create\s+table[^;(]*\bads_/i, m);
  }
});

test("ADS-1. discovery sanitizer drops credentials (and shop / partner ids for fixtures), keeps structure", () => {
  const raw = {
    request_id: "r1",
    access_token: "secret-a",
    response: { shop_id: 1, partner_id: 2, sign: "x", list: [{ campaign_id: 9, refresh_token: "secret-r", cost: 1.5 }] },
  };
  assert.deepEqual(sanitizeAdsPayload(raw), {
    request_id: "r1",
    response: { shop_id: 1, partner_id: 2, list: [{ campaign_id: 9, cost: 1.5 }] },
  });
  assert.deepEqual(sanitizeAdsPayload(raw, { dropIdentity: true }), {
    request_id: "r1",
    response: { list: [{ campaign_id: 9, cost: 1.5 }] },
  });
  assert.equal(JSON.stringify(sanitizeAdsPayload(raw)).includes("secret"), false);
});
