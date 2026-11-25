// ============================================================
// PHASE 05 — deterministic stand-in for Gemini (AI_PROVIDER=fake: local demo
// and tests; never in production — getAiConfig refuses "fake" there).
//   plan       → the rule planner's calls, as the model would send them
//   synthesis  → each tool's standard lines, cited with its label
// It does not understand anything; it only exercises the real pipeline
// (budget, schema, parsing, validation, citations).
// ============================================================
import type { FakeScript } from "../ai-assistant/fake-provider.ts";
import { rulesPlan } from "./planner.ts";

export const systemDemoScript: FakeScript = (input) => {
  if (input.system.includes("bộ định tuyến")) {
    const question = input.user.match(/"""([\s\S]*)"""/)?.[1] ?? "";
    const plan = rulesPlan(question, new Date());
    if (plan.kind === "call") return { action: "call_tools", calls: plan.calls.map((c) => ({ tool: c.tool, argsJson: JSON.stringify(c.args) })), message: "" };
    if (plan.kind === "refuse_change") return { action: "refuse_change", calls: [], message: "" };
    return { action: plan.kind === "unsupported" ? "unsupported" : "clarify", calls: [], message: plan.message };
  }
  const points: Array<{ text: string; sourceIds: string[] }> = [];
  for (const block of input.user.matchAll(/\[(T\d+)\][^\n]*\n[\s\S]*?Tóm tắt chuẩn:\n((?:- .*(?:\n|$))+)/g)) {
    for (const line of block[2]!.split("\n").filter((l) => l.startsWith("- ")).slice(0, 6)) points.push({ text: line.slice(2), sourceIds: [block[1]!] });
  }
  return { status: points.length ? "answered" : "insufficient", answer: points.length ? "(Bản demo, không dùng AI thật) Số liệu từ hệ thống:" : "", points, caveats: [] };
};
