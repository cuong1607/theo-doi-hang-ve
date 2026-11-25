// ============================================================
// PHASE 06 — deterministic stand-in for Gemini (AI_PROVIDER=fake, local demo
// only; refused in production by getAiConfig). It does not understand Vietnamese:
// one proposal per candidate line, assignees = the "@[U…]" labels of that line,
// evidence = its text — enough to exercise the real validator end to end.
// ============================================================
import type { FakeScript } from "../ai-assistant/fake-provider.ts";

export const taskDemoScript: FakeScript = (input) => {
  const lines = input.user.split("\n").filter((l) => /^\[M\d+\]\(\*\)/.test(l));
  return {
    status: lines.length ? "tasks" : "no_task",
    tasks: lines.slice(0, 5).map((l) => {
      const ref = l.match(/^\[(M\d+)\]/)![1]!;
      const text = l.match(/U\d+(?: \(chủ tài khoản\))?: (.*)$/)?.[1] ?? "";
      const quote = text.replace(/@\[[^\]]+\]\s*/g, "").slice(0, 60).trim() || text.slice(0, 60);
      return {
        title: `(Demo) ${quote.slice(0, 100)}`,
        description: null,
        assignorRef: null,
        assigneeRefs: [...text.matchAll(/@\[(U\d+)\]/g)].map((m) => m[1]),
        sourceRefs: [ref],
        deadlinePhrase: null,
        priority: null,
        confidence: 0.5,
        missing: ["deadline"],
        evidence: [{ ref, quote }],
        isDecision: true,
      };
    }),
    deadlineChanges: [],
    clarification: null,
  };
};
