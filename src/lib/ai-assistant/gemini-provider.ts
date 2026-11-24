// ============================================================
// AI ASSISTANT — Gemini via @google/genai (server only: the API key is passed in
// by server.ts and is never logged or sent to the browser).
//
// - The SDK's own retry is DISABLED (attempts: 1): retries are decided by
//   generateWithRetry() so a request never silently becomes 5 paid calls.
// - Timeout = SDK httpOptions.timeout + an AbortSignal (client-side cancel;
//   Google may still bill a request it already processed).
// - JSON output with a response schema; the caller re-validates anyway.
// - Errors are mapped to categories; the provider's error text is dropped.
//
// The client is injectable (`clientFactory`) so tests never touch the network.
// ============================================================
import { ApiError, GoogleGenAI } from "@google/genai";

import { GEMINI_MODEL_PATTERN, localOnly } from "./config.ts";
import { AiProviderError, estimateTokens, type AiTextProvider, type GenerateInput, type GenerateResult } from "./provider.ts";

/** The slice of the SDK this provider uses (so a fake can stand in). */
export interface GeminiClientLike {
  models: {
    generateContent(params: {
      model: string;
      contents: Array<{ role: "user"; parts: Array<{ text: string }> }>;
      config: Record<string, unknown>;
    }): Promise<{
      text?: string;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      candidates?: Array<{ finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    }>;
  };
}

export type GeminiClientFactory = (apiKey: string, baseUrl: string | null) => GeminiClientLike;

export const defaultGeminiClientFactory: GeminiClientFactory = (apiKey, baseUrl) =>
  new GoogleGenAI(baseUrl ? { apiKey, httpOptions: { baseUrl } } : { apiKey }) as unknown as GeminiClientLike;

/** Maps any SDK / network failure to a category. Never keeps the provider's message. */
export function mapGeminiError(err: unknown, timedOut: boolean): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (timedOut) return new AiProviderError("timeout", "gemini timeout");
  const status = err instanceof ApiError ? err.status : typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : null;
  const message = err instanceof Error ? err.message : "";
  if (status === 401 || status === 403 || /API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) return new AiProviderError("auth", "gemini auth");
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(message)) {
    // daily / project quota vs. per-minute rate: Google reports both as 429
    return /quota|per day|daily|exceeded your current quota/i.test(message) ? new AiProviderError("quota_exceeded", "gemini quota") : new AiProviderError("rate_limit", "gemini rate limit");
  }
  if (status === 404 || (status === 400 && /model/i.test(message))) return new AiProviderError("model_invalid", "gemini model");
  if (status === 400) return new AiProviderError("invalid_response", "gemini bad request");
  if (status !== null && status >= 500) return new AiProviderError("provider_error", "gemini 5xx", true);
  if (err instanceof Error && (err.name === "AbortError" || /aborted|timeout/i.test(message))) return new AiProviderError("timeout", "gemini aborted");
  if (err instanceof TypeError || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message)) return new AiProviderError("network", "gemini network", true);
  return new AiProviderError("provider_error", "gemini unknown");
}

export class GeminiProvider implements AiTextProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly client: GeminiClientLike;

  constructor(opts: { apiKey: string | undefined; model: string | null; baseUrl?: string | null; clientFactory?: GeminiClientFactory }) {
    if (!opts.apiKey?.trim() || !opts.model) throw new AiProviderError("config_missing", "gemini not configured");
    if (!GEMINI_MODEL_PATTERN.test(opts.model)) throw new AiProviderError("model_invalid", "gemini model id");
    this.model = opts.model;
    this.client = (opts.clientFactory ?? defaultGeminiClientFactory)(opts.apiKey.trim(), localOnly(opts.baseUrl ?? undefined));
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, input.timeoutMs);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: [{ text: input.user }] }],
        config: {
          systemInstruction: input.system,
          responseMimeType: "application/json",
          responseJsonSchema: input.responseSchema,
          maxOutputTokens: input.maxOutputTokens,
          temperature: 0.2,
          abortSignal: controller.signal,
          httpOptions: { timeout: input.timeoutMs, retryOptions: { attempts: 1 } },
        },
      });
      if (res.promptFeedback?.blockReason) throw new AiProviderError("invalid_response", "gemini blocked");
      const text = res.text?.trim() ?? "";
      if (!text) throw new AiProviderError("invalid_response", "gemini empty");
      const u = res.usageMetadata;
      const reported = typeof u?.promptTokenCount === "number" && typeof u?.candidatesTokenCount === "number";
      return {
        text,
        usage: reported
          ? { inputTokens: u!.promptTokenCount!, outputTokens: u!.candidatesTokenCount! + (u!.thoughtsTokenCount ?? 0), confirmed: true }
          : { inputTokens: estimateTokens(input.system + input.user), outputTokens: estimateTokens(text), confirmed: false },
        finishReason: res.candidates?.[0]?.finishReason ?? null,
      };
    } catch (err) {
      throw mapGeminiError(err, timedOut);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}
