// APP-SHELL-1: app registry, per-app navigation, app access, sync-health
// wording, route-group consistency and the zero-provider-call guards.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ROLES, hasPermission } from "../auth/permissions.ts";
import { safeNextPath } from "../auth/redirect.ts";
import { getShopeeFlags } from "../feature-flags.ts";
import { APP_NAV, activeNavItemHref, visibleNav, type NavContext } from "./nav.ts";
import { APP_REGISTRY, appForPath, canAccessApp, getApp, hubApps, type AppId } from "./registry.ts";
import { classifyShopSync, connectionSummaryText } from "./sync-health.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const AUTH = path.join(ROOT, "src/app/(authenticated)");

function walk(dir: string, filter: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

/** "src/app/(authenticated)/(shopee)/shopee/ads/page.tsx" → { group: "shopee", url: "/shopee/ads" } */
function routeOf(file: string): { group: string; url: string } {
  const rel = path.relative(AUTH, path.dirname(file)).split(path.sep);
  const group = rel[0].replace(/^\(|\)$/g, "");
  const url = "/" + rel.slice(1).filter((s) => !/^\(.*\)$/.test(s)).join("/");
  return { group, url };
}

const pages = walk(AUTH, (p) => p.endsWith(`${path.sep}page.tsx`));
const ctx = (over: Partial<NavContext> = {}): NavContext => ({ role: "admin", adsEnabled: true, legacyModulesEnabled: false, ...over });
const hrefsOf = (groups: ReturnType<typeof visibleNav>) => groups.flatMap((g) => g.items.map((i) => i.href));

// ------------------------------------------------------------------ registry

test("registry: unique ids, every field set, one nav config per app, accent = id", () => {
  const ids = APP_REGISTRY.map((a) => a.id);
  assert.deepEqual(ids, ["accounting", "shopee", "purchasing", "creative", "marketing", "system"]);
  assert.equal(new Set(ids).size, ids.length);
  for (const app of APP_REGISTRY) {
    assert.ok(app.name && app.subtitle && app.description && app.icon && app.href.startsWith("/"), app.id);
    assert.equal(app.accent, app.id);
    assert.ok(APP_NAV[app.id]?.length, `${app.id} has a nav config`);
    assert.ok(app.routePrefixes.length > 0);
  }
  assert.equal(getApp("accounting").name, "Theo dõi hàng về", "hub name for the accounting app");
  assert.equal(getApp("accounting").subtitle, "Kế toán & vận hành");
  assert.doesNotMatch(JSON.stringify(APP_REGISTRY), /legacy/i, "no internal 'legacy' wording shown to users");
});

test("registry: every app landing and every live nav link resolves to a real route (no broken link)", () => {
  const urls = new Set(pages.map((p) => routeOf(p).url));
  const aliases = new Set(["/apps/accounting", "/apps/system"]); // next.config redirects
  const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
  for (const a of aliases) assert.match(config, new RegExp(`source: "${a}"`), a);
  const exists = (href: string) => {
    const p = href.split(/[?#]/)[0];
    return urls.has(p) || aliases.has(p);
  };
  for (const app of APP_REGISTRY) assert.ok(exists(app.href) && exists(`/apps/${app.id}`), `${app.id}: ${app.href} + /apps/${app.id}`);
  for (const [id, groups] of Object.entries(APP_NAV)) {
    for (const item of groups.flatMap((g) => g.items)) {
      if (item.soon) continue;
      if (item.flag === "legacy") continue; // retired pages: exist, but the proxy redirects them while the flag is off
      assert.ok(exists(item.href), `${id}: ${item.href}`);
    }
  }
});

test("route groups: every page sits in the group of the app that owns its URL (hub pages own none)", () => {
  assert.ok(pages.length > 50, "found the app pages");
  for (const file of pages) {
    const { group, url } = routeOf(file);
    const owner = appForPath(url);
    if (group === "hub") assert.equal(owner, null, url);
    else assert.equal(owner, group, `${url} is in (${group}) but belongs to ${owner}`);
  }
});

test("appForPath: URL is the source of truth (longest prefix, segment match)", () => {
  assert.equal(appForPath("/apps"), null);
  assert.equal(appForPath("/forbidden"), null);
  assert.equal(appForPath("/apps/shopee"), "shopee");
  assert.equal(appForPath("/shopee/ads"), "shopee");
  assert.equal(appForPath("/shopee/product-analytics/abc"), "shopee");
  assert.equal(appForPath("/shopee/payouts/1"), "accounting", "retired Shopee accounting pages belong to accounting");
  assert.equal(appForPath("/receipts/new"), "accounting");
  assert.equal(appForPath("/settings/shopee"), "shopee");
  assert.equal(appForPath("/settings/notifications"), "system");
  assert.equal(appForPath("/users"), "system");
  assert.equal(appForPath("/apps/marketing"), "marketing");
  assert.equal(appForPath("/receiptsx"), null, "segment match only");
});

// ------------------------------------------------------------------ access

test("app access: no existing role loses a screen; system app is admin-only and hidden otherwise", () => {
  for (const role of ROLES) {
    assert.ok(canAccessApp(role, "accounting") && canAccessApp(role, "shopee"), role);
    assert.equal(canAccessApp(role, "shopee"), hasPermission(role, "channel:view"), "shopee app = channel:view");
  }
  assert.equal(canAccessApp("admin", "system"), true);
  assert.equal(canAccessApp("staff", "system"), false);
  assert.equal(canAccessApp("viewer", "system"), false);
  assert.equal(canAccessApp(null, "accounting"), false, "no role → nothing");

  const admin = hubApps("admin");
  assert.deepEqual(admin.map((a) => [a.id, a.access]), [["accounting", "open"], ["shopee", "open"], ["purchasing", "soon"], ["creative", "soon"], ["marketing", "soon"], ["system", "open"]]);
  for (const role of ["staff", "viewer"] as const) {
    const apps = hubApps(role);
    assert.ok(!apps.some((a) => a.id === "system"), `${role}: internal app hidden`);
    assert.equal(apps.filter((a) => a.access === "open").length, 2);
  }
  assert.deepEqual(hubApps(null).filter((a) => a.access === "open"), [], "no access → the hub's empty state");
});

test("post-login: plain sign-in → /apps, deep links kept, open redirects refused", () => {
  assert.equal(safeNextPath(""), "/apps");
  assert.equal(safeNextPath("/shopee/ads"), "/shopee/ads");
  assert.equal(safeNextPath("/shopee/product-analytics?health=ATTENTION"), "/shopee/product-analytics?health=ATTENTION");
  assert.equal(safeNextPath("//evil.example/apps"), "/apps");
  const proxy = readFileSync(path.join(ROOT, "src/proxy.ts"), "utf8");
  assert.match(proxy, /redirectTo\("\/login", \{ next: `\$\{pathname\}\$\{search\}` \}\)/, "proxy keeps the requested URL");
  assert.match(proxy, /pathname === "\/login" && user[\s\S]{0,300}redirectTo\("\/apps"\)/);
  assert.match(readFileSync(path.join(ROOT, "src/app/page.tsx"), "utf8"), /router\.replace\("\/apps"\)/);
});

// ------------------------------------------------------------------ navigation

test("domain sidebars contain only their own domain", () => {
  const shopee = hrefsOf(visibleNav("shopee", ctx({ legacyModulesEnabled: true })));
  for (const h of ["/inventory/costs", "/shopee/payouts", "/shopee/returns", "/shopee/analytics/cashflow", "/shopee/orders"]) assert.ok(!shopee.includes(h), `shopee nav has no ${h}`);
  const accounting = hrefsOf(visibleNav("accounting", ctx({ legacyModulesEnabled: true })));
  for (const h of ["/shopee/ads", "/shopee/product-analytics", "/settings/shopee", "/apps/shopee"]) assert.ok(!accounting.some((x) => x.startsWith(h)), `accounting nav has no ${h}`);
  // every live link of an app stays inside that app (no cross-app links in a sidebar)
  for (const app of APP_REGISTRY) {
    for (const item of APP_NAV[app.id].flatMap((g) => g.items).filter((i) => !i.soon)) {
      assert.equal(appForPath(item.href.split(/[?#]/)[0]), app.id, `${app.id}: ${item.href}`);
    }
  }
});

test("nav visibility follows role + flags (legacy hidden while off, Ads flag, admin-only items)", () => {
  const off = hrefsOf(visibleNav("accounting", ctx()));
  assert.ok(!off.some((h) => h.startsWith("/shopee/")), "retired modules hidden while SHOPEE_LEGACY_MODULES_ENABLED is off");
  assert.ok(hrefsOf(visibleNav("accounting", ctx({ legacyModulesEnabled: true }))).includes("/shopee/payouts"));
  assert.deepEqual(hrefsOf(visibleNav("shopee", ctx({ adsEnabled: false }))).filter((h) => h.startsWith("/shopee/")), [], "Ads flag off → no Ads/product links");
  const viewer = hrefsOf(visibleNav("accounting", ctx({ role: "viewer" })));
  assert.ok(!viewer.includes("/receipts/new") && viewer.includes("/receipts"), "viewer: no 'Nhập hàng'");
  assert.ok(!hrefsOf(visibleNav("shopee", ctx({ role: "staff" }))).includes("/settings/shopee"), "staff: no shop connection settings");
  assert.deepEqual(visibleNav("system", ctx({ role: "staff" })), [], "staff: empty system nav (and no access)");
  const ai = visibleNav("shopee", ctx()).flatMap((g) => g.items).find((i) => i.title === "Trợ lý phân tích");
  assert.equal(ai?.soon, true, "PA-4 assistant is 'Sắp có' (not connected)");
  // the default flags never re-enable the retired modules
  assert.equal(getShopeeFlags({}).legacyModulesEnabled, false);
});

test("active item: exactly one, longest path, query-specific beats plain, anchors / soon never active", () => {
  const g = visibleNav("shopee", ctx());
  assert.equal(activeNavItemHref(g, "/shopee/product-analytics", ""), "/shopee/product-analytics");
  assert.equal(activeNavItemHref(g, "/shopee/product-analytics", "health=ATTENTION&period=30d"), "/shopee/product-analytics?health=ATTENTION");
  assert.equal(activeNavItemHref(g, "/shopee/product-analytics", "health=WEAK"), "/shopee/product-analytics");
  assert.equal(activeNavItemHref(g, "/shopee/product-analytics/3b0c-1", ""), "/shopee/product-analytics", "detail page → its list");
  assert.equal(activeNavItemHref(g, "/apps/shopee", ""), "/apps/shopee", "not the #suc-khoe-dong-bo anchor");
  assert.equal(activeNavItemHref(g, "/shopee/ads/probe", ""), "/shopee/ads");
  assert.equal(activeNavItemHref(g, "/settings/zalo-agent", ""), null, "unlinked admin page: no active item");
  const a = visibleNav("accounting", ctx());
  assert.equal(activeNavItemHref(a, "/receipts/new", ""), "/receipts/new");
  assert.equal(activeNavItemHref(a, "/receipts/abc/edit", ""), "/receipts");
  assert.equal(activeNavItemHref(visibleNav("purchasing", ctx()), "/apps/purchasing", ""), "/apps/purchasing");
});

// ------------------------------------------------------------------ status wording

test("sync health: connection + freshness classified, missing data never 'ok'", () => {
  const now = new Date("2026-11-14T10:00:00Z");
  const t = { adsStaleMinutes: 90, salesStaleMinutes: 120 };
  const base = { shopId: "s", shopName: "Shop", connectionStatus: "connected", adsReal: true, adsAt: "2026-11-14T09:50:00Z", salesEnabled: true, salesAt: "2026-11-14T09:40:00Z" };
  const ok = classifyShopSync(base, t, now);
  assert.deepEqual([ok.connected, ok.ads, ok.adsMinutes, ok.sales, ok.salesMinutes, ok.attention], [true, "ok", 10, "ok", 20, false]);
  const stale = classifyShopSync({ ...base, adsAt: "2026-11-14T08:00:00Z", salesAt: "2026-11-14T07:00:00Z" }, t, now);
  assert.deepEqual([stale.ads, stale.sales, stale.attention], ["stale", "stale", true]);
  const none = classifyShopSync({ ...base, adsAt: null, salesAt: null }, t, now);
  assert.deepEqual([none.ads, none.sales, none.attention], ["none", "none", false]);
  const off = classifyShopSync({ ...base, adsReal: false, salesEnabled: false }, t, now);
  assert.deepEqual([off.ads, off.sales], ["off", "off"]);
  assert.equal(classifyShopSync({ ...base, connectionStatus: "expired" }, t, now).attention, true);
  assert.equal(classifyShopSync({ ...base, connectionStatus: null }, t, now).connected, false);

  assert.deepEqual(connectionSummaryText({ shops: 5, connected: 5 }), { text: "Kết nối bình thường", tone: "ok" });
  assert.deepEqual(connectionSummaryText({ shops: 5, connected: 4 }), { text: "1/5 shop cần kết nối lại", tone: "warning" });
  assert.equal(connectionSummaryText({ shops: 0, connected: 0 }).tone, "muted");
});

// ------------------------------------------------------------------ safety guards

const shellSources = () => [
  ...walk(path.join(ROOT, "src/components/app-shell"), (p) => /\.tsx?$/.test(p)),
  ...walk(path.join(ROOT, "src/lib/apps"), (p) => /\.ts$/.test(p) && !p.endsWith(".test.ts")),
  ...pages.filter((p) => /[\\/]apps[\\/]/.test(p)),
  ...["(hub)", "(accounting)", "(shopee)", "(system)", "(purchasing)", "(creative)", "(marketing)"].map((g) => path.join(AUTH, g, "layout.tsx")),
  path.join(AUTH, "layout.tsx"),
];

test("zero provider calls: shells, hub and landings never import the Shopee client / token / sync, nor any AI SDK", () => {
  const files = shellSources();
  assert.ok(files.length >= 15, "found the shell sources");
  const forbidden = /channels\/shopee\/(server|client|token|signing|sync-service|order-sync|product-sync|ads\/provider|ads\/sync|ads\/real-source)|product-analyst\/provider|@anthropic-ai|anthropic|claude|enqueue|sync_jobs|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\("(?!product_analytics_freshness|ads_sync_freshness)/i;
  for (const f of files) {
    if (!existsSync(f)) continue;
    assert.doesNotMatch(readFileSync(f, "utf8"), forbidden, path.relative(ROOT, f));
  }
});

test("no Ads / product write path is reachable from the new navigation", () => {
  const nav = JSON.stringify(APP_NAV);
  assert.doesNotMatch(nav, /campaign.*(edit|budget|bid|status)|\/api\//i);
  for (const id of Object.keys(APP_NAV) as AppId[]) for (const item of APP_NAV[id].flatMap((g) => g.items)) assert.ok(item.href.startsWith("/") && !item.href.startsWith("/api/"), item.href);
});
