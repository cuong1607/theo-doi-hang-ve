// ============================================================
// PHASE 05 — AIResponseValidator + ToolResultFormatter. Pure.
//
// Validator: a model answer is used only if
//   * every point cites ≥ 1 label that exists ([T1] …) and only those,
//   * EVERY number it writes (answer, points, caveats) is present in the tool
//     data it was given (or in the question / period) — a number that isn't
//     there is treated as invented and the whole answer is discarded,
//   * it is not empty and carries no markup.
// Formatter: the deterministic answer (tool lines verbatim) used when the
// model may not / could not write one. It can't hallucinate by construction.
// ============================================================
import type { LabelledResult, SynthesisJson } from "./gemini-adapter.ts";
import type { AnswerPoint } from "./types.ts";

// ------------------------------------------------------------------ numbers

/** Every value a vi-VN / en number token could mean ("12.542.300" → 12542300; "4,82" → 4.82 or 482). */
export function numberCandidates(token: string): number[] {
  const t = token.replace(/[^\d.,]/g, "");
  const out = new Set<number>();
  const push = (s: string) => {
    const n = Number(s);
    if (Number.isFinite(n)) out.add(n);
  };
  push(t.replace(/[.,]/g, "")); // all separators are thousands
  if (/,\d+$/.test(t)) push(t.replace(/\./g, "").replace(",", ".")); // vi decimal comma
  if (/\.\d+$/.test(t) && !/,/.test(t)) push(t); // en decimal point
  if (/\.\d+$/.test(t)) push(t.replace(/,/g, "")); // en thousands comma + decimal point
  return [...out];
}

const NUM_TOKEN = /\d[\d.,]*\d|\d/g;

/** Numbers available to the answer: every number in the data / question (raw JSON numbers + formatted tokens). */
export function availableNumbers(texts: readonly string[]): number[] {
  const out = new Set<number>();
  for (const text of texts) for (const m of text.matchAll(NUM_TOKEN)) for (const n of numberCandidates(m[0])) out.add(n);
  return [...out];
}

const decimalsOf = (token: string) => {
  const m = token.match(/[.,](\d{1,2})$/);
  return m ? m[1]!.length : 0;
};

/** Numbers in `text` that are not in `available` (rounding to the token's own precision is accepted; ≤ 2-digit integers are lenient). */
export function ungroundedNumbers(text: string, available: readonly number[]): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(NUM_TOKEN)) {
    const token = m[0];
    const cands = numberCandidates(token);
    if (cands.every((c) => Number.isInteger(c) && Math.abs(c) < 100)) continue; // counts / days / dates: too common to check reliably
    const d = decimalsOf(token);
    const tol = d ? 0.5 * 10 ** -d : 0;
    const ok = cands.some((c) => available.some((a) => (tol ? Math.abs(a - c) <= tol + 1e-9 : a === c)));
    if (!ok) bad.push(token);
  }
  return bad;
}

// ------------------------------------------------------------------ validator

export type ValidationResult =
  | { ok: true; status: "answered" | "insufficient"; answer: string; points: AnswerPoint[]; caveats: string[] }
  | { ok: false; reason: "empty" | "invalid_citations" | "ungrounded_numbers"; detail: string[] };

const clean = (s: string, max: number) => s.replace(/<[^>]{0,200}>/g, "").replace(/\[(?!T\d{1,2}\])[^\]]{0,40}\]\([^)]{0,200}\)/g, "").replace(/[ \t]+/g, " ").trim().slice(0, max);

export function validateSynthesis(out: SynthesisJson, results: readonly LabelledResult[], question: string): ValidationResult {
  const labels = new Set(results.map((r) => r.label));
  const answer = clean(out.answer, 1500);
  const points = out.points.map((p) => ({ text: clean(p.text, 600), sourceIds: [...new Set(p.sourceIds.map((s) => s.replace(/[[\]]/g, "").trim()))] })).filter((p) => p.text);
  const caveats = out.caveats.map((c) => clean(c, 300)).filter(Boolean).slice(0, 4);
  if (!answer && !points.length) return { ok: false, reason: "empty", detail: [] };
  const badCites = points.flatMap((p) => (p.sourceIds.length ? p.sourceIds.filter((s) => !labels.has(s)) : ["(no source)"]));
  if (badCites.length) return { ok: false, reason: "invalid_citations", detail: badCites.slice(0, 5) };
  const available = availableNumbers([question, ...results.flatMap((r) => [JSON.stringify(r.result.data ?? {}), ...r.result.lines, ...r.result.caveats, r.result.source?.coverage ?? "", r.result.source?.dataUpdatedAt ?? "", r.result.source?.readAt ?? "", r.result.message ?? ""])]);
  const ungrounded = [answer, ...points.map((p) => p.text), ...caveats].flatMap((t) => ungroundedNumbers(t, available));
  if (ungrounded.length) return { ok: false, reason: "ungrounded_numbers", detail: [...new Set(ungrounded)].slice(0, 6) };
  return { ok: true, status: out.status, answer, points: points.slice(0, 8), caveats };
}

// ------------------------------------------------------------------ formatter

/** Deterministic wording: each tool's own lines, labelled with its citation. */
export function formatResults(results: readonly LabelledResult[]): { answer: string; points: AnswerPoint[]; caveats: string[] } {
  const usable = results.filter((r) => r.result.outcome === "ok" || r.result.outcome === "empty");
  const failed = results.filter((r) => r.result.outcome !== "ok" && r.result.outcome !== "empty");
  // each tool's FIRST line is its headline (→ answer); the rest are its points
  const answer = usable.length
    ? usable.map((r) => r.result.lines[0]).filter(Boolean).join(" ")
    : failed.map((r) => r.result.message ?? "Không lấy được dữ liệu.").join(" ");
  const points: AnswerPoint[] = [];
  for (const r of usable) for (const line of r.result.lines.slice(1, 31)) points.push({ text: line.replace(/^•\s*/, ""), sourceIds: [r.label] });
  if (usable.length) for (const f of failed) points.push({ text: `${f.tool.title}: ${f.result.message ?? "không lấy được dữ liệu."}`, sourceIds: [] });
  const caveats = [...new Set(usable.flatMap((r) => r.result.caveats))].slice(0, 6);
  return { answer, points, caveats };
}
