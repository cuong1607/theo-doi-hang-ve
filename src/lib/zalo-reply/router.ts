// ============================================================
// PHASE 04.5 — REPLY-01 / REPLY-02: inbound reply router + eligibility.
// Pure. Input = messages already normalized by the worker AND stored by the
// Phase 02 ingestion (deduplicated by connection + conversation + Zalo
// message id); nothing here sees a raw zca-js object.
//
// A message CALLS the bot only through:
//   direct   any text in a 1-1 chat with the bot account
//   link     "LINK <mã>" in a 1-1 chat (Phase 05 identity linking)
//   mention  @mention METADATA whose uid is the bot account (kind "user");
//            "@Bot" typed as text, or @All, is NOT a call
//   command  "/bot …" at the very start of a group message
// Everything else is not recorded at all (the bot never answers group chatter).
// ============================================================
import { detectLinkCommand } from "../ai-system/identity.ts";
import { BOT_COMMAND } from "./config.ts";

export type Trigger = "direct" | "mention" | "command" | "link";
export type GroupMode = "disabled" | "monitor" | "mention_only" | "interactive";

export interface ScannedMessage {
  id: string;
  conversationId: string;
  conversationType: "user" | "group";
  groupMode: GroupMode | null;
  groupConsent: "none" | "granted" | "withdrawn" | null;
  messageType: string;
  contentStored: boolean;
  text: string | null;
  mentions: unknown;
  isSelf: boolean;
  senderExternalId: string;
}

export interface MentionMeta {
  uid: string;
  pos: number;
  len: number;
  kind: "user" | "all";
}

export interface RouterSettings {
  replyMode: "off" | "draft_only" | "auto";
  directEnabled: boolean;
}

export const MAX_QUESTION_CHARS = 500;

/** Only well-formed mention metadata (as stored by Phase 02) is trusted. */
export function parseMentions(raw: unknown): MentionMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: MentionMeta[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if (typeof r.uid !== "string" || !/^[0-9]{1,32}$/.test(r.uid)) continue;
    if (typeof r.pos !== "number" || typeof r.len !== "number" || !Number.isInteger(r.pos) || !Number.isInteger(r.len) || r.pos < 0 || r.len < 0) continue;
    if (r.kind !== "user" && r.kind !== "all") continue;
    out.push({ uid: r.uid, pos: r.pos, len: r.len, kind: r.kind });
  }
  return out;
}

const COMMAND_RE = new RegExp(`^\\s*${BOT_COMMAND.replace("/", "\\/")}(?=\\s|$)`, "i");

/** Removes the bot mention spans (metadata positions) and leading separators. */
export function questionOf(text: string, botMentions: MentionMeta[]): string {
  let t = text;
  for (const m of [...botMentions].sort((a, b) => b.pos - a.pos)) {
    if (m.pos + m.len <= t.length) t = t.slice(0, m.pos) + " " + t.slice(m.pos + m.len);
  }
  t = t.replace(COMMAND_RE, " ");
  return t.replace(/\s+/g, " ").replace(/^[\s,:;.\-–!?]+/, "").trim();
}

export interface TriggerResult {
  trigger: Trigger;
  question: string;
  linkCode: string | null;
}

/**
 * Does this message call the bot? null = no (not recorded). `botUid` is the
 * connection's own Zalo account (bound by the first heartbeat), never a value
 * from the message.
 */
export function detectTrigger(msg: Pick<ScannedMessage, "conversationType" | "text" | "mentions" | "isSelf">, botUid: string | null): TriggerResult | null {
  // own messages (incl. the bot's own replies coming back through selfListen) never trigger
  if (msg.isSelf) return null;
  const text = msg.text ?? "";
  if (msg.conversationType === "user") {
    const code = text ? detectLinkCommand(text) : null;
    if (code) return { trigger: "link", question: "", linkCode: code };
    return { trigger: "direct", question: questionOf(text, []), linkCode: null };
  }
  const botMentions = botUid ? parseMentions(msg.mentions).filter((m) => m.kind === "user" && m.uid === botUid) : [];
  if (botMentions.length > 0) return { trigger: "mention", question: questionOf(text, botMentions), linkCode: null };
  if (COMMAND_RE.test(text)) return { trigger: "command", question: questionOf(text, []), linkCode: null };
  return null;
}

export type RouteDecision = { record: false } | { record: true; trigger: Trigger; decision: "process" | "skip"; reason: string | null };

/**
 * REPLY-02 eligibility at scan time (cheap, no I/O). Identity, block list and
 * the final send gates are checked later (pipeline / claim).
 */
export function routeMessage(msg: ScannedMessage, botUid: string | null, settings: RouterSettings): RouteDecision {
  const t = detectTrigger(msg, botUid);
  if (!t) return { record: false };
  const skip = (reason: string): RouteDecision => ({ record: true, trigger: t.trigger, decision: "skip", reason });
  if (settings.replyMode === "off") return skip("replies_off");
  if (msg.conversationType === "group") {
    if (msg.groupConsent !== "granted" || !msg.groupMode || msg.groupMode === "disabled") return skip("group_disabled");
    if (msg.groupMode === "monitor") return skip("group_monitor_only");
  } else if (!settings.directEnabled) {
    return skip("direct_disabled");
  }
  if (msg.messageType !== "text") return skip("unsupported_type");
  if (!msg.contentStored || msg.text === null) return skip("content_not_stored");
  if (t.trigger !== "link") {
    if (t.question.length < 2) return skip("empty_question");
    if (t.question.length > MAX_QUESTION_CHARS) return skip("question_too_long");
  }
  return { record: true, trigger: t.trigger, decision: "process", reason: null };
}

export const SKIP_REASON_LABEL: Record<string, string> = {
  replies_off: "Trả lời AI đang tắt cho kết nối",
  group_disabled: "Nhóm chưa được bật / chưa có đồng ý",
  group_monitor_only: "Nhóm chỉ theo dõi (không phản hồi)",
  direct_disabled: "Không trả lời chat 1-1",
  unsupported_type: "Không phải tin văn bản",
  content_not_stored: "Nội dung không được lưu (chính sách 1-1)",
  empty_question: "Không có câu hỏi",
  question_too_long: "Câu hỏi quá dài",
  user_rate_limited: "Người hỏi vượt giới hạn mỗi giờ",
  conversation_daily_cap: "Hội thoại vượt giới hạn mỗi ngày",
  stale: "Câu hỏi đã quá cũ",
  sender_blocked: "Người gửi bị chặn",
  unlinked: "Người hỏi chưa liên kết tài khoản",
  asker_inactive: "Tài khoản liên kết bị khóa",
  pipeline_error: "Lỗi xử lý",
  max_attempts: "Lỗi xử lý (đã thử 3 lần)",
  channel_disabled: "Trợ lý cho Zalo cá nhân đang tắt",
};
