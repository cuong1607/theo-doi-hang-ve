// ============================================================
// Phase 02 assembly: secret + outbox + signed client + delivery + heartbeat.
// main.ts only plugs the returned hooks into the Phase 01 pipeline.
// ============================================================
import type { WorkerConfig } from "../config.ts";
import { dataPaths } from "../config.ts";
import type { ConnectionState, ErrorReason } from "../connection-state.ts";
import type { HealthMonitor } from "../health-monitor.ts";
import type { Logger } from "../logger.ts";
import type { SessionProtector } from "../session-protector.ts";
import { DeliveryService, type AuthGate } from "./delivery.ts";
import { HeartbeatReporter } from "./heartbeat.ts";
import { SignedClient, type FetchLike } from "./http-client.ts";
import { Outbox } from "./outbox.ts";
import { OutboxSink } from "./outbox-sink.ts";
import { loadIngestSecret, loadOrCreateOutboxKey } from "./secret-store.ts";
import { secretKeyBytes } from "./signing.ts";

export const WORKER_VERSION = "0.2.0";

export class IngestSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestSetupError";
  }
}

export interface IngestRuntime {
  sink: OutboxSink;
  outbox: Outbox;
  delivery: DeliveryService;
  heartbeat: HeartbeatReporter;
  auth: AuthGate;
  /** signed POST to the backend (Phase 04.5 outbound reuses the same client + secret) */
  post(path: string, payload: unknown, signal?: AbortSignal): Promise<import("./http-client.ts").HttpResult>;
  accountId(): string | null;
  onAccount(accountId: string | null): void;
  onStateChange(state: ConnectionState): void;
  publishHealth(): void;
  shutdown(): Promise<void>;
}

export async function startIngestion(deps: {
  config: WorkerConfig;
  logger: Logger;
  health: HealthMonitor;
  protector: SessionProtector;
  connectionState: () => { state: ConnectionState; errorReason: ErrorReason | null };
  fetchImpl?: FetchLike;
}): Promise<IngestRuntime> {
  const { config, logger, health } = deps;
  const ic = config.ingest;
  if (!ic.baseUrl || !ic.workerKey) throw new IngestSetupError("Thiếu ZP_INGEST_URL / ZP_WORKER_KEY.");
  const paths = dataPaths(config.dataDir);

  const secret = await loadIngestSecret(paths.ingestSecretFile, deps.protector, ic.secretFromEnv);
  if (!secret) throw new IngestSetupError("Chưa có ingest secret. Chạy `npm run ingest:set-secret` và dán secret do quản trị viên cấp.");
  const outboxKey = await loadOrCreateOutboxKey(paths.outboxKeyFile, deps.protector);
  const outbox = new Outbox({ dir: paths.outboxDir, key: outboxKey, maxEvents: ic.outboxMaxEvents, maxBytes: ic.outboxMaxBytes });
  await outbox.init();

  const client = new SignedClient({ baseUrl: ic.baseUrl, workerKey: ic.workerKey, secretKey: secretKeyBytes(secret), timeoutMs: ic.timeoutMs, fetchImpl: deps.fetchImpl });
  const auth: AuthGate = { failed: false, reason: null };
  let accountId: string | null = null;
  let everAuthenticated = false;

  const delivery = new DeliveryService({
    outbox,
    post: (path, payload, signal) => client.post(path, payload, signal),
    connectionKey: config.connectionId,
    accountId: () => accountId,
    auth,
    logger,
    batchSize: ic.batchSize,
    maxAttempts: ic.maxAttempts,
    backoff: ic.backoff,
    pollMs: ic.pollMs,
  });
  const heartbeat = new HeartbeatReporter({
    post: (path, payload) => client.post(path, payload),
    connectionKey: config.connectionId,
    workerVersion: WORKER_VERSION,
    intervalMs: ic.heartbeatMs,
    source: { state: deps.connectionState, accountId: () => accountId, everAuthenticated: () => everAuthenticated, lastMessageReceivedAt: () => health.current.lastEventAt },
    outbox,
    delivery,
    auth,
    logger,
  });

  const publishHealth = () => {
    const s = outbox.stats();
    const d = delivery.stats;
    health.setIngest({ outboxDepth: s.depth, deadLetters: s.dead, outboxFullDrops: s.fullDrops, lastDeliveryOkAt: d.lastDeliveryOkAt ? new Date(d.lastDeliveryOkAt).toISOString() : null, consecutiveFailures: d.consecutiveFailures, authPaused: auth.failed, lastErrorCategory: auth.failed ? "auth_failed" : d.lastErrorCategory });
  };

  delivery.start();
  heartbeat.start();
  const healthTimer = setInterval(publishHealth, 5_000);
  healthTimer.unref();
  logger.info("ingest_started", { outboxDepth: outbox.stats().depth, deadLetters: outbox.stats().dead, workerVersion: WORKER_VERSION });

  return {
    sink: new OutboxSink({ outbox, connectionId: config.connectionId, directMessages: config.directMessages, logger }),
    outbox,
    delivery,
    heartbeat,
    auth,
    post: (path, payload, signal) => client.post(path, payload, signal),
    accountId: () => accountId,
    onAccount(id) {
      if (id) {
        accountId = id; // kept after a disconnect so heartbeats keep identifying the account
        everAuthenticated = true;
      }
    },
    onStateChange() {
      void heartbeat.send();
    },
    publishHealth,
    async shutdown() {
      clearInterval(healthTimer);
      heartbeat.stop();
      await delivery.stop(); // waits for the in-flight request; outbox writes are atomic
      // final best-effort heartbeat (listener now inactive), bounded
      await Promise.race([heartbeat.send(), new Promise((r) => setTimeout(r, 3_000).unref())]);
      publishHealth();
    },
  };
}
