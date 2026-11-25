// ============================================================
// PHASE 06 — MentionDetector + TaskCandidateDetector. Pure, no model call.
//
// MentionDetector (TASK-01)
//   * evidence = the connector's mention METADATA only ({ uid, pos, len, kind }
//     stored by 00073 from zca-js `data.mentions`) + its mentionsSelf flag;
//   * a UID is resolved to an internal user ONLY by (a) being the connection's
//     own Zalo account → its owner, or (b) a verified, active link
//     (ai_channel_identities, 00077). Display names never resolve anybody, so two
//     members called "Minh" can't be confused;
//   * "@Minh" typed as plain text (no metadata) is returned as a weak text hint
//     for candidate scoring, never as a mention;
//   * reply / quote: the current connector contract (Phase 02) carries no quote
//     metadata, so they are NOT detected (documented; nothing is guessed);
//   * only groups that may be processed (mode ≠ disabled + consent) — decided by
//     SQL on the CURRENT group row (ai_task_scan_messages.mention_eligible);
//   * replays: one row per (message, uid) — UNIQUE in the database.
//
// TaskCandidateDetector (TASK-02): light Vietnamese rules on folded text decide
// whether a message is worth sending to the extractor. No task is created here.
// ============================================================
import { foldVi } from "../ai-assistant/text.ts";
import { resolveDeadline } from "./deadline.ts";

const ZALO_ID = /^[0-9]{1,32}$/;

/** Prefix of every reminder text an external channel would send (anti-loop: such messages are never analysed). */
export const REMINDER_MARKER = "[Nhắc việc]";

export interface ScannedMessage {
  id: string;
  conversationId: string;
  conversationType: "user" | "group";
  groupName: string | null;
  eligible: boolean;
  mentionEligible: boolean;
  senderExternalId: string;
  text: string | null;
  mentions: unknown;
  mentionsSelf: boolean;
  isSelf: boolean;
  messageAt: Date;
  ingestedAt: string;
}

export interface MentionMeta {
  uid: string;
  pos: number;
  len: number;
  kind: "user" | "all";
}

/** Re-validates the stored metadata (never trusted blindly). */
export function parseMentionMetadata(raw: unknown, textLength: number): MentionMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: MentionMeta[] = [];
  for (const m of raw.slice(0, 50)) {
    if (typeof m !== "object" || m === null) continue;
    const r = m as Record<string, unknown>;
    const uid = typeof r.uid === "string" ? r.uid : null;
    const pos = typeof r.pos === "number" ? r.pos : -1;
    const len = typeof r.len === "number" ? r.len : -1;
    if (!uid || !ZALO_ID.test(uid) || !Number.isInteger(pos) || !Number.isInteger(len) || pos < 0 || len < 0 || pos + len > textLength) continue;
    out.push({ uid, pos, len, kind: r.kind === "all" ? "all" : "user" });
  }
  return out;
}

export interface MentionContext {
  /** the connection's own Zalo account id */
  accountId: string;
  ownerUserId: string;
  /** verified links of this connection: Zalo UID → internal user id */
  identities: ReadonlyMap<string, string>;
}

export interface DetectedMention {
  messageId: string;
  externalId: string;
  kind: "direct" | "all";
  target: "self" | "linked" | "unlinked";
  internalUserId: string | null;
}

export interface MentionDetection {
  mentions: DetectedMention[];
  /** "@Name" written as plain text without metadata — a hint only */
  textOnly: string[];
}

export function detectMentions(m: ScannedMessage, ctx: MentionContext): MentionDetection {
  if (m.conversationType !== "group" || !m.mentionEligible) return { mentions: [], textOnly: [] };
  const text = m.text ?? "";
  const meta = parseMentionMetadata(m.mentions, text.length);
  const byUid = new Map<string, DetectedMention>();
  for (const x of meta) {
    if (x.uid === m.senderExternalId) continue; // mentioning yourself is not a mention
    if (x.kind === "all") {
      // @All: the connection's own account is a member → one self mention
      if (!byUid.has(ctx.accountId) && m.senderExternalId !== ctx.accountId) byUid.set(ctx.accountId, { messageId: m.id, externalId: ctx.accountId, kind: "all", target: "self", internalUserId: ctx.ownerUserId });
      continue;
    }
    if (byUid.has(x.uid)) continue;
    if (x.uid === ctx.accountId) byUid.set(x.uid, { messageId: m.id, externalId: x.uid, kind: "direct", target: "self", internalUserId: ctx.ownerUserId });
    else {
      const linked = ctx.identities.get(x.uid) ?? null;
      byUid.set(x.uid, { messageId: m.id, externalId: x.uid, kind: "direct", target: linked ? "linked" : "unlinked", internalUserId: linked });
    }
  }
  // the worker's own flag (computed against the account id) also counts as metadata
  if (m.mentionsSelf && !byUid.has(ctx.accountId) && m.senderExternalId !== ctx.accountId) {
    byUid.set(ctx.accountId, { messageId: m.id, externalId: ctx.accountId, kind: "direct", target: "self", internalUserId: ctx.ownerUserId });
  }
  // plain-text "@Name" outside every metadata span
  const covered = (i: number) => meta.some((x) => i >= x.pos && i < x.pos + x.len);
  const textOnly: string[] = [];
  for (const t of text.matchAll(/@([\p{L}\p{N}_.]{2,30})/gu)) if (!covered(t.index!)) textOnly.push(t[1]!);
  return { mentions: [...byUid.values()], textOnly: textOnly.slice(0, 10) };
}

// ------------------------------------------------------------------ candidates

const ACTION = /\b(kiem tra|check|gui|xac nhan|cap nhat|update|xu ly|bao cao|chuan bi|lien he|goi (?:dien|lai|cho)|dat hang|nhap hang|chuyen khoan|thanh toan|duyet|soan|hoan thanh|hoan tat|theo doi|giao hang|dong goi|ra soat|doi soat|chot|tong hop|nop|sua|fix|review|len don|tra loi|phan hoi|in (?:hoa don|phieu|tem)|xuat (?:hoa don|kho|file)|dat lich|sap xep|nhac)\b/;
const WEAK_ACTION = /\b(lam|xem|lo)\b/;
const REQUEST = /\b(giup|gium|ho em|ho anh|ho chi|nhe|nha|nhe|nhanh|di nhe|lam on|nho|phai|can|em oi|anh oi|chi oi|ban oi|moi nguoi|ca nha|nhe a|nha a)\b/;
const ASSIGN_Q = /\bai (phu trach|lam|xu ly|nhan|lo|chiu trach nhiem|theo doi)\b/;
const SPECULATIVE = /\b(chac|co le|hay la|neu|co khi|khong can|chua can|thoi khoi|de sau|tinh sau|biet dau|hinh nhu|du dinh)\b/;
const DONE = /\b(xong roi|da (?:gui|xong|lam|xu ly|check|kiem tra|cap nhat|nop|chot)|gui roi|lam roi|ok roi|done)\b/;

export interface CandidateDecision {
  candidate: boolean;
  score: number;
  reasons: string[];
}

/**
 * Light, explainable rules: +2 action verb, +1 weak verb, +1 request marker,
 * +3 "ai phụ trách / ai làm …", +2 a deadline expression, +2 a mention (metadata),
 * +1 a text "@Name"; −2 speculation, −3 "đã xong / gửi rồi". Candidate when the
 * score ≥ 3 AND there is an action (or an assignment question).
 */
export function detectCandidate(m: ScannedMessage, mention: MentionDetection): CandidateDecision {
  const text = (m.text ?? "").trim();
  if (!m.eligible || text.length < 6 || text.length > 2000) return { candidate: false, score: 0, reasons: [] };
  if (text.startsWith(REMINDER_MARKER)) return { candidate: false, score: 0, reasons: ["reminder_echo"] };
  const f = foldVi(text);
  const reasons: string[] = [];
  let score = 0;
  const hit = (when: boolean, points: number, reason: string) => {
    if (!when) return;
    score += points;
    reasons.push(reason);
  };
  const action = ACTION.test(f);
  const weak = !action && WEAK_ACTION.test(f);
  const assign = ASSIGN_Q.test(f);
  const direct = mention.mentions.some((x) => x.kind === "direct");
  hit(action, 2, "action_verb");
  hit(weak, 1, "weak_action");
  hit(REQUEST.test(f), 1, "request_marker");
  hit(assign, 3, "assignment_question");
  hit(Boolean(resolveDeadline(text, m.messageAt)), 2, "deadline");
  hit(direct, 2, "mention");
  hit(!direct && mention.textOnly.length > 0, 1, "text_mention");
  hit(SPECULATIVE.test(f), -2, "speculative");
  hit(DONE.test(f), -3, "already_done");
  score = Math.max(0, Math.min(100, score));
  return { candidate: score >= 3 && (action || weak || assign), score, reasons };
}
