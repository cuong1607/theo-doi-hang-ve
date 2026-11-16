// ============================================================
// PRODUCT-ANALYTICS-4: the model boundary.
//
// ProductAnalystProvider.run() drives ONE bounded analysis: tool calls go
// through the injected executeTool (allowlist + backend authorization), the
// final answer must pass the injected check (schema + guards), with at most
// one repair turn. Implementations:
//   ClaudeProductAnalystProvider  ./claude-provider.ts (Anthropic SDK, server only)
//   FakeProductAnalystProvider    ./fake-provider.ts   (deterministic, tests / demos)
// DisabledProductAnalyst answers the placeholder while AI is off.
// Pure: no I/O, no "@/" imports.
// ============================================================
import type { ProductAnalyst, ProductAnalystResponse } from "./contracts.ts";
import type { TokenUsage } from "./config.ts";
import type { AnalystToolSpec, ToolExecutionResult } from "./tools.ts";

export const PRODUCT_ANALYST_PLACEHOLDER = "Hệ thống phân tích sản phẩm đang được chuẩn bị.";

export interface AnalystRunInput {
  system: string;
  /** prior turns (plain text) then the request's context + question as the last user turn */
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  tools: readonly AnalystToolSpec[];
  executeTool(name: string, input: unknown): Promise<ToolExecutionResult>;
  /** schema + guards on the raw final JSON; a failure gets ONE repair turn with this feedback */
  check(raw: unknown): { ok: true } | { ok: false; feedback: string };
  limits: { maxToolCalls: number; maxModelTurns: number; maxOutputTokens: number; deadline: number };
  signal: AbortSignal;
}

export type AnalystRunStatus = "completed" | "tool_budget_exceeded" | "turn_budget_exceeded" | "invalid_output" | "refused" | "timeout";

export interface AnalystRunResult {
  status: AnalystRunStatus;
  /** the final JSON (already checked when status = completed) */
  raw: unknown;
  usage: TokenUsage;
  modelTurns: number;
  toolCalls: number;
  toolTrace: string[];
  modelMs: number;
  toolMs: number;
  repaired: boolean;
}

export class AnalystProviderError extends Error {
  readonly category: "AI_PROVIDER_ERROR" | "AI_RATE_LIMIT" | "TIMEOUT";
  constructor(category: AnalystProviderError["category"], message: string) {
    super(message);
    this.name = "AnalystProviderError";
    this.category = category;
  }
}

export interface ProductAnalystProvider {
  readonly name: string;
  readonly model: string;
  run(input: AnalystRunInput): Promise<AnalystRunResult>;
}

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** What a channel gets while AI_PRODUCT_ANALYST_ENABLED (or the channel flag) is off. */
export class DisabledProductAnalyst implements ProductAnalyst {
  readonly name = "disabled";
  // the request is ignored on purpose: nothing is analysed while AI is off
  async analyze(): Promise<ProductAnalystResponse> {
    return { kind: "placeholder", text: PRODUCT_ANALYST_PLACEHOLDER };
  }
}
