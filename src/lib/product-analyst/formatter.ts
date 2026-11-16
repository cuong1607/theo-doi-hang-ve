// ============================================================
// PRODUCT-ANALYTICS-4: channel-ready text from a validated AnalystOutput.
// Zalo (spec §43–45): Kết luận (2–4 lines) · Bằng chứng (≤ 5) · Khả năng ·
// Độ tin cậy · Nên kiểm tra (≤ 3) · Chưa có dữ liệu — at most 3 messages, each
// under Zalo's text limit. No JSON, no tool names, no internal ids.
// Pure.
// ============================================================
import type { AnalystOutput, Confidence } from "./contracts.ts";

export const CONFIDENCE_LABEL: Record<Confidence, string> = { HIGH: "Cao", MEDIUM: "Trung bình", LOW: "Thấp" };
export const ZALO_MAX_MESSAGES = 3;
export const ZALO_MAX_CHARS = 1800;

/** Sections in reading order; empty ones are skipped. */
export function analysisSections(o: AnalystOutput): string[] {
  const sections: string[] = [];
  sections.push(["Kết luận:", o.summary, o.data_quality_note ? `⚠ ${o.data_quality_note}` : ""].filter(Boolean).join("\n"));
  const facts = o.evidence.slice(0, 5).map((e) => `• ${e.text}`);
  if (facts.length) sections.push(["Bằng chứng chính:", ...facts].join("\n"));
  const hyp = o.hypotheses.slice(0, 2).map((h) => `• ${h.statement} (độ tin cậy ${CONFIDENCE_LABEL[h.confidence].toLowerCase()})`);
  if (hyp.length) sections.push(["Khả năng:", ...hyp].join("\n"));
  if (o.findings.length || o.hypotheses.length) sections.push(`Độ tin cậy chung: ${CONFIDENCE_LABEL[o.confidence]}`);
  const checks = o.suggested_checks.slice(0, 3).map((c) => `• ${c}`);
  if (checks.length) sections.push(["Nên kiểm tra:", ...checks].join("\n"));
  if (o.missing_data.length) sections.push(`Chưa có dữ liệu: ${o.missing_data.slice(0, 4).join("; ")}.`);
  return sections;
}

/** Packs sections into ≤ 3 messages of ≤ 1800 chars (a section is never split mid-way unless it alone is too long). */
export function formatForZalo(o: AnalystOutput, header = ""): string[] {
  const parts: string[] = [];
  let current = "";
  const sections = analysisSections(o);
  if (header) sections[0] = `${header}\n${sections[0]}`;
  for (const section of sections) {
    const piece = section.length > ZALO_MAX_CHARS ? `${section.slice(0, ZALO_MAX_CHARS - 1)}…` : section;
    const next = current ? `${current}\n\n${piece}` : piece;
    if (next.length <= ZALO_MAX_CHARS) current = next;
    else {
      if (current) parts.push(current);
      current = piece;
    }
  }
  if (current) parts.push(current);
  if (parts.length > ZALO_MAX_MESSAGES) {
    const kept = parts.slice(0, ZALO_MAX_MESSAGES);
    kept[ZALO_MAX_MESSAGES - 1] = `${kept[ZALO_MAX_MESSAGES - 1].slice(0, ZALO_MAX_CHARS - 60)}\n…(xem đầy đủ trong Phân tích Shopee)`;
    return kept;
  }
  return parts;
}

/** One plain-text rendering (web history, ai_messages.text). */
export function formatAsText(o: AnalystOutput): string {
  return analysisSections(o).join("\n\n").slice(0, 3900);
}
