// ============================================================
// PHASE 04.5 — REPLY-03 / REPLY-04 policy: which pipeline answers, what may
// be published to whom, when a reply may skip approval, who may review.
// Pure (no I/O).
//
// Publication rules (the reader of a reply is the AUDIENCE, not only the asker):
//   private (1-1)  everything the ASKER may see (Phase 05 role + screen
//                  permissions; Phase 04 conversation scope)
//   group          Phase 05: knowledge tools only (AUDIENCE_ALLOWS.group) —
//                  never business figures, even for an admin asker;
//                  Phase 04 memory: ONLY messages of this same group
// A draft that cites anything outside these rules is blocked, not sent.
// ============================================================
import { hasPermission, type Permission, type Role } from "../auth/permissions.ts";
import { foldVi } from "../ai-assistant/text.ts";
import type { AssistantResponse, Sensitivity } from "../ai-system/types.ts";
import { can, canUseModule, type AccessScope } from "../zalo-personal/dashboard/access.ts";
import { MAX_REPLY_CHARS } from "./config.ts";

export type Pipeline = "system" | "memory";
export type DraftKind = "ai_answer" | "link_help" | "link_result" | "notice";

export interface DraftCitation {
  ref: string;
  label: string;
  detail: string | null;
  href: string | null;
}

export interface DraftPayload {
  kind: DraftKind;
  pipeline: Pipeline | "none";
  text: string;
  citations: DraftCitation[];
  caveats: string[];
  responseStatus: string | null;
  model: string | null;
  requiredPermissions: string[];
  askerUserId: string | null;
  autoApprove: boolean;
}

// ------------------------------------------------------------------ routing

const MEMORY_HINTS = [
  "tom tat", "trong nhom", "nhom minh", "nhom nay", "ai noi", "ai da noi", "ai bao", "da chot", "chot gi", "chot chua", "ban gi", "noi gi",
  "nhac lai", "hom qua ban", "cuoc tro chuyen", "doan chat", "tin nhan", "da thong nhat", "ai nhan", "ai phu trach", "giao cho ai",
];

/** History of THIS conversation (Phase 04 memory) vs business data (Phase 05 tools). */
export function routeQuestion(question: string): Pipeline {
  const f = ` ${foldVi(question).replace(/\s+/g, " ")} `;
  return MEMORY_HINTS.some((h) => f.includes(` ${h} `) || f.includes(` ${h}?`) || f.includes(` ${h},`)) ? "memory" : "system";
}

// ------------------------------------------------------------------ text

/** Plain text for Zalo: no markup, no control characters, bounded. */
export function sanitizeReply(text: string, max = MAX_REPLY_CHARS): string {
  let t = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<[^>]{0,200}>/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length > max) t = `${t.slice(0, max - 1).trimEnd()}…`;
  return t;
}

const vnTime = (iso: string) => {
  const d = new Date(Date.parse(iso) + 7 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
};

export type PublishBlock = "audience_sensitivity" | "foreign_conversation" | "empty";

/** Phase 05 response → draft. `sensitivityOf` / `permissionsOf` come from the tool registry. */
export function systemDraft(
  r: AssistantResponse,
  audience: "private" | "group",
  sensitivityOf: (tool: string) => Sensitivity | null,
  permissionsOf: (tool: string) => readonly string[],
): { ok: true; text: string; citations: DraftCitation[]; caveats: string[]; requiredPermissions: string[] } | { ok: false; block: PublishBlock } {
  const used = r.sources.map((s) => s.tool);
  if (audience === "group" && used.some((t) => sensitivityOf(t) !== "knowledge")) return { ok: false, block: "audience_sensitivity" };
  const lines: string[] = [];
  if (r.answer) lines.push(r.answer);
  for (const p of r.points) lines.push(`• ${p.text}${p.sourceIds.length ? ` [${p.sourceIds.join(", ")}]` : ""}`);
  if (r.sources.length) lines.push(`Nguồn: ${r.sources.map((s) => `[${s.id}] ${s.label} (${s.coverage}${s.dataUpdatedAt ? `, cập nhật ${vnTime(s.dataUpdatedAt)}` : ""})`).join("; ")}`);
  for (const c of r.caveats.slice(0, 3)) lines.push(`Lưu ý: ${c}`);
  const text = sanitizeReply(lines.join("\n"));
  if (!text) return { ok: false, block: "empty" };
  const perms = new Set<string>(["ai_system:use"]);
  for (const t of new Set(r.tools.filter((x) => x.outcome === "ok" || x.outcome === "empty").map((x) => x.name))) for (const p of permissionsOf(t)) perms.add(p);
  return {
    ok: true,
    text,
    citations: r.sources.map((s) => ({ ref: s.id, label: s.label, detail: s.coverage, href: s.href })),
    caveats: r.caveats.slice(0, 10),
    requiredPermissions: [...perms],
  };
}

export interface MemoryCitationInput {
  messageId: string;
  conversationId: string;
  senderLabel: string;
  at: string;
  snippet: string | null;
  href: string;
}

export interface MemoryAnswerInput {
  status: string;
  answer: string | null;
  points: Array<{ text: string; citations: MemoryCitationInput[] }>;
  warnings: string[];
}

export const MEMORY_NOT_FOUND = "Mình chưa tìm thấy thông tin này trong các tin nhắn đã lưu của cuộc trò chuyện này.";
export const MEMORY_AI_UNAVAILABLE = "Hiện AI chưa xử lý được câu hỏi này (AI tắt, hết hạn mức hoặc chính sách dữ liệu không cho phép), nên mình chưa trả lời được. Bạn xem trực tiếp trên hệ thống nhé.";

/** Phase 04 answer → draft. Every cited message must belong to THIS conversation. */
export function memoryDraft(a: MemoryAnswerInput, conversationId: string): { ok: true; text: string; citations: DraftCitation[]; caveats: string[]; requiredPermissions: string[] } | { ok: false; block: PublishBlock } {
  const cited = a.points.flatMap((p) => p.citations);
  if (cited.some((c) => c.conversationId !== conversationId)) return { ok: false, block: "foreign_conversation" };
  const answered = a.status === "answered" && a.points.length > 0;
  const lines: string[] = [];
  if (a.status === "sources_only") lines.push(MEMORY_AI_UNAVAILABLE);
  else if (!answered) lines.push(MEMORY_NOT_FOUND);
  else {
    if (a.answer) lines.push(a.answer);
    for (const p of a.points) lines.push(`• ${p.text}${p.citations.length ? ` (tin lúc ${p.citations.map((c) => vnTime(c.at)).join(", ")})` : ""}`);
  }
  for (const w of a.warnings.slice(0, 2)) lines.push(`Lưu ý: ${w}`);
  const text = sanitizeReply(lines.join("\n"));
  const seen = new Set<string>();
  const citations: DraftCitation[] = [];
  for (const c of cited) {
    if (seen.has(c.messageId)) continue;
    seen.add(c.messageId);
    citations.push({ ref: vnTime(c.at), label: c.senderLabel, detail: c.snippet, href: c.href });
  }
  return { ok: true, text, citations: citations.slice(0, 30), caveats: a.warnings.slice(0, 10), requiredPermissions: ["zalo_personal:ai"] };
}

export const REPLY_TEXT = {
  unlinkedHelp:
    "Chào bạn, tài khoản Zalo này chưa được liên kết với tài khoản CONGTRANGBEDDING nên mình chưa thể tra cứu dữ liệu. Hãy đăng nhập hệ thống, vào Zalo cá nhân → Trả lời AI → Cài đặt để tạo mã, rồi gửi “LINK <mã>” vào cuộc trò chuyện này.",
  inactive: "Tài khoản CONGTRANGBEDDING được liên kết với Zalo này đã bị khóa hoặc không còn quyền, nên mình không thể tra cứu dữ liệu.",
  linked: "Đã liên kết tài khoản Zalo này với tài khoản CONGTRANGBEDDING của bạn. Từ giờ bạn có thể hỏi trợ lý tại đây.",
  linkInvalid: "Mã liên kết không hợp lệ hoặc đã hết hạn. Hãy tạo mã mới trên hệ thống (mã dùng một lần, hạn 10 phút).",
  linkInactive: "Tài khoản CONGTRANGBEDDING tạo mã này đang bị khóa nên không thể liên kết.",
  groupDenied: "Câu hỏi này cần dữ liệu nội bộ nên mình không trả lời công khai trong nhóm. Bạn hãy xem trên hệ thống CONGTRANGBEDDING.",
  memoryDenied: "Bạn chưa được cấp quyền xem lịch sử cuộc trò chuyện này trên hệ thống, nên mình không thể trả lời.",
  channelDisabled: "Trợ lý cho Zalo cá nhân đang tắt.",
} as const;

// ------------------------------------------------------------------ auto approval

export interface AutoInput {
  flagEnabled: boolean;
  replyMode: "off" | "draft_only" | "auto";
  allowlisted: boolean;
  conversationType: "user" | "group";
  groupMode: string | null;
  groupSendVerified: boolean;
  /** 1-1 sending path verified: this CONNECTION already delivered one manually approved reply (00080) */
  directVerified: boolean;
  askerLinked: boolean;
  kind: DraftKind;
  responseStatus: string | null;
}

/** 1-1 kinds that may be sent without approval: fixed templates or the linked asker's own answer. */
export const DIRECT_AUTO_KINDS: readonly DraftKind[] = ["ai_answer", "notice", "link_result"];

/**
 * May this draft skip human approval? Always: global flag + connection in
 * 'auto'. Then
 *   1-1 (00080)  a verified sending path for the connection; an AI answer only
 *                for a linked asker (any status: "not found" is still an
 *                answer); notices and LINK results (fixed templates). Never
 *                link_help (strangers are not answered in auto mode). No
 *                allowlist: a 1-1 chat only reaches here with a verified link.
 *   group        allowlisted (consent note) + interactive + send verified +
 *                linked asker + an AI answer that actually answered.
 * The DB re-checks both (store_result + claim).
 */
export function autoApproveAllowed(i: AutoInput): boolean {
  if (!i.flagEnabled || i.replyMode !== "auto") return false;
  if (i.conversationType === "user") {
    if (!i.directVerified || !DIRECT_AUTO_KINDS.includes(i.kind)) return false;
    return i.kind !== "ai_answer" || i.askerLinked;
  }
  if (!i.allowlisted || !i.askerLinked) return false;
  if (i.kind !== "ai_answer" || i.responseStatus !== "answered") return false;
  return i.groupMode === "interactive" && i.groupSendVerified;
}

// ------------------------------------------------------------------ reviewers

export interface ReviewTarget {
  connectionId: string;
  conversationType: "user" | "group";
  requiredPermissions: readonly string[];
}

/**
 * Who may see / approve a draft: connection owner (1-1 drafts: owner only, like
 * direct messages), or a manage grant for group drafts — AND the reviewer's own
 * role must hold every permission the answer's data needed (a reviewer never
 * sees figures their role could not see on screen).
 */
export function canReview(scope: AccessScope, role: Role, d: ReviewTarget): boolean {
  if (!canUseModule(role)) return false;
  const a = scope.connections.get(d.connectionId);
  if (!a) return false;
  if (d.conversationType === "user" ? !a.owner : !can(scope, d.connectionId, "manage_groups")) return false;
  return d.requiredPermissions.every((p) => hasPermission(role, p as Permission));
}

/** Settings, allowlist, blocks, pause: an ADMIN who owns the connection. */
export function canConfigure(scope: AccessScope, connectionId: string, role: Role): boolean {
  // owner decision 2026-11-26: reply settings (mode, auto, limits, allowlist, blocks,
  // pause) are ADMIN-only — a staff member owning a connection cannot change them
  // (their connection keeps the safe defaults: drafts wait for approval).
  return role === "admin" && scope.connections.get(connectionId)?.owner === true;
}
