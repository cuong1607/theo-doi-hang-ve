// ============================================================
// SHOPEE-PERF-1 — pure logic (no DB):
//   node --test src/lib/channels/shopee/sync-pure.test.ts
//
// config parsing, retry/backoff, execution budget, refresh decisions,
// error classification, bounded concurrency, internal auth, and static
// guards (pages never import the provider / sync entry points; no unbounded
// Promise.all in the Shopee sync code).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { isAuthorizedInternalRequest } from "../../cron/auth.ts";
import { decideFailure, ExecutionBudget, retryDelaySeconds } from "../core/retry-policy.ts";
import { getSyncConfig, SYNC_CONFIG_DEFAULTS, SYNC_PRIORITY } from "../core/sync-config.ts";
import { mapWithConcurrency } from "../core/time-windows.ts";
import { ShopeeConfigError } from "./config.ts";
import { ShopeeApiError } from "./errors.ts";
import { ShopeePayloadError } from "./product-adapter.ts";
import { shouldRefreshOrderDetail, shouldRefreshProductDetail, type LocalOrderState } from "./sync-decisions.ts";
import { JobRefusedError, toJobFailure } from "./sync-errors.ts";
import { ApiCallMeter, JobTokenCache } from "./sync-instrumentation.ts";

const ROOT = new URL("../../../../", import.meta.url);

// ------------------------------------------------------------- config

test("config: conservative defaults (1 job, 3 detail calls in flight)", () => {
  const c = getSyncConfig({});
  assert.equal(c.globalWorkers, 1);
  assert.equal(c.orderDetailConcurrency, 3);
  assert.equal(c.productDetailConcurrency, 3);
  assert.equal(c.orderOverlapMinutes, 10);
  assert.equal(c.shopAllowlist, null);
  assert.deepEqual(c.warnings, []);
});

test("config: env overrides within bounds, invalid values fall back with a warning", () => {
  const c = getSyncConfig({ SHOPEE_SYNC_GLOBAL_WORKERS: "2", SHOPEE_SYNC_ORDER_CONCURRENCY: "99", SHOPEE_SYNC_ACTIVE_ORDER_TTL_MINUTES: "abc" });
  assert.equal(c.globalWorkers, 2);
  assert.equal(c.orderDetailConcurrency, SYNC_CONFIG_DEFAULTS.orderDetailConcurrency);
  assert.equal(c.activeOrderTtlMinutes, SYNC_CONFIG_DEFAULTS.activeOrderTtlMinutes);
  assert.equal(c.warnings.length, 2);
});

test("config: rollout allowlist keeps valid shop uuids only", () => {
  const id = "a0000000-0000-0000-0000-000000000001";
  const c = getSyncConfig({ SHOPEE_SYNC_SHOP_IDS: `${id}, not-a-uuid` });
  assert.deepEqual(c.shopAllowlist, [id]);
  assert.equal(c.warnings.length, 1);
});

test("priority convention: lower = first; manual < incremental < repair < backfill", () => {
  assert.ok(SYNC_PRIORITY.manual < SYNC_PRIORITY.incremental);
  assert.ok(SYNC_PRIORITY.incremental < SYNC_PRIORITY.repair);
  assert.ok(SYNC_PRIORITY.repair < SYNC_PRIORITY.backfill);
});

// ------------------------------------------------------- retry policy

test("22. backoff ≈ 1 → 5 → 15 min (+ ≤ 20 % jitter); Retry-After wins when longer", () => {
  const noJitter = () => 0;
  assert.equal(retryDelaySeconds(1, { random: noJitter }), 60);
  assert.equal(retryDelaySeconds(2, { random: noJitter }), 300);
  assert.equal(retryDelaySeconds(3, { random: noJitter }), 900);
  assert.equal(retryDelaySeconds(9, { random: noJitter }), 900);
  assert.equal(retryDelaySeconds(1, { random: () => 1 }), 72);
  assert.equal(retryDelaySeconds(1, { random: noJitter, retryAfterSeconds: 120 }), 120);
  assert.equal(retryDelaySeconds(2, { random: noJitter, retryAfterSeconds: 10 }), 300);
});

test("7. retryable → retry with next_attempt_at until max_attempts, then failed; fatal → failed at once", () => {
  const now = new Date("2026-10-14T00:00:00Z");
  const retryable = { kind: "retryable" as const, code: "timeout", message: "t" };
  const r1 = decideFailure(retryable, 1, 3, now, () => 0);
  assert.equal(r1.status, "retry");
  assert.equal(r1.nextAttemptAt?.toISOString(), "2026-10-14T00:01:00.000Z");
  assert.equal(decideFailure(retryable, 3, 3, now).status, "failed");
  assert.equal(decideFailure({ kind: "fatal", code: "error_auth", message: "x" }, 1, 3, now).status, "failed");
});

test("9. execution budget: call cap and deadline both stop the slice", () => {
  let t = 0;
  const b = new ExecutionBudget({ timeMs: 1000, maxApiCalls: 3, clock: () => t });
  assert.equal(b.canSpend(3), true);
  b.spend(2);
  assert.equal(b.canSpend(2), false);
  assert.equal(b.apiCallsLeft, 1);
  t = 1000;
  assert.equal(b.canSpend(1), false);
  assert.equal(b.expired, true);
});

// ---------------------------------------------- order refresh decisions

const W = { windowFrom: new Date("2026-10-14T00:00:00Z"), windowTo: new Date("2026-10-14T01:00:00Z"), now: new Date("2026-10-14T01:00:00Z"), activeOrderTtlMinutes: 30 };
const local = (over: Partial<LocalOrderState> = {}): LocalOrderState => ({ orderStatus: "COMPLETED", updatedAtChannel: "2026-10-13T00:00:00Z", lastSyncedAt: "2026-10-14T00:30:00Z", lineCount: 1, ...over });

test("17. new order fetches detail", () => {
  assert.deepEqual(shouldRefreshOrderDetail(null, { orderSn: "A", orderStatus: "READY_TO_SHIP" }, W), { refresh: true, reason: "new" });
});

test("15 + 19. order already fetched inside the window, same status → skipped (completed, unchanged)", () => {
  assert.deepEqual(shouldRefreshOrderDetail(local(), { orderSn: "A", orderStatus: "COMPLETED" }, W), { refresh: false, reason: "unchanged" });
  // fetched after the window ended (e.g. backfill re-run) → definitely unchanged
  assert.equal(shouldRefreshOrderDetail(local({ lastSyncedAt: "2026-10-14T02:00:00Z" }), { orderSn: "A", orderStatus: "COMPLETED" }, W).refresh, false);
});

test("order status changed → fetch", () => {
  assert.deepEqual(shouldRefreshOrderDetail(local({ orderStatus: "SHIPPED" }), { orderSn: "A", orderStatus: "COMPLETED" }, W), { refresh: true, reason: "status_changed" });
});

test("16. provider update_time changed (when the list carries it) → fetch; last fetch before the window → changed since", () => {
  assert.equal(shouldRefreshOrderDetail(local(), { orderSn: "A", orderStatus: "COMPLETED", updateTime: "2026-10-14T00:45:00Z" }, W).reason, "update_time_changed");
  assert.equal(shouldRefreshOrderDetail(local({ lastSyncedAt: "2026-10-13T23:00:00Z" }), { orderSn: "A", orderStatus: "COMPLETED" }, W).reason, "changed_since_last_sync");
});

test("18. active order older than the TTL refreshes; recent active order is skipped", () => {
  const stale = local({ orderStatus: "SHIPPED", lastSyncedAt: "2026-10-14T00:10:00Z" });
  assert.equal(shouldRefreshOrderDetail(stale, { orderSn: "A", orderStatus: "SHIPPED" }, W).reason, "active_stale");
  const fresh = local({ orderStatus: "SHIPPED", lastSyncedAt: "2026-10-14T00:50:00Z" });
  assert.equal(shouldRefreshOrderDetail(fresh, { orderSn: "A", orderStatus: "SHIPPED" }, W).refresh, false);
});

test("local detail missing (no lines / never synced) → fetch; repair → forced", () => {
  assert.equal(shouldRefreshOrderDetail(local({ lineCount: 0 }), { orderSn: "A", orderStatus: "COMPLETED" }, W).reason, "detail_missing");
  assert.equal(shouldRefreshOrderDetail(local({ lastSyncedAt: null }), { orderSn: "A", orderStatus: "COMPLETED" }, W).reason, "detail_missing");
  assert.equal(shouldRefreshOrderDetail(local(), { orderSn: "A", orderStatus: "COMPLETED" }, { ...W, force: true }).reason, "forced");
});

// -------------------------------------------- product refresh decisions

test("20 + 21. product: unchanged update_time skipped; changed / new / units missing fetched", () => {
  const stored = { sourceUpdatedAt: "2026-10-01T00:00:00.000Z", modelCount: 2 };
  assert.equal(shouldRefreshProductDetail(stored, { externalItemId: "1", updateTime: "2026-10-01T00:00:00Z" }).refresh, false);
  assert.equal(shouldRefreshProductDetail(stored, { externalItemId: "1", updateTime: "2026-10-02T00:00:00Z" }).reason, "update_time_changed");
  assert.equal(shouldRefreshProductDetail(null, { externalItemId: "1", updateTime: null }).reason, "new");
  assert.equal(shouldRefreshProductDetail({ ...stored, modelCount: 0 }, { externalItemId: "1", updateTime: "2026-10-01T00:00:00Z" }).reason, "detail_missing");
  assert.equal(shouldRefreshProductDetail(stored, { externalItemId: "1", updateTime: "2026-10-01T00:00:00Z" }, { force: true }).reason, "forced");
});

// ------------------------------------------------- error classification

test("24 + 25. retry only retryable errors: rate limit / 5xx / network retry; auth, signature, parse, config, refused never", () => {
  const rl = toJobFailure(new ShopeeApiError({ apiPath: "/x", errorCode: "error_too_many_request", message: "slow", httpStatus: 429, retryAfterSeconds: 30 }));
  assert.equal(rl.kind, "retryable");
  assert.equal(rl.rateLimited, true);
  assert.equal(rl.retryAfterSeconds, 30);
  assert.equal(toJobFailure(new ShopeeApiError({ apiPath: "/x", errorCode: "error_server", message: "x", httpStatus: 503 })).kind, "retryable");
  assert.equal(toJobFailure(new ShopeeApiError({ apiPath: "/x", errorCode: "network_error", message: "x" })).kind, "retryable");
  assert.equal(toJobFailure(new ShopeeApiError({ apiPath: "/x", errorCode: "error_auth", message: "x", httpStatus: 403 })).kind, "fatal");
  assert.equal(toJobFailure(new ShopeeApiError({ apiPath: "/x", errorCode: "error_sign", message: "x" })).kind, "fatal");
  assert.equal(toJobFailure(new ShopeeApiError({ apiPath: "/x", errorCode: "error_param", message: "x" })).kind, "fatal");
  assert.equal(toJobFailure(new ShopeePayloadError("v2.x", "bad")).kind, "fatal");
  assert.equal(toJobFailure(new ShopeeConfigError(["SHOPEE_PARTNER_ID"])).kind, "fatal");
  assert.equal(toJobFailure(new JobRefusedError("source_mismatch", "x")).code, "source_mismatch");
  assert.equal(toJobFailure(new Error("db hiccup")).kind, "retryable");
});

// ------------------------------------------------ concurrency / metering

test("32. mapWithConcurrency never exceeds its limit; stops scheduling after a failure and waits for in-flight work", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 3, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
  });
  assert.equal(peak, 3);

  const started: number[] = [];
  let finished = 0;
  await assert.rejects(
    mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 2, async (i) => {
      started.push(i);
      await new Promise((r) => setTimeout(r, 5));
      finished++;
      if (i === 1) throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(started.length <= 4, `started ${started.length} after failure`);
  assert.equal(finished, started.length, "every started item finished before the rejection");
});

test("ApiCallMeter counts per API, charges the budget, counts rate-limit hits", async () => {
  const budget = new ExecutionBudget({ timeMs: 10_000, maxApiCalls: 5 });
  const meter = new ApiCallMeter(budget);
  await meter.track("get_order_list", async () => 1);
  await meter.track("get_order_detail", async () => 1);
  await assert.rejects(meter.track("get_order_detail", async () => {
    throw new ShopeeApiError({ apiPath: "/x", errorCode: "error_too_many_request", message: "x", httpStatus: 429 });
  }));
  assert.deepEqual(meter.calls, { get_order_list: 1, get_order_detail: 2 });
  assert.equal(meter.rateLimitHits, 1);
  assert.equal(budget.apiCallsUsed, 3);
});

test("24 (token). JobTokenCache: one token lookup per shop per job; an auth error drops it", async () => {
  let lookups = 0;
  const cache = new JobTokenCache({
    getValidAccessToken: async () => `tok${++lookups}`,
    recordApiFailure: async () => {},
  });
  assert.equal(await cache.getValidAccessToken("s1"), "tok1");
  assert.equal(await cache.getValidAccessToken("s1"), "tok1");
  assert.equal(lookups, 1);
  await cache.recordApiFailure("s1", new ShopeeApiError({ apiPath: "/x", errorCode: "error_auth", message: "x", httpStatus: 403 }));
  assert.equal(await cache.getValidAccessToken("s1"), "tok2");
});

// ------------------------------------------------------------- auth

test("8. worker/scheduler auth: SYNC_WORKER_SECRET or CRON_SECRET; nothing set → refused", () => {
  assert.equal(isAuthorizedInternalRequest("Bearer w", { SYNC_WORKER_SECRET: "w" }), true);
  assert.equal(isAuthorizedInternalRequest("Bearer c", { CRON_SECRET: "c" }), true);
  assert.equal(isAuthorizedInternalRequest("Bearer x", { SYNC_WORKER_SECRET: "w", CRON_SECRET: "c" }), false);
  assert.equal(isAuthorizedInternalRequest(null, { SYNC_WORKER_SECRET: "w" }), false);
  assert.equal(isAuthorizedInternalRequest("Bearer ", {}), false);
  assert.equal(isAuthorizedInternalRequest("Bearer undefined", {}), false);
});

// ------------------------------------------------------ static guards

function filesUnder(dir: URL, filter: (p: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (filter(p)) out.push(p);
    }
  };
  walk(dir.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return out;
}

test("28. Shopee pages never import the provider, token or sync services (UI reads the database only)", () => {
  const pages = filesUnder(new URL("src/app/(authenticated)/shopee/", ROOT), (p) => /page\.tsx$/.test(p));
  assert.ok(pages.length >= 4, "found the Shopee pages");
  const forbidden = /channels\/shopee\/(server|client|token|order-provider|product-provider|order-sync|product-sync|sync-service)["']/;
  for (const page of pages) assert.doesNotMatch(readFileSync(page, "utf8"), forbidden, page);
});

test("27. UI sync actions only enqueue (no sync service / provider call in any Shopee action file)", () => {
  const actions = filesUnder(new URL("src/app/(authenticated)/shopee/", ROOT), (p) => /actions\.ts$/.test(p));
  for (const file of actions) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /\.sync\(|\.backfill\(|getShopee(Order|Product)Sync|ShopeeOrderSyncService|ShopeeProductSyncService/, file);
  }
});

test("32 (static). no Promise.all in the Shopee sync / provider code — fan-out goes through mapWithConcurrency", () => {
  const files = filesUnder(new URL("src/lib/channels/shopee/", ROOT), (p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.includes("test-util"));
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /Promise\.all\(/, file);
});
