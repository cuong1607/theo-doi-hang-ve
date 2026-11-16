// ============================================================
// PRODUCT-ANALYTICS-4: ClaudeProductAnalystProvider — Anthropic Messages API
// via the official SDK, manual tool loop (we own the budget, the trace, the
// per-call authorization and the repair turn).
//
//   * model from config (AI_PRODUCT_ANALYST_MODEL, default Sonnet-class);
//     adaptive thinking (model default), effort from config;
//   * structured output: output_config.format = AnalystOutput JSON schema,
//     plus our own validator + guards (check) on the final text;
//   * tools: strict schemas, auto tool choice (forced choice is not accepted
//     on current models), parallel results returned in ONE user message;
//   * prompt caching: frozen system prompt + fixed tool list, cache breakpoint
//     on the system block;
//   * refusals: server-side fallback ("default") on models that accept it;
//     a final refusal is status "refused".
// ANTHROPIC_API_KEY is read by the SDK from the server environment; it is
// never logged or sent anywhere else. Not imported by client components.
// ============================================================
import Anthropic from "@anthropic-ai/sdk";

import { ANALYST_OUTPUT_JSON_SCHEMA } from "./contracts.ts";
import { FALLBACK_CAPABLE_MODELS, type AnalystEffort, type TokenUsage } from "./config.ts";
import { AnalystProviderError, emptyUsage, type AnalystRunInput, type AnalystRunResult, type ProductAnalystProvider } from "./provider.ts";

type BetaParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class ClaudeProductAnalystProvider implements ProductAnalystProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly effort: AnalystEffort;
  private readonly fallbacks: boolean;
  private readonly client: Anthropic;

  constructor(opts: { model: string; effort: AnalystEffort; fallbacks: boolean; client?: Anthropic }) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.fallbacks = opts.fallbacks && FALLBACK_CAPABLE_MODELS.includes(opts.model);
    // SDK retries 429 / 5xx / connection errors twice by default; our deadline bounds the total
    this.client = opts.client ?? new Anthropic({ maxRetries: 2 });
  }

  async run(input: AnalystRunInput): Promise<AnalystRunResult> {
    const usage: TokenUsage = emptyUsage();
    const toolTrace: string[] = [];
    let modelTurns = 0;
    let toolCalls = 0;
    let modelMs = 0;
    let toolMs = 0;
    let repaired = false;
    let budgetWarned = false;

    const messages: BetaMessageParam[] = mergeTurns(input.turns);
    const tools = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as unknown as Anthropic.Beta.Messages.BetaTool.InputSchema, strict: true }));
    const result = (status: AnalystRunResult["status"], raw: unknown = null): AnalystRunResult => ({ status, raw, usage, modelTurns, toolCalls, toolTrace, modelMs, toolMs, repaired });

    while (modelTurns < input.limits.maxModelTurns) {
      const remaining = input.limits.deadline - Date.now();
      if (remaining <= 1_000 || input.signal.aborted) return result("timeout");
      const params: BetaParams = {
        model: this.model,
        max_tokens: input.limits.maxOutputTokens,
        system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
        output_config: { effort: this.effort, format: { type: "json_schema", schema: ANALYST_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown> } },
        ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      };
      const t0 = Date.now();
      let response: Anthropic.Beta.Messages.BetaMessage;
      try {
        response = await this.client.beta.messages.create(params, { signal: input.signal, timeout: remaining });
      } catch (err) {
        throw classifyError(err);
      } finally {
        modelMs += Date.now() - t0;
      }
      modelTurns++;
      addUsage(usage, response.usage);

      if (response.stop_reason === "refusal") return result("refused");
      if (response.stop_reason === "max_tokens") return result("invalid_output");

      const toolUses = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length) {
        // thinking / text / tool_use blocks are passed back unchanged
        messages.push({ role: "assistant", content: response.content as BetaContentBlock[] });
        const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
        let overBudget = false;
        for (const call of toolUses) {
          if (toolCalls >= input.limits.maxToolCalls) {
            overBudget = true;
            results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: "Đã hết số lần gọi công cụ cho câu hỏi này. Hãy trả lời ngay bằng dữ liệu đã có (nêu rõ phần còn thiếu)." });
            continue;
          }
          toolCalls++;
          toolTrace.push(call.name);
          const r = await input.executeTool(call.name, call.input);
          toolMs += r.ms;
          results.push({ type: "tool_result", tool_use_id: call.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
        }
        messages.push({ role: "user", content: results });
        if (overBudget) {
          // one warning, then stop safely
          if (budgetWarned) return result("tool_budget_exceeded");
          budgetWarned = true;
        }
        continue;
      }

      // final answer: JSON text (structured output)
      const text = response.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
      let raw: unknown = null;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
      const verdict = raw === null ? { ok: false as const, feedback: "Đầu ra không phải JSON hợp lệ theo schema." } : input.check(raw);
      if (verdict.ok) return result("completed", raw);
      if (repaired || modelTurns >= input.limits.maxModelTurns) return result("invalid_output", raw);
      repaired = true;
      messages.push({ role: "assistant", content: response.content as BetaContentBlock[] });
      messages.push({ role: "user", content: `Bản trả lời chưa đạt yêu cầu: ${verdict.feedback} Hãy viết lại toàn bộ JSON, chỉ dùng số có trong kết quả công cụ.` });
    }
    return result("turn_budget_exceeded");
  }
}

/** History turns → alternating messages (consecutive same-role turns are merged). */
function mergeTurns(turns: AnalystRunInput["turns"]): BetaMessageParam[] {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += `\n\n${t.text}`;
    else out.push({ role: t.role, content: t.text });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function addUsage(u: TokenUsage, r: Anthropic.Beta.Messages.BetaUsage): void {
  u.inputTokens += r.input_tokens ?? 0;
  u.outputTokens += r.output_tokens ?? 0;
  u.cacheReadTokens += r.cache_read_input_tokens ?? 0;
  u.cacheWriteTokens += r.cache_creation_input_tokens ?? 0;
}

/** Typed SDK errors → our categories (no message text from the provider reaches users). */
function classifyError(err: unknown): AnalystProviderError {
  if (err instanceof Anthropic.RateLimitError) return new AnalystProviderError("AI_RATE_LIMIT", "rate_limited");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AnalystProviderError("TIMEOUT", "timeout");
  if (err instanceof Anthropic.APIUserAbortError) return new AnalystProviderError("TIMEOUT", "aborted");
  if (err instanceof Anthropic.APIError) return new AnalystProviderError("AI_PROVIDER_ERROR", `status_${err.status ?? "?"}`);
  return new AnalystProviderError("AI_PROVIDER_ERROR", "unknown");
}
