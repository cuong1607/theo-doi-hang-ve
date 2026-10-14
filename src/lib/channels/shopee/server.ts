// ============================================================
// PHASE SHOPEE-1: server wiring for the Shopee module (env config +
// service-role DB + real fetch). The ONLY entry point routes/pages use.
//
// Callers must authorize first (src/lib/auth/session.ts, channel:manage) —
// the service-role client bypasses RLS.
// ============================================================
import "server-only";

import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

import { getSyncConfig } from "../core/sync-config.ts";
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
import { getShopeeProviderMode } from "./provider-mode.ts";

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
export function getShopeeSyncWorker(): SyncWorker {
  const config = getSyncConfig();
  const db = createAdminClient();
  const providers: ShopeeProviderSource = () => {
    const { mode, problem } = getShopeeProviderMode();
    if (problem) throw new ShopeeConfigError([problem]);
    if (mode === "fixture") {
      return {
        mode,
        order: new FixtureShopeeOrderProvider(loadOrderFixtures()),
        product: new FixtureShopeeProductProvider(loadProductFixtures()),
        payment: new FixtureShopeePaymentProvider(loadEscrowFixtures()),
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
    };
  };
  return new SyncWorker({
    db,
    config,
    workerId: `${process.env.VERCEL_REGION ?? "local"}-${randomUUID().slice(0, 8)}`,
    createRunner: createShopeeRunnerFactory({ db, config, providers }),
    classifyError: toJobFailure,
  });
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
  const secret = process.env.SYNC_WORKER_SECRET || process.env.CRON_SECRET;
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
