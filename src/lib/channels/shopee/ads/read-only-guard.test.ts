// ============================================================
// SHOPEE ADS — READ-ONLY GUARD (standing policy, ./read-only-policy.ts):
//   node --test src/lib/channels/shopee/ads/read-only-guard.test.ts
//
// Fails when any layer could WRITE to Shopee Ads:
//   provider surface · endpoint allowlist · HTTP methods · server actions ·
//   UI mutation actions · queue job types · code-search for mutation names.
// A failure here needs a REVIEW, never an auto-ignore. Relaxing it requires
// the user's explicit "cho phép sửa campaign" + a mutation-safety phase.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ADS_SYNC_TYPES as CORE_ADS_SYNC_TYPES } from "../../core/sync-domains.ts";
import { RUNNABLE_SYNC_TYPES } from "../../core/sync-jobs.ts";
import { ADS_PROBE_ENDPOINTS, assertAdsProbeRequest } from "./probe.ts";
import { FixtureShopeeAdsProvider, MeteredShopeeAdsProvider, RealShopeeAdsProvider } from "./provider.ts";
import {
  ADS_APPROVED_POST_READ_ENDPOINTS,
  ADS_FORBIDDEN_IDENTIFIERS,
  ADS_SYNC_TYPES,
  assertAdsReadOnlyRequest,
  AdsWriteForbiddenError,
  isAdsReadJobType,
  isAdsReadOnlyPath,
  isAdsReadOnlyRequest,
} from "./read-only-policy.ts";

const ROOT = process.cwd();

function filesUnder(dir: string, pred: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(rel, pred));
    else if (pred(rel)) out.push(rel);
  }
  return out;
}

const isSource = (p: string) => /\.(ts|tsx)$/.test(p) && !/\.test\.ts$/.test(p);
/** The Ads namespace: everything that can talk to / present Shopee Ads. */
const ADS_FILES = [
  ...filesUnder("src/lib/channels/shopee/ads", isSource),
  ...filesUnder("src/components/ads", isSource),
  ...filesUnder("src/app/(authenticated)/shopee/ads", isSource),
  "scripts/shopee/ads-discovery.ts",
];
const UI_FILES = ADS_FILES.filter((f) => f.endsWith(".tsx"));
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

// Shopee Ads WRITE endpoints (create_/edit_ names from the v2 Ads module listing, plus
// hypothetical write names) — must always be refused, whatever exists on Shopee's side.
const KNOWN_MUTATIONS = [
  "/api/v2/ads/create_auto_product_ads",
  "/api/v2/ads/create_manual_product_ads",
  "/api/v2/ads/edit_auto_product_ads",
  "/api/v2/ads/edit_manual_product_ads",
  "/api/v2/ads/edit_manual_product_ad_keywords",
  "/api/v2/ads/edit_gms_campaign",
  "/api/v2/ads/create_gms_product_campaign",
  "/api/v2/ads/edit_gms_item_product_campaign",
  "/api/v2/ads/set_campaign_budget",
  "/api/v2/ads/update_campaign_status",
  "/api/v2/ads/pause_campaign",
  "/api/v2/ads/delete_campaign",
  "/api/v2/ads/get_campaign_and_set_budget", // read verb + write token
];

test("policy: GET + read path only; known mutation endpoints and other methods are refused", () => {
  for (const p of Object.values(ADS_PROBE_ENDPOINTS)) {
    assert.ok(isAdsReadOnlyRequest("GET", p), p);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(isAdsReadOnlyRequest(m, p), false, `${m} ${p}`);
  }
  for (const p of KNOWN_MUTATIONS) {
    assert.equal(isAdsReadOnlyPath(p), false, p);
    assert.throws(() => assertAdsReadOnlyRequest("GET", p), AdsWriteForbiddenError, p);
    assert.throws(() => assertAdsProbeRequest("GET", p), p);
  }
  for (const p of ["/api/v2/product/get_item_list", "/api/v2/ads/get_x?y=1", "/api/v2/ads/", "/api/v2/ads/GET_TOTAL_BALANCE"]) assert.equal(isAdsReadOnlyPath(p), false, p);
});

test("allowlist contains only read endpoints (no mutation endpoint can be allowlisted)", () => {
  for (const [label, p] of Object.entries(ADS_PROBE_ENDPOINTS)) {
    assert.ok(isAdsReadOnlyPath(p), `${label}: ${p}`);
    assert.ok(!KNOWN_MUTATIONS.includes(p), p);
  }
});

test("POST read exceptions: none approved (adding one needs a documented review)", () => {
  assert.deepEqual([...ADS_APPROVED_POST_READ_ENDPOINTS], [], "a POST read endpoint must be reviewed in docs/shopee-ads-read-only-policy.md first");
});

test("provider exposes READ methods only (get… / list…) — every implementation", () => {
  // private helpers (get / guard) are prefixed by the read verb or are guards; public surface must be get… / list…
  const PRIVATE_HELPERS = new Set(["get", "guard"]);
  const implemented = [RealShopeeAdsProvider, FixtureShopeeAdsProvider, MeteredShopeeAdsProvider].flatMap((cls) => {
    const proto = cls.prototype as unknown as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor" && typeof proto[n] === "function" && !PRIVATE_HELPERS.has(n));
  });
  const src = read("src/lib/channels/shopee/ads/provider.ts");
  const iface = /export interface ShopeeAdsProvider \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
  const declared = [...iface.matchAll(/^\s*([a-zA-Z]+)\(/gm)].map((m) => m[1]);
  assert.ok(declared.length > 0 && implemented.length > 0);
  for (const name of [...declared, ...implemented]) {
    assert.match(name, /^(get|list)[A-Z]/, `provider method "${name}" is not a read method`);
  }
});

test("Ads code never uses POST / PUT / PATCH / DELETE towards Shopee", () => {
  for (const f of ADS_FILES) {
    const src = read(f);
    assert.doesNotMatch(src, /method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i, `${f}: write HTTP method`);
    assert.doesNotMatch(src, /method:\s*"(?!GET")[A-Z]+"/, `${f}: non-GET HTTP method`);
  }
});

test("code-search guard: no mutation identifiers anywhere in the Ads namespace", () => {
  const files = [...ADS_FILES, "src/lib/channels/core/sync-domains.ts"].filter((f) => !f.endsWith("read-only-policy.ts")); // the policy defines the list
  assert.ok(files.length >= 30, `${files.length} files scanned`);
  for (const f of files) {
    const src = read(f);
    for (const id of ADS_FORBIDDEN_IDENTIFIERS) assert.ok(!src.includes(id), `${f}: "${id}" — mutation identifier needs review`);
  }
});

test("server actions in the Ads area are read-only by name and never call a write endpoint", () => {
  const actionFiles = ADS_FILES.filter((f) => /^\s*["']use server["']/m.test(read(f)));
  for (const f of actionFiles) {
    const src = read(f);
    for (const m of src.matchAll(/export async function (\w+)/g)) {
      const words = m[1].replace(/([A-Z])/g, " $1").toLowerCase().split(/\s+/).filter(Boolean);
      for (const w of ["create", "update", "edit", "delete", "remove", "set", "pause", "resume", "stop", "apply", "optimize", "budget", "bid"]) {
        assert.ok(!words.includes(w), `${f}: action ${m[1]} looks like a write`);
      }
    }
    assert.doesNotMatch(src, /\/api\/v2\/ads\//, `${f}: actions must go through the allowlisted probe/provider`);
  }
});

test("UI has no campaign mutation actions (insights are advisory only)", () => {
  const vi = /Chỉnh sửa|Sửa chiến dịch|Tạm dừng chiến dịch|Bật lại|Tiếp tục chạy|Dừng chiến dịch|Kết thúc chiến dịch|Xo?óa chiến dịch|Xoá chiến dịch|Đổi ngân sách|Thay đổi ngân sách|Sửa ngân sách|Đổi giá thầu|Thay đổi giá thầu|Sửa giá thầu|Tối ưu ngay|Áp dụng/i;
  const enLabel = /(>\s*|["'`])(Edit|Pause|Resume|Stop|Delete|Change budget|Change bid|Optimize|Optimize now|Apply|Apply recommendation|Update campaign)(\s*<|["'`])/;
  assert.ok(UI_FILES.length >= 15, `${UI_FILES.length} UI files`);
  for (const f of UI_FILES) {
    // rendered code only: comments may document the policy itself
    const src = read(f).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, vi, `${f}: campaign mutation label`);
    assert.doesNotMatch(src, enLabel, `${f}: campaign mutation label`);
  }
});

test("queue: Ads job types are read/sync only; no Ads mutation job type exists anywhere", () => {
  for (const t of CORE_ADS_SYNC_TYPES) assert.ok(isAdsReadJobType(t), t);
  assert.deepEqual([...CORE_ADS_SYNC_TYPES], [...ADS_SYNC_TYPES], "core mirror == policy list");
  for (const t of ADS_SYNC_TYPES) assert.ok(isAdsReadJobType(t), t);
  for (const bad of ["ads_campaign_update", "ads_budget_update", "ads_bid_update", "ads_status_update", "ads_budget", "ads_set_bid_read"]) assert.equal(isAdsReadJobType(bad), false, bad);
  for (const t of RUNNABLE_SYNC_TYPES as readonly string[]) {
    if (t.startsWith("ads_")) assert.ok(isAdsReadJobType(t), `runnable ${t}`);
  }
  const WRITE_TOKENS = ["update", "edit", "create", "delete", "remove", "set", "pause", "resume", "stop", "status", "bid", "apply"];
  for (const f of [...filesUnder("src", isSource), ...filesUnder("supabase/migrations", (p) => p.endsWith(".sql"))]) {
    for (const m of read(f).matchAll(/["'](ads_[a-z_]+)["']/g)) {
      const tokens = m[1].split("_");
      assert.ok(!tokens.some((t) => WRITE_TOKENS.includes(t)), `${f}: "${m[1]}" looks like an Ads mutation job type`);
    }
  }
});
