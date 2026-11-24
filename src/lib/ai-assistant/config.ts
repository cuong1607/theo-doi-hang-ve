// ============================================================
// AI ASSISTANT (Phase 04) — the ONE place for the shared AI engine's
// configuration. Pure (no I/O, no "@/" imports): unit-testable.
//
//   AI_ENABLED                         engine kill switch (default OFF). Off → no
//                                      provider call anywhere in this engine.
//   ZALO_PERSONAL_AI_ENABLED           Ask AI / summaries in the Zalo Personal
//                                      dashboard (default OFF; needs AI_ENABLED)
//   AI_PROVIDER                        gemini (default) | fake — fake = deterministic,
//                                      local demo / tests only, refused when NODE_ENV=production
//   GEMINI_API_KEY                     server only — never NEXT_PUBLIC_*, never logged
//   GEMINI_MODEL                       REQUIRED (no default: models / quotas change)
//   GEMINI_BASE_URL                    tests only: a LOCAL mock endpoint (http://localhost…);
//                                      any other host is ignored (data can't be redirected)
//   GEMINI_TIER                        free (default) | paid — declared by the owner
//   AI_DATA_SHARING_POLICY             none (default) | redacted | full
//   AI_FREE_TIER_DATA_APPROVED         true = owner approved sending real chats on
//                                      the free tier (Google may use free-tier data)
//   AI_MAX_REQUESTS_PER_DAY            all users, VN day (default 50)
//   AI_MAX_REQUESTS_PER_USER_PER_DAY   default 20
//   AI_MAX_REQUESTS_PER_MINUTE         per model, all users (default 5)
//   AI_MAX_INPUT_TOKENS / AI_MAX_OUTPUT_TOKENS   per request (defaults 12000 / 1500)
//   AI_REQUEST_TIMEOUT_MS              per provider call (default 30000)
//   AI_SESSION_RETENTION_DAYS          Ask AI history kept (default 30)
//
// Independent from the Product Analyst (AI_PRODUCT_ANALYST_*, Claude): this
// file never reads or changes those, so Web / OA behaviour is unchanged.
// ============================================================

type Env = Record<string, string | undefined>;

const on = (raw: string | undefined) => ["true", "1", "on", "yes"].includes((raw ?? "").trim().toLowerCase());
function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export type DataSharingPolicy = "none" | "redacted" | "full";
export type GeminiTier = "free" | "paid";

export interface AiLimits {
  maxRequestsPerDay: number;
  maxRequestsPerUserPerDay: number;
  maxRequestsPerMinute: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Ask / summarize API calls per user per minute (including answers that never reach the model) */
  maxApiCallsPerUserPerMinute: number;
  /** after the provider reports quota exhausted, no call for this long */
  quotaCooldownMinutes: number;
  /** transient failures (network / 5xx) only; 429 / quota / auth are never retried */
  maxRetries: number;
}

export interface AiConfig {
  enabled: boolean;
  zaloPersonalEnabled: boolean;
  provider: "gemini" | "fake";
  apiKeyConfigured: boolean;
  /** null = not configured (calls refused with config_missing) */
  model: string | null;
  modelValid: boolean;
  /** localhost mock endpoint for tests; null in any real deployment */
  geminiBaseUrl: string | null;
  tier: GeminiTier;
  dataSharing: DataSharingPolicy;
  freeTierDataApproved: boolean;
  limits: AiLimits;
  sessionRetentionDays: number;
}

/** Gemini model ids look like "gemini-<version>-<variant>[-<date>]". Anything else is refused. */
export const GEMINI_MODEL_PATTERN = /^gemini-[a-z0-9][a-z0-9.-]{1,62}$/;

export function getAiConfig(env: Env = process.env): AiConfig {
  const enabled = on(env.AI_ENABLED);
  const model = env.GEMINI_MODEL?.trim() || null;
  const policy = env.AI_DATA_SHARING_POLICY?.trim().toLowerCase();
  return {
    enabled,
    zaloPersonalEnabled: enabled && on(env.ZALO_PERSONAL_AI_ENABLED),
    provider: env.AI_PROVIDER?.trim().toLowerCase() === "fake" && env.NODE_ENV !== "production" ? "fake" : "gemini",
    apiKeyConfigured: Boolean(env.GEMINI_API_KEY?.trim()),
    model,
    modelValid: model !== null && GEMINI_MODEL_PATTERN.test(model),
    geminiBaseUrl: localOnly(env.GEMINI_BASE_URL),
    tier: env.GEMINI_TIER?.trim().toLowerCase() === "paid" ? "paid" : "free",
    dataSharing: policy === "redacted" || policy === "full" ? policy : "none",
    freeTierDataApproved: on(env.AI_FREE_TIER_DATA_APPROVED),
    limits: {
      maxRequestsPerDay: int(env.AI_MAX_REQUESTS_PER_DAY, 50, 0, 100_000),
      maxRequestsPerUserPerDay: int(env.AI_MAX_REQUESTS_PER_USER_PER_DAY, 20, 0, 10_000),
      maxRequestsPerMinute: int(env.AI_MAX_REQUESTS_PER_MINUTE, 5, 1, 1_000),
      maxInputTokens: int(env.AI_MAX_INPUT_TOKENS, 12_000, 1_000, 200_000),
      maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 1_500, 256, 16_000),
      timeoutMs: int(env.AI_REQUEST_TIMEOUT_MS, 30_000, 5_000, 120_000),
      maxApiCallsPerUserPerMinute: int(env.AI_MAX_API_CALLS_PER_USER_PER_MINUTE, 6, 1, 120),
      quotaCooldownMinutes: int(env.AI_QUOTA_COOLDOWN_MINUTES, 30, 1, 1_440),
      maxRetries: int(env.AI_MAX_RETRIES, 1, 0, 2),
    },
    sessionRetentionDays: int(env.AI_SESSION_RETENTION_DAYS, 30, 1, 365),
  };
}

/** Accepts only http(s)://localhost or 127.0.0.1 — a test endpoint can never be a remote host. */
export function localOnly(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1") ? u.origin : null;
  } catch {
    return null;
  }
}

export type AiUnavailableReason = "ai_disabled" | "feature_disabled" | "config_missing" | "model_invalid";

/** Whether the engine may call the provider at all (data policy is checked separately). */
export function providerReadiness(c: AiConfig): { ready: true } | { ready: false; reason: AiUnavailableReason } {
  if (!c.enabled) return { ready: false, reason: "ai_disabled" };
  if (!c.zaloPersonalEnabled) return { ready: false, reason: "feature_disabled" };
  if (c.provider === "fake") return { ready: true };
  if (!c.apiKeyConfigured || c.model === null) return { ready: false, reason: "config_missing" };
  if (!c.modelValid) return { ready: false, reason: "model_invalid" };
  return { ready: true };
}

/** Prompt / schema version: part of every cache key and stored with every summary. */
export const AI_PROMPT_VERSION = "zp-ai-1";
