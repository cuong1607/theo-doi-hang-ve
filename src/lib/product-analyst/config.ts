// ============================================================
// PRODUCT-ANALYTICS-4: the ONE place for Product Analyst configuration —
// feature flags, provider + model, limits and the price table.
// Pure (no "@/" imports, no I/O): unit-testable, readable from server code.
//
//   AI_PRODUCT_ANALYST_ENABLED       master switch (default OFF) — the provider
//   AI_PRODUCT_ANALYST_ZALO_ENABLED  Zalo answers with the analyst (default OFF)
//   AI_PRODUCT_ANALYST_WEB_ENABLED   /apps/shopee/ai (default OFF)
//   Enabling the provider never enables a channel by itself (and a channel flag
//   without the master switch does nothing).
//
// Secrets: ANTHROPIC_API_KEY is read by the SDK on the server only — never a
// NEXT_PUBLIC_* variable, never logged.
// ============================================================

type Env = Record<string, string | undefined>;

const on = (raw: string | undefined) => ["true", "1", "on", "yes"].includes((raw ?? "").trim().toLowerCase());
function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseFloat((raw ?? "").trim());
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Default model: Sonnet-class (spec §6) — the only place a model id is written. */
export const PRODUCT_ANALYST_DEFAULT_MODEL = "claude-sonnet-5-5";

export type ProductAnalystProviderName = "anthropic" | "fake";
export type AnalystEffort = "low" | "medium" | "high";

export interface ProductAnalystLimits {
  /** tool executions per request (spec §31) */
  maxToolCalls: number;
  /** model round trips per request */
  maxModelTurns: number;
  /** whole analysis, server-side */
  timeoutMs: number;
  /** per request to the model */
  maxOutputTokens: number;
  /** one tool result, serialized (spec §32) */
  maxToolResultBytes: number;
  maxDailyCallsPerUser: number;
  maxCallsPerMinutePerUser: number;
  maxConcurrentPerUser: number;
  /** all users, today (VN), estimated */
  maxDailyCostUsd: number;
  /** prior turns sent to the model (spec §82) */
  historyTurns: number;
}

export interface ProductAnalystConfig {
  enabled: boolean;
  zaloEnabled: boolean;
  webEnabled: boolean;
  provider: ProductAnalystProviderName;
  model: string;
  effort: AnalystEffort;
  /** Optional allowlist of internal user ids (empty = every user the role rules allow). */
  allowedUserIds: readonly string[];
  limits: ProductAnalystLimits;
  /** Analyst responses are cached when true (authorization is checked before every read). */
  cacheEnabled: boolean;
  /** AI_PRODUCT_ANALYST_FALLBACKS=false turns off server-side refusal fallback. */
  fallbacks: boolean;
}

export function getProductAnalystConfig(env: Env = process.env): ProductAnalystConfig {
  const enabled = on(env.AI_PRODUCT_ANALYST_ENABLED);
  const provider: ProductAnalystProviderName = env.AI_PRODUCT_ANALYST_PROVIDER?.trim().toLowerCase() === "fake" ? "fake" : "anthropic";
  const effort = (["low", "medium", "high"] as const).find((e) => e === env.AI_PRODUCT_ANALYST_EFFORT?.trim().toLowerCase()) ?? "medium";
  return {
    enabled,
    // a channel flag only counts when the master switch is on
    zaloEnabled: enabled && on(env.AI_PRODUCT_ANALYST_ZALO_ENABLED),
    webEnabled: enabled && on(env.AI_PRODUCT_ANALYST_WEB_ENABLED),
    provider,
    model: env.AI_PRODUCT_ANALYST_MODEL?.trim() || PRODUCT_ANALYST_DEFAULT_MODEL,
    effort,
    allowedUserIds: (env.AI_PRODUCT_ANALYST_ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    limits: {
      maxToolCalls: int(env.AI_PRODUCT_ANALYST_MAX_TOOL_CALLS, 8, 1, 16),
      maxModelTurns: int(env.AI_PRODUCT_ANALYST_MAX_MODEL_TURNS, 6, 2, 10),
      timeoutMs: int(env.AI_PRODUCT_ANALYST_TIMEOUT_MS, 75_000, 10_000, 240_000),
      maxOutputTokens: int(env.AI_PRODUCT_ANALYST_MAX_OUTPUT_TOKENS, 8_000, 1_000, 32_000),
      maxToolResultBytes: 6_144,
      maxDailyCallsPerUser: int(env.AI_PRODUCT_ANALYST_MAX_DAILY_CALLS_PER_USER, 60, 1, 10_000),
      maxCallsPerMinutePerUser: int(env.AI_PRODUCT_ANALYST_MAX_CALLS_PER_MINUTE, 4, 1, 60),
      maxConcurrentPerUser: 1,
      maxDailyCostUsd: num(env.AI_PRODUCT_ANALYST_MAX_DAILY_COST_USD, 5, 0, 1_000),
      historyTurns: int(env.AI_PRODUCT_ANALYST_HISTORY_TURNS, 8, 0, 12),
    },
    cacheEnabled: env.AI_PRODUCT_ANALYST_CACHE?.trim().toLowerCase() !== "off",
    fallbacks: env.AI_PRODUCT_ANALYST_FALLBACKS?.trim().toLowerCase() !== "false",
  };
}

/** Model family for the cache key: a model change invalidates cached answers. */
export function modelFamily(model: string): string {
  return model.replace(/[^a-z0-9.-]/gi, "").slice(0, 40) || "unknown";
}

// ------------------------------------------------------------------ pricing (USD per 1M tokens)

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write */
  cacheWrite: number;
}

/**
 * Anthropic list prices (first-party API). Updating a price never needs a
 * migration: edit here, or override with AI_PRODUCT_ANALYST_PRICING_JSON
 * ({"<model>": {"input":…, "output":…, "cacheRead":…, "cacheWrite":…}}).
 * Unknown model → cost NULL (never guessed).
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function modelPrice(model: string, env: Env = process.env): ModelPrice | null {
  const raw = env.AI_PRODUCT_ANALYST_PRICING_JSON?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
      const p = parsed[model];
      if (p && [p.input, p.output].every((v) => typeof v === "number" && v >= 0)) {
        return { input: p.input!, output: p.output!, cacheRead: p.cacheRead ?? p.input! * 0.1, cacheWrite: p.cacheWrite ?? p.input! * 1.25 };
      }
    } catch {
      // malformed override → fall back to the table below
    }
  }
  return MODEL_PRICES[model] ?? null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Estimated USD from the provider's REPORTED token counts; null when the price is unknown. */
export function estimateCostUsd(model: string, u: TokenUsage, env: Env = process.env): number | null {
  const p = modelPrice(model, env);
  if (!p) return null;
  const usd = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Models where server-side refusal fallback ("default") is accepted on the Claude API. */
export const FALLBACK_CAPABLE_MODELS: readonly string[] = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1"];
