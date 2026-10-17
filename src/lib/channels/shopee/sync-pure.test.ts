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

import { internalSecret, isAuthorizedInternalRequest } from "../../cron/auth.ts";
import { devToolsEnabled } from "../../dev-tools.ts";
import { diagnosePendingJob, PENDING_REASON_LABELS, type PendingDiagnosticsContext } from "../core/sync-diagnostics.ts";
import { decideFailure, ExecutionBudget, retryDelaySeconds } from "../core/retry-policy.ts";
import { getSyncConfig, SYNC_CONFIG_DEFAULTS, SYNC_PRIORITY, syncJobPriority } from "../core/sync-config.ts";
import { syncDisplayState, SYNC_DISPLAY_LABELS } from "../core/sync-display.ts";
import { isHeartbeatStale } from "../core/sync-heartbeat.ts";
import { emptyLatency, medianMs, recordLatency, MAX_LATENCY_SAMPLES } from "../core/sync-progress.ts";
import { continuation } from "../core/sync-runner.ts";
import { mapWithConcurrency } from "../core/time-windows.ts";
import { ShopeeConfigError } from "./config.ts";
import { ShopeeApiError } from "./errors.ts";
import { ShopeePayloadError } from "./product-adapter.ts";
import { ORDER_DETAIL_TTL_MINUTES, orderDetailTtlMinutes, shouldRefreshOrderDetail, shouldRefreshProductDetail, type LocalOrderState } from "./sync-decisions.ts";
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

test("PERF-2 config: production cadence 5 / 15 / 60 min, escrow 2 in flight, 1 worker trigger, no chaining, 45 s soft deadline", () => {
  const c = getSyncConfig({});
  assert.equal(c.orderIntervalMinutes, 5);
  assert.equal(c.escrowIntervalMinutes, 15);
  assert.equal(c.productIntervalMinutes, 60);
  assert.equal(c.escrowConcurrency, 2);
  assert.equal(c.schedulerWorkerTriggers, 1);
  assert.equal(c.maxChainHops, 0);
  assert.equal(c.workerTimeBudgetMs, 45_000);
  assert.equal(c.escrowRefreshWindowDays, 14);
  // triggers can never exceed the global worker cap
  const capped = getSyncConfig({ SHOPEE_SYNC_SCHEDULER_WORKER_TRIGGERS: "3", SHOPEE_SYNC_GLOBAL_WORKERS: "2" });
  assert.equal(capped.schedulerWorkerTriggers, 2);
  assert.equal(capped.warnings.length, 1);
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

test("priority convention: lower = first; manual/repair (1–5) < order 10 < escrow 20 < product 30 < backfill 100", () => {
  assert.equal(syncJobPriority("manual", "order"), 1);
  assert.ok(syncJobPriority("manual", "product") <= 5);
  assert.equal(syncJobPriority("repair", "escrow"), 5);
  assert.equal(syncJobPriority("incremental", "order"), 10);
  assert.equal(syncJobPriority("incremental", "escrow"), 20);
  assert.equal(syncJobPriority("incremental", "product"), 30);
  assert.equal(syncJobPriority("backfill", "order"), SYNC_PRIORITY.backfill);
  assert.ok(syncJobPriority("manual", "product") < syncJobPriority("incremental", "order"));
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

test("18. active order older than its status TTL refreshes; recent active order is skipped", () => {
  // now = 01:00; copies 50 min old
  const ago50 = "2026-10-14T00:10:00Z";
  assert.equal(shouldRefreshOrderDetail(local({ orderStatus: "READY_TO_SHIP", lastSyncedAt: ago50 }), { orderSn: "A", orderStatus: "READY_TO_SHIP" }, W).reason, "active_stale");
  assert.equal(shouldRefreshOrderDetail(local({ orderStatus: "SHIPPED", lastSyncedAt: ago50 }), { orderSn: "A", orderStatus: "SHIPPED" }, W).refresh, false, "SHIPPED: 60-min TTL");
  const fresh = local({ orderStatus: "READY_TO_SHIP", lastSyncedAt: "2026-10-14T00:50:00Z" });
  assert.equal(shouldRefreshOrderDetail(fresh, { orderSn: "A", orderStatus: "READY_TO_SHIP" }, W).refresh, false);
  // IN_CANCEL refreshes after 15 min
  assert.equal(shouldRefreshOrderDetail(local({ orderStatus: "IN_CANCEL", lastSyncedAt: "2026-10-14T00:40:00Z" }), { orderSn: "A", orderStatus: "IN_CANCEL" }, W).reason, "active_stale");
});

test("PERF-2 8. order TTL policy lives in one table: active statuses 15–60 min, final statuses never by age", () => {
  assert.equal(orderDetailTtlMinutes("UNPAID", 30), 30);
  assert.equal(orderDetailTtlMinutes("READY_TO_SHIP", 30), 30);
  assert.equal(orderDetailTtlMinutes("PROCESSED", 30), 30);
  assert.equal(orderDetailTtlMinutes("SHIPPED", 30), 60);
  assert.equal(orderDetailTtlMinutes("IN_CANCEL", 30), 15);
  assert.equal(orderDetailTtlMinutes("COMPLETED", 30), null);
  assert.equal(orderDetailTtlMinutes("CANCELLED", 30), null);
  assert.equal(orderDetailTtlMinutes("SOME_NEW_STATUS", 30), null, "unknown non-active status: no periodic fetch");
  for (const v of Object.values(ORDER_DETAIL_TTL_MINUTES)) assert.ok(v === null || (v >= 15 && v <= 60));
  // a COMPLETED order inside the overlap is never re-fetched by age, however old the copy
  const old = local({ orderStatus: "COMPLETED", lastSyncedAt: "2026-10-14T00:00:01Z" });
  assert.equal(shouldRefreshOrderDetail(old, { orderSn: "A", orderStatus: "COMPLETED" }, { ...W, now: new Date("2026-10-20T00:00:00Z") }).refresh, false);
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

test("8. worker/scheduler auth: SHOPEE_SYNC_INTERNAL_SECRET, SYNC_WORKER_SECRET or CRON_SECRET; nothing set → refused", () => {
  assert.equal(isAuthorizedInternalRequest("Bearer i", { SHOPEE_SYNC_INTERNAL_SECRET: "i" }), true);
  assert.equal(isAuthorizedInternalRequest("Bearer i", { SHOPEE_SYNC_INTERNAL_SECRET: "other" }), false);
  assert.equal(internalSecret({ SHOPEE_SYNC_INTERNAL_SECRET: "i", CRON_SECRET: "c" }), "i");
  assert.equal(internalSecret({}), null);
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

test("auto-map is database-only: the action and the mapping module never import a Shopee provider / client / token / sync service", () => {
  const forbidden = /channels\/shopee\/(server|client|token|order-provider|product-provider|order-sync|product-sync|sync-service|signing)(\.ts)?["']|ShopeeClient|getModelList|getItemBaseInfo|listItems\(/;
  for (const rel of ["src/app/(authenticated)/shopee/products/actions.ts", "src/lib/channels/core/sku-mapping.ts"]) {
    const src = readFileSync(new URL(rel, ROOT), "utf8");
    assert.doesNotMatch(src, forbidden, rel);
  }
  // …and the mapping itself is one set-based RPC, not per-row id lists over HTTP (the "URI too long" bug).
  const mapping = readFileSync(new URL("src/lib/channels/core/sku-mapping.ts", ROOT), "utf8");
  assert.match(mapping, /rpc\("auto_map_channel_models"/);
  assert.match(mapping, /rpc\("refresh_channel_mapping_review_flags"/);
});

// ------------------------------------------------------------- PERF-2

test("PERF-2 10. continuation reason: time budget spent → time_budget; call cap → batch_limit (status stays pending)", () => {
  let t = 0;
  const timed = new ExecutionBudget({ timeMs: 100, maxApiCalls: 10, clock: () => t });
  t = 100;
  assert.deepEqual(continuation(timed, "more_pages"), { kind: "more", reason: "time_budget", remaining: "more_pages" });
  const capped = new ExecutionBudget({ timeMs: 10_000, maxApiCalls: 1, clock: () => 0 });
  capped.spend(1);
  assert.deepEqual(continuation(capped, "more_details"), { kind: "more", reason: "batch_limit", remaining: "more_details" });
});

test("PERF-2 30. sync matrix state: Chưa đồng bộ / Đang chờ / Đang đồng bộ / Đang thử lại / Đã đồng bộ / Đồng bộ thất bại", () => {
  const st = (lastSuccessAt: string | null, latest: { status: string; startedAt: string | null } | null, active: Array<{ status: string; startedAt: string | null }>) =>
    SYNC_DISPLAY_LABELS[syncDisplayState({ lastSuccessAt, latestJob: latest, activeJobs: active })];
  assert.equal(st(null, null, []), "Chưa đồng bộ");
  assert.equal(st(null, null, [{ status: "pending", startedAt: null }]), "Đang chờ");
  assert.equal(st(null, null, [{ status: "running", startedAt: "x" }]), "Đang đồng bộ");
  assert.equal(st(null, null, [{ status: "pending", startedAt: "x" }]), "Đang đồng bộ", "between slices = still syncing");
  assert.equal(st("t", null, [{ status: "retry", startedAt: "x" }]), "Đang thử lại");
  assert.equal(st("t", { status: "success", startedAt: "x" }, []), "Đã đồng bộ");
  assert.equal(st("t", { status: "failed", startedAt: "x" }, []), "Đồng bộ thất bại");
  assert.equal(st("t", { status: "cancelled", startedAt: "x" }, []), "Đã đồng bộ");
});

test("PERF-2 31. scheduler warning: never ran or last run older than the threshold", () => {
  const now = new Date("2026-10-16T10:00:00Z");
  assert.equal(isHeartbeatStale(null, now, 5), true);
  assert.equal(isHeartbeatStale({ last_run_at: null }, now, 5), true);
  assert.equal(isHeartbeatStale({ last_run_at: "2026-10-16T09:58:00Z" }, now, 5), false);
  assert.equal(isHeartbeatStale({ last_run_at: "2026-10-16T09:54:00Z" }, now, 5), true);
  // the default threshold is ≥ 3 scheduler intervals
  const c = getSyncConfig({});
  assert.ok(c.schedulerWarnAfterMinutes >= 3 * c.schedulerIntervalMinutes);
  assert.equal(getSyncConfig({ SHOPEE_SYNC_SCHEDULER_INTERVAL_MINUTES: "5", SHOPEE_SYNC_SCHEDULER_WARN_AFTER_MINUTES: "6" }).schedulerWarnAfterMinutes, 15);
});

test("PERF-2 13. latency stats: per-api count / total / max, bounded samples, median; the meter times every call", async () => {
  const s = emptyLatency();
  for (const v of [30, 10, 20, 1000]) recordLatency(s, v);
  assert.deepEqual({ n: s.n, totalMs: s.totalMs, maxMs: s.maxMs }, { n: 4, totalMs: 1060, maxMs: 1000 });
  assert.equal(medianMs(s), 25);
  for (let i = 0; i < 100; i++) recordLatency(s, 5);
  assert.equal(s.samples.length, MAX_LATENCY_SAMPLES);
  let t = 0;
  const meter = new ApiCallMeter(null, () => t);
  await meter.track("get_escrow_detail", async () => {
    t += 120;
  });
  assert.deepEqual(meter.latency.get_escrow_detail.samples, [120]);
});

test("PERF-2 22 + 29 (static). scheduler / worker never call Shopee from the auto-map path; data pages read only the DB", () => {
  // the scheduler route enqueues + bursts; it never imports a provider or the product sync directly
  const route = readFileSync(new URL("src/app/api/internal/shopee/sync-scheduler/route.ts", ROOT), "utf8");
  assert.doesNotMatch(route, /(order|product|payment)-provider|product-sync|order-sync|sku-mapping|ShopeeClient/);
  // the only Shopee-calling route outside the queue is the read-only latency probe (internal secret)
  const internals = filesUnder(new URL("src/app/api/internal/shopee/", ROOT), (p) => p.endsWith("route.ts"));
  for (const file of internals) assert.match(readFileSync(file, "utf8"), /isAuthorizedInternalRequest/, file);
});

test("32 (static). no Promise.all in the Shopee sync / provider code — fan-out goes through mapWithConcurrency", () => {
  const files = filesUnder(new URL("src/lib/channels/shopee/", ROOT), (p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.includes("test-util"));
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /Promise\.all\(/, file);
});

// ------------------------------------------------------------------
// LOCAL-LIVE-1 §14: pending-job diagnostics + §9 dev-tools gate
// ------------------------------------------------------------------
test("LOCAL-LIVE-1 §14: every pending reason is named, in claim order", () => {
  const now = new Date("2030-01-01T10:00:00Z");
  const fresh = "2030-01-01T09:59:30Z";
  const ctx = (o: Partial<PendingDiagnosticsContext> = {}): PendingDiagnosticsContext => ({
    now,
    runnableTypes: ["order", "product", "escrow"],
    shopAllowlist: null,
    activeShopIds: new Set(["s1"]),
    runningLanes: new Set(),
    runningCount: 0,
    maxRunning: 1,
    scheduler: { last_run_at: fresh },
    worker: { last_run_at: null, last_success_at: fresh, last_error_at: null, last_error: null },
    staleAfterMinutes: 5,
    ...o,
  });
  const job = (o: Record<string, unknown> = {}) =>
    ({ shop_id: "s1", sync_type: "order", status: "pending", attempt_count: 0, max_attempts: 3, next_attempt_at: null, window_from: null, window_to: null, ...o }) as Parameters<typeof diagnosePendingJob>[0];
  const reason = (j = job(), c = ctx()) => diagnosePendingJob(j, c)?.reason;

  assert.equal(diagnosePendingJob(job({ status: "running" }), ctx()), null);
  assert.equal(diagnosePendingJob(job({ status: "success" }), ctx()), null);
  assert.equal(reason(), "ready");
  assert.equal(reason(job({ sync_type: "income" })), "invalid_job");
  assert.equal(reason(job({ window_from: "2030-01-02T00:00:00Z", window_to: "2030-01-01T00:00:00Z" })), "invalid_job");
  assert.equal(reason(job(), ctx({ activeShopIds: new Set() })), "shop_inactive");
  assert.equal(reason(job(), ctx({ shopAllowlist: ["other"] })), "shop_not_allowed");
  assert.equal(reason(job({ status: "retry", attempt_count: 3 })), "max_attempts");
  const wait = diagnosePendingJob(job({ status: "retry", attempt_count: 1, next_attempt_at: "2030-01-01T10:05:00Z" }), ctx());
  assert.deepEqual([wait?.reason, wait?.detail], ["waiting_next_attempt", "2030-01-01T10:05:00Z"]);
  assert.equal(reason(job({ status: "retry", attempt_count: 1, next_attempt_at: "2030-01-01T09:00:00Z" })), "ready", "due retry is claimable");
  assert.equal(reason(job(), ctx({ runningLanes: new Set(["s1|order"]), runningCount: 1 })), "same_lane_running");
  assert.equal(reason(job(), ctx({ runningLanes: new Set(["s1|product"]), runningCount: 1 })), "global_capacity");
  assert.equal(reason(job(), ctx({ runningLanes: new Set(["s1|product"]), runningCount: 1, maxRunning: 2 })), "ready");
  const failed = diagnosePendingJob(job(), ctx({ worker: { last_run_at: null, last_success_at: "2030-01-01T09:00:00Z", last_error_at: fresh, last_error: "claim_next_sync_job: boom" } }));
  assert.deepEqual([failed?.reason, failed?.detail], ["claim_failed", "claim_next_sync_job: boom"]);
  assert.equal(reason(job(), ctx({ scheduler: null })), "scheduler_not_running");
  assert.equal(reason(job(), ctx({ scheduler: { last_run_at: "2030-01-01T09:00:00Z" } })), "scheduler_not_running");
  assert.equal(reason(job(), ctx({ worker: null })), "worker_not_running");
  for (const label of Object.values(PENDING_REASON_LABELS)) assert.ok(label.length > 0);
});

test("LOCAL-LIVE-1 §9: dev tools only on local", () => {
  assert.equal(devToolsEnabled({ NODE_ENV: "development" }), true);
  assert.equal(devToolsEnabled({ NODE_ENV: "test" }), true);
  assert.equal(devToolsEnabled({ NODE_ENV: "production" }), false);
  assert.equal(devToolsEnabled({ NODE_ENV: "production", APP_ENV: "local" }), true, "local next start");
  assert.equal(devToolsEnabled({ NODE_ENV: "production", APP_ENV: "production" }), false);
  assert.equal(devToolsEnabled({ NODE_ENV: "production", APP_ENV: "local", VERCEL_ENV: "production" }), false, "never on Vercel production");
  assert.equal(devToolsEnabled({ NODE_ENV: "development", VERCEL_ENV: "production" }), false);
});
