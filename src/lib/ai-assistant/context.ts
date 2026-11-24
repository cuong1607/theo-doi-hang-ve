// ============================================================
// AI ASSISTANT — ContextBuilder. Turns retrieved messages into the DATA block
// the model reads, under a token budget, with short source labels.
//
// - The model only ever sees labels S1…Sn, never internal ids: a label is
//   resolvable only through THIS map, so an invented id proves nothing.
// - Candidates are taken in priority order (keyword hits, their neighbours,
//   then recent messages) until the budget is used, then shown chronologically.
// - Message text is untrusted: newlines flattened, length capped, anything that
//   looks like our boundary markers is neutralised, then the whole block is
//   wrapped in markers with a per-request random nonce.
// - Optional redaction (policy "redacted") happens here, before the provider.
// ============================================================
import { randomBytes } from "node:crypto";

import { estimateTokens } from "./provider.ts";
import { addStats, emptyStats, redact, type RedactionStats } from "./redact.ts";

export interface SourceMessage {
  id: string;
  conversationId: string;
  conversationTitle: string;
  conversationType: "user" | "group";
  senderLabel: string;
  isSelf: boolean;
  /** ISO instant */
  at: string;
  messageType: string;
  text: string | null;
  /** lower = more important; ties keep insertion order */
  priority: number;
}

export interface BuiltContext {
  block: string;
  nonce: string;
  /** label → message (only messages that made it into the block) */
  labels: Map<string, SourceMessage>;
  included: SourceMessage[];
  droppedForBudget: number;
  tokens: number;
  redaction: RedactionStats;
}

export const MAX_MESSAGE_CHARS = 600;

const vnTime = (iso: string) => {
  const d = new Date(Date.parse(iso) + 7 * 3_600_000).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 16)}`;
};

const TYPE_TEXT: Record<string, string> = { image: "[hình ảnh]", sticker: "[sticker]", video: "[video]", voice: "[tin thoại]", file: "[tệp]", link: "[liên kết]", location: "[vị trí]", other: "[loại tin khác]" };

/** Neutralises our markers and flattens whitespace. */
export function sanitize(text: string): string {
  return text
    .replace(/<{2,}|>{2,}/g, "‹‹")
    .replace(/\b(DATA|END)-[0-9a-f]{8,}\b/gi, "[đã lọc]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

export function buildContext(candidates: readonly SourceMessage[], opts: { maxTokens: number; redact: boolean; nonce?: string }): BuiltContext {
  const nonce = opts.nonce ?? randomBytes(6).toString("hex");
  const seen = new Set<string>();
  const ordered = candidates
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.priority - b.m.priority || a.i - b.i)
    .map((x) => x.m)
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

  let redaction = emptyStats();
  const lineOf = (m: SourceMessage): string => {
    let body = m.text ? sanitize(m.text) : TYPE_TEXT[m.messageType] ?? "[không có nội dung]";
    if (m.text && opts.redact) {
      const r = redact(body);
      body = r.text;
      redaction = addStats(redaction, r.stats);
    }
    return `${vnTime(m.at)} · ${sanitize(m.conversationTitle)} · ${m.isSelf ? "Chủ tài khoản" : sanitize(m.senderLabel)}: ${body}`;
  };

  const picked: Array<{ m: SourceMessage; line: string }> = [];
  let tokens = 0;
  let dropped = 0;
  for (const m of ordered) {
    const line = lineOf(m);
    const cost = estimateTokens(line) + 4;
    if (tokens + cost > opts.maxTokens) {
      dropped++;
      continue;
    }
    tokens += cost;
    picked.push({ m, line });
  }
  picked.sort((a, b) => a.m.conversationTitle.localeCompare(b.m.conversationTitle) || Date.parse(a.m.at) - Date.parse(b.m.at) || a.m.id.localeCompare(b.m.id));

  const labels = new Map<string, SourceMessage>();
  const lines = picked.map((p, i) => {
    const label = `S${i + 1}`;
    labels.set(label, p.m);
    return `[${label}] ${p.line}`;
  });
  const block = `<<DATA-${nonce}>>\n${lines.join("\n")}\n<<END-${nonce}>>`;
  return { block, nonce, labels, included: picked.map((p) => p.m), droppedForBudget: dropped, tokens, redaction };
}
