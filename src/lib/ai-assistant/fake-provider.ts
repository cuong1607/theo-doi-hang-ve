// ============================================================
// AI ASSISTANT — deterministic provider for tests and local demos. Never
// touches the network. A script decides each answer from the request, or
// throws an AiProviderError to simulate provider failures.
// ============================================================
import { AiProviderError, estimateTokens, type AiErrorCategory, type AiTextProvider, type GenerateInput, type GenerateResult } from "./provider.ts";

export type FakeScript = (input: GenerateInput, call: number) => unknown | Promise<unknown>;

export class FakeAiProvider implements AiTextProvider {
  readonly name = "fake";
  readonly model: string;
  readonly calls: GenerateInput[] = [];
  private readonly script: FakeScript;

  constructor(script: FakeScript, model = "gemini-fake") {
    this.script = script;
    this.model = model;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.calls.push(input);
    const out = await this.script(input, this.calls.length);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    return { text, usage: { inputTokens: estimateTokens(input.system + input.user), outputTokens: estimateTokens(text), confirmed: false }, finishReason: "STOP" };
  }
}

export const failWith = (category: AiErrorCategory, transient = false): FakeScript => () => {
  throw new AiProviderError(category, `fake ${category}`, transient);
};

/**
 * Demo script: answers from the first labelled sources it sees ([S1], [S2] …),
 * so a local demo shows real citations without any provider. Only a stand-in:
 * it does not understand the question.
 */
export const echoSourcesScript: FakeScript = (input) => {
  const labels = [...input.user.matchAll(/\[(S\d{1,3})\][^\n]*?: (.{0,160})/g)].slice(0, 3);
  if (input.user.includes('"kind": "summary"') || input.system.includes("TÓM TẮT")) {
    return {
      status: labels.length ? "answered" : "insufficient",
      summary: labels.length ? `(Bản demo, không dùng AI thật) ${labels.length} ý chính được trích từ tin nguồn.` : "",
      points: labels.map((m) => ({ text: m[2]!.trim(), sourceIds: [m[1]] })),
      decisions: [],
      assignments: [],
      openQuestions: [],
      importantDates: [],
      facts: labels.slice(0, 1).map((m) => ({ text: m[2]!.trim(), sourceIds: [m[1]], confidence: 0.5 })),
    };
  }
  return {
    status: labels.length ? "answered" : "insufficient",
    answer: labels.length ? "(Bản demo, không dùng AI thật) Các tin liên quan nhất:" : "",
    points: labels.map((m) => ({ text: m[2]!.trim(), sourceIds: [m[1]] })),
  };
};
