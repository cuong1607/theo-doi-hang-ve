// ============================================================
// AI ASSISTANT — the model boundary. One bounded JSON generation per call.
// System instructions and retrieved (untrusted) content travel in SEPARATE
// fields: the provider puts `system` in the provider's system channel and
// `user` in the user turn. No tools, no function calling: the model can't
// trigger any API call, query or message send.
// Pure: no I/O.
// ============================================================

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** true when the provider reported the counts; false = our estimate */
  confirmed: boolean;
}

export interface GenerateInput {
  system: string;
  user: string;
  /** JSON schema the answer must follow (also re-validated by the caller) */
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  /** raw JSON text from the model (never trusted: parsed + validated by the caller) */
  text: string;
  usage: AiUsage;
  finishReason: string | null;
}

export type AiErrorCategory =
  | "config_missing" // no API key / model
  | "model_invalid"
  | "auth" // 401 / 403 / invalid key
  | "rate_limit" // 429 per-minute
  | "quota_exceeded" // 429 RESOURCE_EXHAUSTED quota / daily limit
  | "timeout"
  | "network"
  | "provider_error" // 5xx
  | "invalid_response" // empty / non-JSON / wrong schema / blocked
  | "budget_exceeded"; // refused locally before any call

export class AiProviderError extends Error {
  readonly category: AiErrorCategory;
  /** safe to retry once (network / 5xx) */
  readonly transient: boolean;
  constructor(category: AiErrorCategory, message: string, transient = false) {
    super(message);
    this.name = "AiProviderError";
    this.category = category;
    this.transient = transient;
  }
}

export interface AiTextProvider {
  readonly name: string;
  readonly model: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
}

/** Vietnamese ≈ 3 characters per token for Gemini tokenizers (conservative: rounds up). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Friendly Vietnamese text per category — never the provider's own error text. */
export const AI_ERROR_TEXT: Record<AiErrorCategory, string> = {
  config_missing: "AI chưa được cấu hình (thiếu khóa API hoặc model).",
  model_invalid: "Model AI cấu hình không hợp lệ.",
  auth: "Khóa API của AI không hợp lệ hoặc đã bị thu hồi.",
  rate_limit: "AI đang bị giới hạn tốc độ. Vui lòng thử lại sau ít phút.",
  quota_exceeded: "AI đã tạm hết hạn mức sử dụng. Vui lòng thử lại sau.",
  timeout: "AI phản hồi quá lâu. Vui lòng thử lại với khoảng thời gian ngắn hơn.",
  network: "Không kết nối được dịch vụ AI. Vui lòng thử lại.",
  provider_error: "Dịch vụ AI đang gặp sự cố. Vui lòng thử lại sau.",
  invalid_response: "AI trả về kết quả không hợp lệ. Vui lòng thử lại.",
  budget_exceeded: "Đã dùng hết hạn mức AI cho hôm nay.",
};

/**
 * Calls generate() with a bounded retry for TRANSIENT failures only (network,
 * 5xx). 429 / quota / auth / timeout / invalid output are never retried, so one
 * user request never multiplies into many paid calls.
 */
export async function generateWithRetry(provider: AiTextProvider, input: GenerateInput, maxRetries: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<{ result: GenerateResult; attempts: number }> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return { result: await provider.generate(input), attempts: attempt };
    } catch (err) {
      const e = err instanceof AiProviderError ? err : new AiProviderError("provider_error", "unexpected provider failure");
      if (!e.transient || attempt > maxRetries || input.signal?.aborted) throw e;
      await sleep(1_000 * attempt);
    }
  }
}
