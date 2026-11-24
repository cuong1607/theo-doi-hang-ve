// ZALO PERSONAL Phase 02 — ingestion endpoint configuration (server only by
// convention, pure so it is unit-testable). Off by default: with the flag off
// the endpoints answer 503 and touch nothing.
//
//   ZALO_PERSONAL_INGEST_ENABLED          master switch (default false)
//   ZALO_PERSONAL_MAX_SKEW_SECONDS        accepted |server time − x-zp-timestamp| (default 300)
//   ZALO_PERSONAL_RATE_LIMIT_PER_MINUTE   signed requests per worker per minute (default 120)
//   ZALO_PERSONAL_MAX_BODY_BYTES          request body limit (default 512 KiB)
// The worker HMAC secrets live encrypted in zalo_personal_workers (APP_ENCRYPTION_KEY).

type Env = Record<string, string | undefined>;

export interface ZaloPersonalIngestConfig {
  enabled: boolean;
  maxSkewMs: number;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function getZaloPersonalIngestConfig(env: Env = process.env): ZaloPersonalIngestConfig {
  return {
    enabled: ["true", "1", "on", "yes"].includes((env.ZALO_PERSONAL_INGEST_ENABLED ?? "").trim().toLowerCase()),
    maxSkewMs: int(env.ZALO_PERSONAL_MAX_SKEW_SECONDS, 300, 30, 900) * 1000,
    rateLimitPerMinute: int(env.ZALO_PERSONAL_RATE_LIMIT_PER_MINUTE, 120, 1, 6000),
    maxBodyBytes: int(env.ZALO_PERSONAL_MAX_BODY_BYTES, 512 * 1024, 4 * 1024, 4 * 1024 * 1024),
  };
}

/** AAD context of a worker secret (must match the provisioning script). */
export function workerSecretContext(workerId: string): string {
  return `zalo_personal_workers:${workerId}:hmac`;
}
