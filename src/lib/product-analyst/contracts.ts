// ============================================================
// SHOPEE-PRODUCT-ANALYTICS-1 (part C/D): contracts for the FUTURE Claude
// Product Analyst. Interfaces + pure helpers only — no model call exists.
//
//   SQL OWNS TRUTH          metrics come from SQL / RPC, never from the model
//   CLAUDE OWNS INTERPRETATION   the model reads structured metrics + signals
//   ZALO IS TRANSPORT       the agent returns generic content, never calls Zalo
//
// Permanent rules (guarded by src/lib/conversation/conversation.test.ts):
//   * no arbitrary SQL tool (execute_sql / raw_query / run_sql …), no tool
//     parameter that accepts SQL or free-form queries;
//   * every tool request carries internal_user_id + shop_id and is
//     authorized by the BACKEND before any query — the model is not an
//     authorization layer;
//   * the model never receives raw rows / snapshots / SQL dumps: only the
//     aggregated shapes below;
//   * output has no actions field: analysis never mutates anything.
// ============================================================
import type { ConversationIntent, ConversationPeriod } from "../conversation/router.ts";

// ------------------------------------------------------------ provider
export interface ProductAnalystRequest {
  conversationId: string;
  internalUserId: string;
  shopId: string;
  /** Resolved internal product (future). Phase 1: always null — only the user's phrase is known. */
  productId: string | null;
  productQuery: string | null;
  intent: Exclude<ConversationIntent, "HELP" | "UNKNOWN">;
  period: ConversationPeriod | null;
}

export type ProductAnalystResponse =
  | { kind: "placeholder"; text: string }
  | { kind: "analysis"; output: AnalystOutput; usage?: AiUsageRecord };

export interface ProductAnalystProvider {
  readonly name: string;
  analyze(request: ProductAnalystRequest): Promise<ProductAnalystResponse>;
}

// ------------------------------------------------------------ tools (future)
export interface AnalystToolScope {
  internal_user_id: string;
  shop_id: string;
  product_id: string | null;
}

export interface AnalystToolDefinition {
  name: string;
  description: string;
  /** Parameter names beyond the scope (all typed, none free-form SQL). */
  params: readonly string[];
  /** What the backend returns: aggregated JSON computed in SQL. */
  returns: string;
}

/**
 * PRODUCT-ANALYTICS-2: get_product_overview, compare_product_periods,
 * get_product_sales_summary, get_product_ads_performance and
 * get_product_baseline have READ-ONLY backend implementations in
 * src/lib/product-analytics/agent-tools.ts. NONE is exposed to a model yet.
 */
export const ANALYST_TOOL_DEFINITIONS: readonly AnalystToolDefinition[] = [
  { name: "get_product_sales_summary", description: "Sales GMV / orders / units (order facts) of one product, current vs previous period", params: ["period"], returns: "sales deltas + semantics + DataQuality" },
  { name: "get_product_overview", description: "Sales, traffic counters, stock and Ads summary of one product for a period", params: ["period"], returns: "ProductMetricSet + DataQuality" },
  { name: "compare_product_periods", description: "Same metrics for two periods with absolute / % deltas", params: ["period", "compare_to"], returns: "PeriodComparison[] + DataQuality" },
  { name: "get_product_sales_funnel", description: "Funnel stages that are API-verified (see capability matrix)", params: ["period"], returns: "funnel stages + DataQuality" },
  { name: "get_product_ads_performance", description: "Ads spend / impressions / clicks / direct + broad orders & GMV of the product's campaigns", params: ["period"], returns: "ads metrics + DataQuality" },
  { name: "get_product_intraday", description: "Hourly Ads curve of today vs baseline (hourly sales need a verified source)", params: ["date"], returns: "hourly series + DataQuality" },
  { name: "get_product_baseline", description: "Rolling baseline (median / p25 / p75) of the product's daily metrics", params: ["days"], returns: "baseline + DataQuality" },
  { name: "get_shop_baseline", description: "Shop-level baseline for normalising one product", params: ["days"], returns: "baseline + DataQuality" },
  { name: "get_product_cost_margin", description: "COGS, estimated margin and stock cover from the internal cost engine", params: ["period"], returns: "margin metrics + DataQuality" },
];

/** Names / params that must never appear in agent tooling (static guard). */
export const FORBIDDEN_TOOL_PATTERNS: readonly RegExp[] = [/sql/i, /raw_?query/i, /execute/i, /\bquery\b/i, /mutat/i, /update/i, /delete/i, /insert/i];

// ------------------------------------------------------------ inputs the model may see
export type DataCompleteness = "complete" | "partial" | "missing";

export interface DataQuality {
  completeness: DataCompleteness;
  /** ISO time of the freshest underlying fact per source. */
  freshness: Record<string, string | null>;
  missingSources: string[];
  notes: string[];
}

export interface MetricValue {
  metric: string;
  value: number | null;
  unit: "VND" | "count" | "ratio" | "percent";
  /** Where SQL got it from (e.g. "internal_orders", "ads_campaign_daily", "item_extra_info"). */
  source: string;
}

export interface PeriodComparison {
  metric: string;
  current: number | null;
  previous: number | null;
  deltaAbs: number | null;
  deltaPct: number | null;
}

export type SignalCode =
  | "SALES_DOWN" | "SALES_UP" | "TRAFFIC_DOWN" | "TRAFFIC_STABLE" | "TRAFFIC_UP" | "CVR_DOWN" | "CVR_UP"
  | "ADS_SPEND_UP" | "ADS_SPEND_DOWN" | "ADS_ROAS_DOWN" | "ADS_ROAS_UP" | "STOCK_LOW" | "DATA_INCOMPLETE";

/** Computed WITHOUT AI by a future rule layer; the model only reads them. */
export interface Signal {
  code: SignalCode;
  metric: string;
  evidence: PeriodComparison;
}

/** The ONLY payload shape a future model call may receive. */
export interface AnalystContext {
  request: Pick<ProductAnalystRequest, "intent" | "period" | "productQuery">;
  metrics: MetricValue[];
  comparisons: PeriodComparison[];
  signals: Signal[];
  dataQuality: DataQuality;
  metadata: { shopName: string; productName: string | null; timezone: string; currency: "VND" };
}

// ------------------------------------------------------------ output contract
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface AnalystFinding {
  title: string;
  /** Metric evidence, e.g. "visitors −2%", "CVR 3.8% → 3.1%". Required for every finding. */
  evidence: string[];
  confidence: Confidence;
}

export interface AnalystOutput {
  summary: string;
  findings: AnalystFinding[];
  /** Possible causes — correlation, never stated as certain cause. */
  hypotheses: Array<{ text: string; confidence: Confidence }>;
  evidence: string[];
  confidence: Confidence;
  missing_data: string[];
  suggested_checks: string[];
}

const CONFIDENCES: readonly string[] = ["HIGH", "MEDIUM", "LOW"];
const OUTPUT_KEYS = new Set(["summary", "findings", "hypotheses", "evidence", "confidence", "missing_data", "suggested_checks"]);

/** Rejects anything outside the contract: extra keys (e.g. "actions"), findings without evidence, unknown confidence. */
export function validateAnalystOutput(value: unknown): { ok: true; output: AnalystOutput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["not an object"] };
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!OUTPUT_KEYS.has(k)) errors.push(`unexpected key: ${k}`);
  if (typeof v.summary !== "string" || !v.summary.trim()) errors.push("summary required");
  if (!CONFIDENCES.includes(String(v.confidence))) errors.push("confidence must be HIGH / MEDIUM / LOW");
  const strArr = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
  for (const k of ["evidence", "missing_data", "suggested_checks"]) if (!strArr(v[k])) errors.push(`${k} must be string[]`);
  if (!Array.isArray(v.findings)) errors.push("findings must be an array");
  else
    v.findings.forEach((f, i) => {
      const x = (f ?? {}) as Record<string, unknown>;
      if (typeof x.title !== "string" || !x.title) errors.push(`findings[${i}].title required`);
      if (!strArr(x.evidence) || (x.evidence as string[]).length === 0) errors.push(`findings[${i}] needs metric evidence`);
      if (!CONFIDENCES.includes(String(x.confidence))) errors.push(`findings[${i}].confidence invalid`);
    });
  if (!Array.isArray(v.hypotheses)) errors.push("hypotheses must be an array");
  else v.hypotheses.forEach((h, i) => { if (!CONFIDENCES.includes(String((h as Record<string, unknown>)?.confidence))) errors.push(`hypotheses[${i}].confidence invalid`); });
  return errors.length ? { ok: false, errors } : { ok: true, output: v as unknown as AnalystOutput };
}

// ------------------------------------------------------------ cost / cache (design)
export type AnalysisType = "user_question" | "signal_triggered" | "daily_batch";

/** Future ai_usage_logs row (not created in this phase). */
export interface AiUsageRecord {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  estimatedCostUsd: number | null;
  durationMs: number;
  conversationId: string | null;
  analysisType: AnalysisType;
}

/**
 * Cache key of one analysis: same product + period + data version (hash of
 * the SQL-computed inputs) + analysis version (prompt / contract revision)
 * → reuse instead of regenerating.
 */
export function analysisCacheKey(input: { shopId: string; productId: string | null; intent: string; period: string | null; dataVersion: string; analysisVersion: string }): string {
  return ["pa", input.analysisVersion, input.shopId, input.productId ?? "-", input.intent, input.period ?? "-", input.dataVersion].join(":");
}

/** Automatic runs are never "all products every N minutes" (spec §57). */
export const ANALYSIS_RUN_POLICY = {
  allowedTriggers: ["user_question", "signal_triggered", "daily_batch"] as const satisfies readonly AnalysisType[],
  maxProductsPerDailyBatch: 20,
  scheduledFullCatalogueRuns: false,
} as const;
