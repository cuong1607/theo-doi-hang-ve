// ============================================================
// PRODUCT-ANALYTICS-4: ProductAnalystOrchestrator — the service boundary every
// channel (Zalo, web) calls. The webhook / page holds no analysis logic.
//
//   1. authorize (user active + role + Shopee app + shop grant + product ∈ shop)
//   2. limits (concurrent / per minute / per day per user, daily cost overall)
//   3. cache (checked AFTER authorization; key = product + period + data
//      version + prompt version + model family + question)
//   4. provider.run(): bounded tool loop; each tool call re-authorizes
//   5. check: schema → policy guards → numeric grounding (one repair turn)
//   6. usage log (tokens, cost, tool trace, latency) + observability log
// Every failure becomes a categorized, user-safe message (no stack, no API error).
// Injected deps (DB client, store, provider, clock): no "@/" imports.
// ============================================================
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { foldVietnamese, PERIOD_LABELS } from "../conversation/router.ts";
import { authorizeProductTool, authorizeShopTool, ProductToolAccessError } from "../product-analytics/agent-tools.ts";
import { analysisCacheKey, validateAnalystOutput, type AnalystErrorCategory, type AnalystOutput, type ProductAnalyst, type ProductAnalystRequest, type ProductAnalystResponse } from "./contracts.ts";
import { estimateCostUsd, modelFamily, type ProductAnalystConfig, type TokenUsage } from "./config.ts";
import { dataViolations, POLICY_FEEDBACK, policyViolations, ungroundedNumbers } from "./guard.ts";
import { buildContextBlock, buildQuestionBlock, PRODUCT_ANALYST_PROMPT_VERSION, PRODUCT_ANALYST_SYSTEM_PROMPT } from "./prompt.ts";
import { AnalystProviderError, type AnalystRunResult, type ProductAnalystProvider } from "./provider.ts";
import { ANALYST_TOOLS, conversationPeriodToToolInput, executeAnalystTool } from "./tools.ts";

// ------------------------------------------------------------------ store

export interface UsageRunStart {
  provider: string;
  model: string;
  promptVersion: string;
  channel: "zalo" | "web" | "script";
  conversationId: string | null;
  internalUserId: string;
  shopId: string | null;
  productId: string | null;
  analysisType: ProductAnalystRequest["analysisType"];
  status: "running" | "cache_hit" | "rejected";
  errorCategory?: AnalystErrorCategory | null;
  cacheKey?: string | null;
  toolTrace?: string[];
}

export interface UsageRunFinish {
  status: "completed" | "failed";
  errorCategory: AnalystErrorCategory | null;
  usage: TokenUsage;
  estimatedCost: number | null;
  toolCalls: number;
  toolTrace: string[];
  modelTurns: number;
  durationMs: number;
  modelMs: number;
  toolMs: number;
}

export interface ProductIdentity {
  id: string;
  shopId: string;
  itemId: string;
  name: string | null;
  sku: string | null;
}

export interface AnalystStore {
  startRun(row: UsageRunStart): Promise<string>;
  finishRun(id: string, patch: UsageRunFinish): Promise<void>;
  /** model runs (running / completed / failed) of a user since the instant */
  countRuns(internalUserId: string, sinceIso: string): Promise<number>;
  countRunning(internalUserId: string, sinceIso: string): Promise<number>;
  costSince(sinceIso: string): Promise<number>;
  cacheGet(key: string, now: Date): Promise<{ output: AnalystOutput; toolTrace: string[] } | null>;
  cachePut(row: { key: string; shopId: string; productId: string | null; promptVersion: string; model: string; dataVersion: string; output: AnalystOutput; toolTrace: string[]; expiresAt: Date }): Promise<void>;
  shopName(shopId: string): Promise<string | null>;
  product(productId: string): Promise<ProductIdentity | null>;
  /** freshness of the facts behind an answer (sales last success + Ads today) */
  dataVersion(shopId: string): Promise<string>;
}

// ------------------------------------------------------------------ user-facing copy (spec §61, §86)

export const ANALYST_ERROR_MESSAGES: Record<AnalystErrorCategory, string> = {
  AUTH_DENIED: "Bạn không có quyền xem dữ liệu này.",
  PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm này trong shop bạn đang chọn.",
  AMBIGUOUS_PRODUCT: "Có nhiều sản phẩm khớp, bạn nêu rõ tên hoặc SKU giúp mình nhé.",
  DATA_UNAVAILABLE: "Chưa đọc được dữ liệu cho kỳ này. Bạn thử lại sau ít phút nhé.",
  AI_PROVIDER_ERROR: "Mình chưa phân tích được dữ liệu lúc này. Bạn thử lại sau hoặc xem trực tiếp trong Phân tích Shopee.",
  AI_RATE_LIMIT: "Trợ lý đang bận, bạn thử lại sau ít phút nhé.",
  TOOL_ERROR: "Mình chưa phân tích được dữ liệu lúc này. Bạn thử lại sau hoặc xem trực tiếp trong Phân tích Shopee.",
  OUTPUT_INVALID: "Mình chưa phân tích được dữ liệu lúc này. Bạn thử lại sau hoặc xem trực tiếp trong Phân tích Shopee.",
  TIMEOUT: "Phân tích mất quá nhiều thời gian. Bạn thử lại hoặc hỏi ngắn gọn hơn nhé.",
  LIMIT_REACHED: "Bạn đã dùng hết lượt phân tích cho lúc này. Bạn thử lại sau nhé.",
};

const LIMIT_MESSAGES = {
  concurrent: "Mình đang phân tích câu hỏi trước của bạn, đợi chút rồi hỏi tiếp nhé.",
  minute: "Bạn hỏi hơi nhanh, đợi khoảng một phút rồi hỏi tiếp nhé.",
  daily: "Bạn đã dùng hết lượt phân tích hôm nay. Bạn thử lại vào ngày mai nhé.",
  cost: "Trợ lý đã chạm giới hạn chi phí hôm nay. Bạn thử lại vào ngày mai nhé.",
} as const;

// ------------------------------------------------------------------ orchestrator

export interface OrchestratorDeps {
  db: SupabaseClient;
  store: AnalystStore;
  provider: ProductAnalystProvider;
  config: ProductAnalystConfig;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

/** Start of the VN day as an ISO instant. */
function vnDayStartIso(now: Date): string {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3_600_000).toISOString();
}

export function questionHash(question: string, intent: string): string {
  return createHash("sha256").update(`${intent}|${foldVietnamese(question).replace(/[?.!,;:]+/g, "").trim()}`, "utf8").digest("hex").slice(0, 16);
}

/** Today's answers go stale fast; completed periods only change when the data version changes. */
export function cacheTtlMs(period: ProductAnalystRequest["period"]): number {
  return period === "today" || period === "this_week" || period === "this_month" || period === null ? 15 * 60_000 : 6 * 3_600_000;
}

export class ProductAnalystOrchestrator implements ProductAnalyst {
  readonly name = "orchestrator";
  private readonly deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(event: Record<string, unknown>): void {
    // metadata only: never question / answer text, never keys
    (this.deps.log ?? ((e) => console.info(JSON.stringify(e))))({ source: "product-analyst", ...event });
  }

  async analyze(req: ProductAnalystRequest): Promise<ProductAnalystResponse> {
    const { config, store, provider, db } = this.deps;
    const started = this.now();
    const t0 = started.getTime();
    const base = { provider: provider.name, model: provider.model, promptVersion: PRODUCT_ANALYST_PROMPT_VERSION, channel: req.channel, conversationId: req.conversationId, internalUserId: req.internalUserId, shopId: req.shopId, productId: req.productId, analysisType: req.analysisType } as const;
    const reject = async (category: AnalystErrorCategory, message = ANALYST_ERROR_MESSAGES[category]): Promise<ProductAnalystResponse> => {
      await store.startRun({ ...base, status: "rejected", errorCategory: category }).catch(() => undefined);
      this.log({ event: "analysis_rejected", channel: req.channel, category });
      return { kind: "error", category, message };
    };

    if (!config.enabled) return { kind: "placeholder", text: "Hệ thống phân tích sản phẩm đang được chuẩn bị." };
    if (config.allowedUserIds.length && !config.allowedUserIds.includes(req.internalUserId)) return reject("AUTH_DENIED");

    // 1. authorization BEFORE anything (cache included)
    let product: ProductIdentity | null = null;
    try {
      if (req.productId) {
        await authorizeProductTool(db, { internal_user_id: req.internalUserId, shop_id: req.shopId, product_id: req.productId });
        product = await store.product(req.productId);
        if (!product || product.shopId !== req.shopId) return reject("PRODUCT_NOT_FOUND");
      } else {
        await authorizeShopTool(db, { internal_user_id: req.internalUserId, shop_id: req.shopId });
      }
    } catch (err) {
      if (err instanceof ProductToolAccessError) return reject(err.code === "product_not_found" ? "PRODUCT_NOT_FOUND" : "AUTH_DENIED");
      return reject("DATA_UNAVAILABLE");
    }

    // 2. limits (conservative; checked on the usage log)
    const L = config.limits;
    if ((await store.countRunning(req.internalUserId, new Date(t0 - L.timeoutMs - 30_000).toISOString())) >= L.maxConcurrentPerUser) return reject("LIMIT_REACHED", LIMIT_MESSAGES.concurrent);
    if ((await store.countRuns(req.internalUserId, new Date(t0 - 60_000).toISOString())) >= L.maxCallsPerMinutePerUser) return reject("LIMIT_REACHED", LIMIT_MESSAGES.minute);
    if ((await store.countRuns(req.internalUserId, vnDayStartIso(started))) >= L.maxDailyCallsPerUser) return reject("LIMIT_REACHED", LIMIT_MESSAGES.daily);
    if ((await store.costSince(vnDayStartIso(started))) >= L.maxDailyCostUsd) return reject("LIMIT_REACHED", LIMIT_MESSAGES.cost);

    // 3. cache (authorization already passed for THIS user)
    const dataVersion = await store.dataVersion(req.shopId);
    const cacheKey = analysisCacheKey({ shopId: req.shopId, productId: req.productId, period: req.period, dataVersion, promptVersion: PRODUCT_ANALYST_PROMPT_VERSION, modelFamily: modelFamily(provider.model), questionHash: questionHash(req.question, req.intent) });
    // follow-ups depend on the history → only first questions are cached
    const cacheable = config.cacheEnabled && req.history.length === 0;
    if (cacheable) {
      const hit = await store.cacheGet(cacheKey, started);
      if (hit) {
        await store.startRun({ ...base, status: "cache_hit", cacheKey, toolTrace: hit.toolTrace });
        this.log({ event: "analysis_cache_hit", channel: req.channel, tools: hit.toolTrace });
        return { kind: "analysis", output: hit.output, meta: { cached: true, model: provider.model, promptVersion: PRODUCT_ANALYST_PROMPT_VERSION, toolTrace: hit.toolTrace, durationMs: this.now().getTime() - t0 } };
      }
    }

    // 4. run
    const runId = await store.startRun({ ...base, status: "running", cacheKey });
    this.log({ event: "analysis_started", channel: req.channel, run: runId, shop: !!req.shopId, product: !!req.productId });
    const shopName = (await store.shopName(req.shopId)) ?? "";
    const today = new Date(t0 + 7 * 3_600_000).toISOString().slice(0, 10);
    const contextPeriod = conversationPeriodToToolInput(req.period, started);
    const toolResults: unknown[] = [];
    let authDenied = false;
    let dataUnavailable = 0;
    const turns = [
      ...req.history.slice(-L.historyTurns).map((h) => ({ role: h.role, text: h.text.slice(0, 1500) })),
      { role: "user" as const, text: `${buildContextBlock({ today, shopName, product: product ? { name: product.name, sku: product.sku, itemId: product.itemId } : null, periodLabel: req.period ? PERIOD_LABELS[req.period] : "7 ngày qua", channel: req.channel })}\n\n${buildQuestionBlock(req.question)}` },
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), L.timeoutMs);
    let result: AnalystRunResult;
    try {
      result = await provider.run({
        system: PRODUCT_ANALYST_SYSTEM_PROMPT,
        turns,
        tools: ANALYST_TOOLS,
        executeTool: async (name, input) => {
          // trusted scope only — the model never supplies ids
          const r = await executeAnalystTool(name, input, { db, internalUserId: req.internalUserId, shopId: req.shopId, productId: req.productId, contextPeriod, now: started, maxBytes: L.maxToolResultBytes });
          if (r.ok) toolResults.push(r.data);
          else if (r.code === "AUTH_DENIED") authDenied = true;
          else if (r.code === "DATA_UNAVAILABLE" || r.code === "TOOL_ERROR") dataUnavailable++;
          this.log({ event: "tool", run: runId, tool: name, ok: r.ok, code: r.ok ? null : r.code, bytes: r.ok ? r.bytes : null, ms: r.ms });
          return r;
        },
        check: (raw) => {
          const v = validateAnalystOutput(raw);
          if (!v.ok) return { ok: false, feedback: `Sai schema: ${v.errors.slice(0, 5).join("; ")}.` };
          const policy = [...policyViolations(v.output), ...dataViolations(v.output, toolResults)];
          if (policy.length) return { ok: false, feedback: policy.map((p) => POLICY_FEEDBACK[p]).join(" ") };
          const ungrounded = ungroundedNumbers(v.output, toolResults, req.question);
          if (ungrounded.length) return { ok: false, feedback: `Các số sau không có trong kết quả công cụ: ${ungrounded.slice(0, 6).join(", ")}. Chỉ dùng số đúng từ công cụ.` };
          return { ok: true };
        },
        limits: { maxToolCalls: L.maxToolCalls, maxModelTurns: L.maxModelTurns, maxOutputTokens: L.maxOutputTokens, deadline: t0 + L.timeoutMs },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const category: AnalystErrorCategory = err instanceof AnalystProviderError ? err.category : "AI_PROVIDER_ERROR";
      await this.finish(runId, "failed", category, null, t0);
      return { kind: "error", category, message: ANALYST_ERROR_MESSAGES[category] };
    }
    clearTimeout(timer);

    // 5. outcome
    let category: AnalystErrorCategory | null = null;
    if (authDenied) category = "AUTH_DENIED";
    else if (result.status === "timeout") category = "TIMEOUT";
    else if (result.status === "refused") category = "AI_PROVIDER_ERROR";
    else if (result.status === "tool_budget_exceeded" || result.status === "turn_budget_exceeded") category = "LIMIT_REACHED";
    else if (result.status === "invalid_output") category = "OUTPUT_INVALID";
    else if (dataUnavailable && !toolResults.length) category = "DATA_UNAVAILABLE";
    const validated = category ? null : validateAnalystOutput(result.raw);
    if (!category && !validated?.ok) category = "OUTPUT_INVALID";
    await this.finish(runId, category ? "failed" : "completed", category, result, t0);
    if (category) {
      const message = category === "LIMIT_REACHED" ? "Câu hỏi này cần quá nhiều bước phân tích. Bạn hỏi cụ thể hơn (một sản phẩm, một kỳ) nhé." : ANALYST_ERROR_MESSAGES[category];
      return { kind: "error", category, message };
    }
    const output = (validated as { ok: true; output: AnalystOutput }).output;
    if (cacheable) {
      await store
        .cachePut({ key: cacheKey, shopId: req.shopId, productId: req.productId, promptVersion: PRODUCT_ANALYST_PROMPT_VERSION, model: provider.model, dataVersion, output, toolTrace: result.toolTrace, expiresAt: new Date(t0 + cacheTtlMs(req.period)) })
        .catch(() => undefined);
    }
    return { kind: "analysis", output, meta: { cached: false, model: provider.model, promptVersion: PRODUCT_ANALYST_PROMPT_VERSION, toolTrace: result.toolTrace, durationMs: this.now().getTime() - t0 } };
  }

  private async finish(runId: string, status: "completed" | "failed", category: AnalystErrorCategory | null, r: AnalystRunResult | null, t0: number): Promise<void> {
    const usage = r?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const cost = r ? estimateCostUsd(this.deps.provider.model, usage) : null;
    const durationMs = this.now().getTime() - t0;
    // bookkeeping must never cost the user the answer (a stuck "running" row expires with the concurrency window)
    await this.deps.store.finishRun(runId, { status, errorCategory: category, usage, estimatedCost: cost, toolCalls: r?.toolCalls ?? 0, toolTrace: r?.toolTrace ?? [], modelTurns: r?.modelTurns ?? 0, durationMs, modelMs: r?.modelMs ?? 0, toolMs: r?.toolMs ?? 0 }).catch(() => this.log({ event: "usage_log_failed", run: runId }));
    this.log({ event: status === "completed" ? "analysis_completed" : "analysis_failed", run: runId, category, status: r?.status ?? null, tools: r?.toolTrace ?? [], turns: r?.modelTurns ?? 0, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_tokens: usage.cacheReadTokens, cost_usd: cost, duration_ms: durationMs, model_ms: r?.modelMs ?? 0, tool_ms: r?.toolMs ?? 0, repaired: r?.repaired ?? false });
  }
}
