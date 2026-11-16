// ============================================================
// Product Analyst contracts (PRODUCT-ANALYTICS-1 design → PA-4 implementation).
//
//   SQL OWNS TRUTH               metrics come from SQL / RPC, never from the model
//   CLAUDE OWNS INTERPRETATION   the model reads compact tool results, writes AnalystOutput
//   ZALO IS TRANSPORT            the analyst returns content, never calls a channel
//
// Two boundaries:
//   ProductAnalyst          what a channel (Zalo / web) calls: analyze(request).
//                           Implemented by ProductAnalystOrchestrator / DisabledProductAnalyst.
//   ProductAnalystProvider  the model: runs the bounded tool loop and returns the
//                           raw structured answer. ClaudeProductAnalystProvider /
//                           FakeProductAnalystProvider (tests, demos).
//
// Permanent rules (guarded by tests):
//   * no arbitrary SQL / query / mutation tool, no free-form query parameter;
//   * every tool call is authorized by the BACKEND with the trusted
//     { internal_user_id, shop_id, product_id } — never ids from the model;
//   * the model never receives raw rows / snapshots / SQL / PII / tokens;
//   * the output has no actions: analysis never mutates anything.
// Pure: no I/O, no "@/" imports.
// ============================================================
import type { ConversationIntent, ConversationPeriod } from "../conversation/router.ts";

export type AnalystChannel = "zalo" | "web";
export type AnalysisType = "user_question" | "ui_request" | "signal_triggered" | "daily_batch";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type FindingSeverity = "INFO" | "NOTICE" | "WARNING";

export const ANALYST_ERROR_CATEGORIES = [
  "AUTH_DENIED",
  "PRODUCT_NOT_FOUND",
  "AMBIGUOUS_PRODUCT",
  "DATA_UNAVAILABLE",
  "AI_PROVIDER_ERROR",
  "AI_RATE_LIMIT",
  "TOOL_ERROR",
  "OUTPUT_INVALID",
  "TIMEOUT",
  "LIMIT_REACHED",
] as const;
export type AnalystErrorCategory = (typeof ANALYST_ERROR_CATEGORIES)[number];

// ------------------------------------------------------------ request / response

export interface AnalystHistoryTurn {
  role: "user" | "assistant";
  /** plain conversational text only (no tool payloads) */
  text: string;
}

export interface ProductAnalystRequest {
  channel: AnalystChannel;
  conversationId: string | null;
  internalUserId: string;
  shopId: string;
  /** canonical product (shopee_products.id) resolved by the backend; null = shop-level question */
  productId: string | null;
  productQuery: string | null;
  intent: Exclude<ConversationIntent, "HELP" | "UNKNOWN">;
  period: ConversationPeriod | null;
  /** the user's own words (untrusted) */
  question: string;
  /** bounded recent turns of THIS channel thread */
  history: AnalystHistoryTurn[];
  analysisType: AnalysisType;
}

export interface AnalysisMeta {
  cached: boolean;
  model: string;
  promptVersion: string;
  toolTrace: string[];
  durationMs: number;
}

export type ProductAnalystResponse =
  | { kind: "placeholder"; text: string }
  | { kind: "analysis"; output: AnalystOutput; meta: AnalysisMeta }
  | { kind: "error"; category: AnalystErrorCategory; message: string };

export interface ProductAnalyst {
  readonly name: string;
  analyze(request: ProductAnalystRequest): Promise<ProductAnalystResponse>;
}

// ------------------------------------------------------------ output contract (spec §34–41)

export interface AnalystEvidence {
  /** short local id ("e1") referenced by findings / hypotheses */
  id: string;
  /** human-readable fact with its number, e.g. "Doanh số −21% so với kỳ trước" */
  text: string;
}

export interface AnalystFinding {
  title: string;
  description: string;
  severity: FindingSeverity;
  evidence_refs: string[];
}

export interface AnalystHypothesis {
  statement: string;
  confidence: Confidence;
  supporting_evidence: string[];
  counter_evidence: string[];
  missing_data: string[];
}

export interface AnalystOutput {
  /** 1–3 Vietnamese sentences, grounded */
  summary: string;
  /** data-quality caveat that must be read before the analysis (null when none) */
  data_quality_note: string | null;
  findings: AnalystFinding[];
  hypotheses: AnalystHypothesis[];
  evidence: AnalystEvidence[];
  confidence: Confidence;
  missing_data: string[];
  suggested_checks: string[];
  follow_up_context: { topic: string | null };
}

export const ANALYST_OUTPUT_LIMITS = {
  summaryChars: 700,
  textChars: 400,
  findings: 6,
  hypotheses: 4,
  evidence: 12,
  listItems: 6,
} as const;

const CONFIDENCES: readonly string[] = ["HIGH", "MEDIUM", "LOW"];
const SEVERITIES: readonly string[] = ["INFO", "NOTICE", "WARNING"];

const str = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const strArr = (v: unknown, maxItems: number, maxChars: number) => Array.isArray(v) && v.length <= maxItems && v.every((s) => typeof s === "string" && s.length <= maxChars);
function keysOnly(o: Record<string, unknown>, allowed: readonly string[], where: string, errors: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${where}: unexpected key ${k}`);
}

/**
 * Exact contract: unknown keys anywhere are rejected (an "actions" field, a
 * mutation intent …), bounded sizes, every finding cites at least one evidence
 * id that exists, hypotheses carry both supporting and counter / missing sides.
 */
export function validateAnalystOutput(value: unknown): { ok: true; output: AnalystOutput } | { ok: false; errors: string[] } {
  const L = ANALYST_OUTPUT_LIMITS;
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["not an object"] };
  const v = value as Record<string, unknown>;
  keysOnly(v, ["summary", "data_quality_note", "findings", "hypotheses", "evidence", "confidence", "missing_data", "suggested_checks", "follow_up_context"], "output", errors);
  if (!str(v.summary, L.summaryChars)) errors.push("summary required (≤ 700 chars)");
  if (!(v.data_quality_note === null || str(v.data_quality_note, L.textChars))) errors.push("data_quality_note must be null or text");
  if (!CONFIDENCES.includes(String(v.confidence))) errors.push("confidence must be HIGH / MEDIUM / LOW");
  for (const k of ["missing_data", "suggested_checks"]) if (!strArr(v[k], L.listItems, L.textChars)) errors.push(`${k} must be string[] (≤ ${L.listItems})`);

  const ids = new Set<string>();
  if (!Array.isArray(v.evidence) || v.evidence.length > L.evidence) errors.push("evidence must be an array (≤ 12)");
  else
    v.evidence.forEach((e, i) => {
      const x = (e ?? {}) as Record<string, unknown>;
      keysOnly(x, ["id", "text"], `evidence[${i}]`, errors);
      if (!str(x.id, 12)) errors.push(`evidence[${i}].id required`);
      if (!str(x.text, L.textChars)) errors.push(`evidence[${i}].text required`);
      ids.add(String(x.id));
    });

  if (!Array.isArray(v.findings) || v.findings.length > L.findings) errors.push("findings must be an array (≤ 6)");
  else
    v.findings.forEach((f, i) => {
      const x = (f ?? {}) as Record<string, unknown>;
      keysOnly(x, ["title", "description", "severity", "evidence_refs"], `findings[${i}]`, errors);
      if (!str(x.title, 160)) errors.push(`findings[${i}].title required`);
      if (!str(x.description, L.textChars)) errors.push(`findings[${i}].description required`);
      if (!SEVERITIES.includes(String(x.severity))) errors.push(`findings[${i}].severity invalid`);
      if (!strArr(x.evidence_refs, 6, 12) || (x.evidence_refs as string[]).length === 0) errors.push(`findings[${i}] needs evidence_refs`);
      else for (const r of x.evidence_refs as string[]) if (!ids.has(r)) errors.push(`findings[${i}] cites unknown evidence ${r}`);
    });

  if (!Array.isArray(v.hypotheses) || v.hypotheses.length > L.hypotheses) errors.push("hypotheses must be an array (≤ 4)");
  else
    v.hypotheses.forEach((h, i) => {
      const x = (h ?? {}) as Record<string, unknown>;
      keysOnly(x, ["statement", "confidence", "supporting_evidence", "counter_evidence", "missing_data"], `hypotheses[${i}]`, errors);
      if (!str(x.statement, L.textChars)) errors.push(`hypotheses[${i}].statement required`);
      if (!CONFIDENCES.includes(String(x.confidence))) errors.push(`hypotheses[${i}].confidence invalid`);
      for (const k of ["supporting_evidence", "counter_evidence", "missing_data"]) if (!strArr(x[k], L.listItems, L.textChars)) errors.push(`hypotheses[${i}].${k} must be string[]`);
      if (Array.isArray(x.supporting_evidence) && x.supporting_evidence.length === 0) errors.push(`hypotheses[${i}] needs supporting evidence`);
    });

  const f = v.follow_up_context as Record<string, unknown> | undefined;
  if (!f || typeof f !== "object" || Array.isArray(f)) errors.push("follow_up_context required");
  else {
    keysOnly(f, ["topic"], "follow_up_context", errors);
    if (!(f.topic === null || str(f.topic, 120))) errors.push("follow_up_context.topic must be null or short text");
  }
  return errors.length ? { ok: false, errors } : { ok: true, output: v as unknown as AnalystOutput };
}

/** JSON Schema of AnalystOutput for structured outputs (output_config.format). Sizes are re-checked by validateAnalystOutput. */
export const ANALYST_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "data_quality_note", "findings", "hypotheses", "evidence", "confidence", "missing_data", "suggested_checks", "follow_up_context"],
  properties: {
    summary: { type: "string" },
    data_quality_note: { anyOf: [{ type: "string" }, { type: "null" }] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "severity", "evidence_refs"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          severity: { type: "string", enum: ["INFO", "NOTICE", "WARNING"] },
          evidence_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "confidence", "supporting_evidence", "counter_evidence", "missing_data"],
        properties: {
          statement: { type: "string" },
          confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
          supporting_evidence: { type: "array", items: { type: "string" } },
          counter_evidence: { type: "array", items: { type: "string" } },
          missing_data: { type: "array", items: { type: "string" } },
        },
      },
    },
    evidence: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["id", "text"], properties: { id: { type: "string" }, text: { type: "string" } } },
    },
    confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
    missing_data: { type: "array", items: { type: "string" } },
    suggested_checks: { type: "array", items: { type: "string" } },
    follow_up_context: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: { topic: { anyOf: [{ type: "string" }, { type: "null" }] } },
    },
  },
} as const;

// ------------------------------------------------------------ tools

/** Names / params that must never appear in agent tooling (static guard). */
export const FORBIDDEN_TOOL_PATTERNS: readonly RegExp[] = [/sql/i, /raw_?query/i, /execute/i, /\bquery\b/i, /mutat/i, /update/i, /delete/i, /insert/i, /\bset_/i, /budget/i, /bid/i, /http/i, /shell/i];

// ------------------------------------------------------------ cache / run policy

/**
 * Cache key of one analysis: product + period + data version (freshness of the
 * underlying facts) + prompt version + model family + the normalized question
 * (different questions about one product are different analyses). Shop is in
 * the key because identity = shop + product; the USER is not — access is
 * re-checked before any cached answer is returned.
 */
export function analysisCacheKey(input: { shopId: string; productId: string | null; period: string | null; dataVersion: string; promptVersion: string; modelFamily: string; questionHash: string }): string {
  return ["pa", input.promptVersion, input.modelFamily, input.shopId, input.productId ?? "-", input.period ?? "-", input.dataVersion, input.questionHash].join(":");
}

/** Automatic runs are never "all products every N minutes" (spec §67). */
export const ANALYSIS_RUN_POLICY = {
  allowedTriggers: ["user_question", "ui_request", "signal_triggered", "daily_batch"] as const satisfies readonly AnalysisType[],
  /** PA-4 only answers people; proactive triggers are PA-5. */
  enabledTriggers: ["user_question", "ui_request"] as const satisfies readonly AnalysisType[],
  maxProductsPerDailyBatch: 20,
  scheduledFullCatalogueRuns: false,
} as const;
