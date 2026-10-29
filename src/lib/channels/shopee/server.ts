// ============================================================
// PHASE SHOPEE-1: server wiring for the Shopee module (env config +
// service-role DB + real fetch). The ONLY entry point routes/pages use.
//
// Callers must authorize first (src/lib/auth/session.ts, channel:manage) —
// the service-role client bypasses RLS.
// ============================================================
import "server-only";

import { randomUUID } from "node:crypto";

import { internalSecret } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/supabase/admin";

import { getSyncConfig } from "../core/sync-config.ts";
import { getHeartbeats, markHeartbeatError, markHeartbeatRun, markHeartbeatSuccess, RATE_LIMIT_HEARTBEAT, WORKER_HEARTBEAT } from "../core/sync-heartbeat.ts";
import { mapWithConcurrency } from "../core/time-windows.ts";
import { SyncWorker, type BurstReport } from "../core/sync-worker.ts";
import { ShopeeClient } from "./client.ts";
import { getShopeeConfig, ShopeeConfigError, type ShopeeConfig } from "./config.ts";
import { toJobFailure } from "./sync-errors.ts";
import { JobTokenCache } from "./sync-instrumentation.ts";
import { createShopeeRunnerFactory, hasDueSyncJobs, type ShopeeProviderSource } from "./sync-service.ts";
import { ShopeeConnectionService } from "./token.ts";

import { FixtureShopeeProductProvider, loadProductFixtures, RealShopeeProductProvider } from "./product-provider.ts";
import { FixtureShopeeOrderProvider, loadOrderFixtures, RealShopeeOrderProvider } from "./order-provider.ts";
import { FixtureShopeePaymentProvider, loadEscrowFixtures, RealShopeePaymentProvider } from "./payment-provider.ts";
import { FixtureShopeeReturnProvider, loadReturnFixtures, RealShopeeReturnProvider } from "./return-provider.ts";
import { FixtureShopeeIncomeProvider, RealShopeeIncomeProvider } from "./income-provider.ts";
import { FixtureShopeeReturnLogisticsProvider, loadReturnLogisticsFixtures, RealShopeeReturnLogisticsProvider } from "./return-logistics-provider.ts";
import { getShopeeProviderMode } from "./provider-mode.ts";
import { getShopeeFlags } from "../../feature-flags.ts";
import { activeAdsSyncTypes, activeSyncTypes } from "../core/sync-domains.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExecutionBudget } from "../core/retry-policy.ts";
import type { SyncJobRow } from "../core/sync-jobs.ts";
import type { RunnerHandle } from "../core/sync-worker.ts";
import { ApiCallMeter } from "./sync-instrumentation.ts";
import { JobRefusedError } from "./sync-errors.ts";
import { FixtureShopeeAdsProvider, loadAdsFixtures, MeteredShopeeAdsProvider, RealShopeeAdsProvider, type AdsFixtureData, type ShopeeAdsProvider } from "./ads/provider.ts";
import { isAdsSyncType } from "./ads/read-only-policy.ts";
import { createAdsRunner, getAdsSyncConfig } from "./ads/sync.ts";

let cached: { config: ShopeeConfig; client: ShopeeClient; service: ShopeeConnectionService } | null = null;

// ------------------------------------------------------------------
// SHOPEE-PERF-1: background sync worker wiring. Product / order sync is
// ONLY reachable through the job queue (UI enqueues → worker runs); there is
// deliberately no "sync now inside this request" entry point any more.
// Data-source rule unchanged: live mode never falls back to fixtures.
// ------------------------------------------------------------------

/** In-request retry sleeps are capped: a longer wait becomes the job's next_attempt_at instead. */
const WORKER_MAX_RETRY_SLEEP_MS = 2_000;
/** Per-call timeout for the worker client (default client: 10 s). */
const WORKER_REQUEST_TIMEOUT_MS = 8_000;
/** A kick runs inside a user-facing invocation (server action / scheduler) that already spent time: one slice, then chain. */
const KICK_TIME_BUDGET_MS = 30_000;
let workerClient: ShopeeClient | null = null;

function getWorkerClient(config: ShopeeConfig): ShopeeClient {
  workerClient ??= new ShopeeClient({
    partnerId: config.partnerId,
    partnerKey: config.partnerKey,
    apiBaseUrl: config.apiBaseUrl,
    maxRetries: 1,
    timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, WORKER_MAX_RETRY_SLEEP_MS))),
  });
  return workerClient;
}

/**
 * A worker for one invocation (route / after()). Providers are built per job
 * slice: live → worker client + JobTokenCache over the shared connection
 * service (concurrency-safe refresh of SHOPEE-1); fixture → fixture files.
 */
let adsFixtures: AdsFixtureData | null = null;

/**
 * SHOPEE-ADS-1B: runner for an Ads READ job. Live → the read-only provider over
 * the worker client + job token cache; fixture → the sanitized production
 * payloads (local dev / tests only — refused in production unless explicitly enabled).
 */
function adsRunnerHandle(job: SyncJobRow, budget: ExecutionBudget, db: SupabaseClient): RunnerHandle {
  const flags = getShopeeFlags();
  const meter = new ApiCallMeter(budget);
  let provider: ShopeeAdsProvider;
  if (flags.adsProvider === "fixture") {
    if (process.env.NODE_ENV === "production" && process.env.ENABLE_SHOPEE_FIXTURE_MODE !== "true") {
      throw new JobRefusedError("fixture_refused", "SHOPEE_ADS_PROVIDER=fixture không được dùng ở production.");
    }
    adsFixtures ??= loadAdsFixtures();
    provider = new FixtureShopeeAdsProvider(adsFixtures);
  } else {
    const { config: shopeeConfig, service } = getShopee();
    provider = new RealShopeeAdsProvider({ client: getWorkerClient(shopeeConfig), connections: new JobTokenCache(service) });
  }
  return { meter, runner: createAdsRunner(job, { db, provider: new MeteredShopeeAdsProvider(provider, meter), config: getAdsSyncConfig() }) };
}

/**
 * SHOPEE-ADS-2: Ads API concurrency = running Ads jobs, capped globally by
 * ADS_GLOBAL_API_CONCURRENCY (1 right after a rate limit). When no legacy
 * domain is active the Ads cap may exceed SHOPEE_SYNC_GLOBAL_WORKERS.
 */
function workerLimits(rateLimitedRecently: boolean) {
  const config = getSyncConfig();
  const flags = getShopeeFlags();
  const adsActive = activeAdsSyncTypes(flags).length > 0;
  const ads = getAdsSyncConfig();
  const adsCap = rateLimitedRecently ? 1 : ads.globalApiConcurrency;
  const onlyAds = adsActive && activeSyncTypes(flags).length === 0;
  return {
    maxRunningAds: adsActive ? adsCap : null,
    globalWorkers: onlyAds ? Math.max(config.globalWorkers, adsCap) : config.globalWorkers,
    // stagger jitter must not cost a whole scheduler minute: wait for jobs due within it
    idleWaitMs: adsActive && ads.autoSyncEnabled ? (ads.jitterSeconds + 2) * 1000 : 0,
  };
}

export function getShopeeSyncWorker(limits: { maxRunningAds: number | null; globalWorkers: number; idleWaitMs: number } = workerLimits(false)): SyncWorker {
  const config = { ...getSyncConfig(), globalWorkers: limits.globalWorkers };
  const db = createAdminClient();
  const flags = getShopeeFlags();
  const providers: ShopeeProviderSource = () => {
    const { mode, problem } = getShopeeProviderMode();
    if (problem) throw new ShopeeConfigError([problem]);
    if (mode === "fixture") {
      return {
        mode,
        order: new FixtureShopeeOrderProvider(loadOrderFixtures()),
        product: new FixtureShopeeProductProvider(loadProductFixtures()),
        payment: new FixtureShopeePaymentProvider(loadEscrowFixtures()),
        return: new FixtureShopeeReturnProvider(loadReturnFixtures()),
        income: new FixtureShopeeIncomeProvider({}),
        returnLogistics: new FixtureShopeeReturnLogisticsProvider(loadReturnLogisticsFixtures()),
      };
    }
    const { config: shopeeConfig, service } = getShopee();
    const client = getWorkerClient(shopeeConfig);
    const tokens = new JobTokenCache(service);
    return {
      mode,
      order: new RealShopeeOrderProvider({ client, connections: tokens }),
      product: new RealShopeeProductProvider({ client, connections: tokens }),
      payment: new RealShopeePaymentProvider({ client, connections: tokens }),
      return: new RealShopeeReturnProvider({ client, connections: tokens }),
      income: new RealShopeeIncomeProvider({ client, connections: tokens }),
      returnLogistics: new RealShopeeReturnLogisticsProvider({ client, connections: tokens }),
    };
  };
  const region = process.env.VERCEL_REGION ?? "local";
  const legacyFactory = createShopeeRunnerFactory({ db, config, providers });
  return new SyncWorker({
    db,
    config,
    workerId: `${region}-${randomUUID().slice(0, 8)}`,
    createRunner: (job, budget) => (isAdsSyncType(job.sync_type) ? adsRunnerHandle(job, budget, db) : legacyFactory(job, budget)),
    // SHOPEE-ADS-0: only job types of active domains are claimed (legacy retired = none);
    // SHOPEE-ADS-1B: + the Ads READ jobs, only when SHOPEE_ADS_DATA_SOURCE=real
    syncTypes: [...activeSyncTypes(flags), ...activeAdsSyncTypes(flags)],
    classifyError: toJobFailure,
    region,
    maxRunningAds: limits.maxRunningAds,
    idleWaitMs: limits.idleWaitMs,
  });
}

/**
 * SHOPEE-PERF-2: what one scheduler tick (or the worker endpoint) runs:
 * `bursts` workers side by side (≤ config.globalWorkers — the claim's global
 * cap is the real limit), each a time-bounded burst of slices, then the
 * worker heartbeat. Never throws: callers run it inside after().
 */
export async function runShopeeWorkerBursts(options: { bursts: number; timeBudgetMs: number; source: string }): Promise<BurstReport[]> {
  const config = getSyncConfig();
  const db = createAdminClient();
  const startedAt = Date.now();
  // SHOPEE-9A rate-limit circuit breaker: right after Shopee said "too many", run ONE burst only.
  const rateLimitedRecently = await recentlyRateLimited(db, config.rateLimitCooldownMinutes);
  const limits = workerLimits(rateLimitedRecently);
  const bursts = rateLimitedRecently ? 1 : Math.max(1, Math.min(Math.max(options.bursts, limits.maxRunningAds ?? 1), limits.globalWorkers));
  try {
    await markHeartbeatRun(db, WORKER_HEARTBEAT).catch(() => undefined);
    const reports = await mapWithConcurrency(Array.from({ length: bursts }, (_, i) => i), bursts, () =>
      getShopeeSyncWorker(limits).runBurst({ timeBudgetMs: options.timeBudgetMs }),
    );
    const slices = reports.flatMap((r) => r.slices);
    await markHeartbeatSuccess(db, WORKER_HEARTBEAT, {
      source: options.source,
      region: process.env.VERCEL_REGION ?? "local",
      bursts,
      rateLimitCooldown: rateLimitedRecently,
      durationMs: Date.now() - startedAt,
      lastClaimedJobId: slices.at(-1)?.jobId ?? null,
      lastCompletedJobId: [...slices].reverse().find((s) => s.status === "success" || s.status === "failed")?.jobId ?? null,
      slices: slices.length,
      recovered: reports.reduce((a, r) => a + r.recovered, 0),
      stoppedBy: reports.map((r) => r.stoppedBy),
      jobs: slices.map((s) => `${s.syncType}:${s.status}${s.continuationReason ? `(${s.continuationReason})` : ""}`).slice(0, 20),
    }).catch(() => undefined);
    return reports;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
    console.error(JSON.stringify({ source: "sync-worker", event: "SYNC_WORKER_FAILED", trigger: options.source, message }));
    await markHeartbeatError(db, WORKER_HEARTBEAT, message).catch(() => undefined);
    return [];
  }
}

async function recentlyRateLimited(db: ReturnType<typeof createAdminClient>, cooldownMinutes: number): Promise<boolean> {
  try {
    const row = (await getHeartbeats(db, [RATE_LIMIT_HEARTBEAT])).get(RATE_LIMIT_HEARTBEAT);
    return !!row?.last_error_at && Date.now() - new Date(row.last_error_at).getTime() < cooldownMinutes * 60_000;
  } catch {
    return false;
  }
}

/**
 * One kick of background work: a time-bounded burst in THIS invocation, then
 * — if claimable jobs remain and chaining is enabled — one fire-and-forget
 * call to the worker endpoint so the queue keeps draining on plans without
 * a frequent cron. Never throws (callers run it inside after()).
 */
export async function kickShopeeSyncWorker(options: { origin: string | null; hop?: number } = { origin: null }): Promise<BurstReport | null> {
  const config = getSyncConfig();
  try {
    const report = await getShopeeSyncWorker().runBurst({ timeBudgetMs: Math.min(config.workerTimeBudgetMs, KICK_TIME_BUDGET_MS) });
    const hop = options.hop ?? 0;
    if (options.origin && report.stoppedBy === "time" && hop < config.maxChainHops && (await hasDueSyncJobs(createAdminClient()))) {
      await chainShopeeSyncWorker(options.origin, hop + 1);
    }
    return report;
  } catch (err) {
    console.error(JSON.stringify({ source: "sync-worker", event: "SYNC_KICK_FAILED", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return null;
  }
}

/**
 * Starts the NEXT worker invocation (a new serverless function with its own
 * time limit) — never more work inside the current one. Only the request has
 * to reach the endpoint; we stop waiting after a few seconds.
 */
export async function chainShopeeSyncWorker(origin: string, hop: number): Promise<void> {
  const secret = internalSecret(process.env);
  if (!secret) return;
  const url = new URL("/api/internal/shopee/sync-worker", origin);
  url.searchParams.set("hop", String(hop));
  await fetch(url, { method: "POST", headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(3_000) }).catch(() => undefined);
}

/**
 * One instance per server process so the in-process refresh de-dup and the
 * concurrency cap are shared by every request. Throws ShopeeConfigError
 * (naming variables, never values) when env is incomplete.
 */
export function getShopee() {
  if (cached) return cached;
  const config = getShopeeConfig();
  const client = new ShopeeClient({
    partnerId: config.partnerId,
    partnerKey: config.partnerKey,
    apiBaseUrl: config.apiBaseUrl,
  });
  const service = new ShopeeConnectionService({ db: createAdminClient(), client, encryptionKey: config.encryptionKey });
  cached = { config, client, service };
  return cached;
}
