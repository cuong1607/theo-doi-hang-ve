// ============================================================
// ZP-05: raw zca-js events → NormalizedEvent.
//
// Input is treated as UNTRUSTED `unknown`: zca-js payloads are reverse
// engineered and change between versions, so every field is checked here and
// nothing downstream touches a raw object. Pure: no I/O, `now` injected.
//
// Shapes read (zca-js 2.4.0, dist/models/*.d.ts):
//   message      { type: 0|1 (ThreadType.User|Group), threadId, isSelf,
//                  data: { msgId, cliMsgId, uidFrom, msgType, ts, content, mentions? } }
//   undo         { threadId, isSelf, isGroup, data: { uidFrom, content: { globalMsgId? } } }
//   reaction     { threadId, isSelf, isGroup, data: { uidFrom, msgId, content: { rIcon? } } }
//   group_event  { type: <GroupEventType string>, threadId, isSelf }
// ============================================================
import { CHANNEL, type ConversationType, type Mention, type MessageType, type NormalizeResult, type RejectReason } from "./types.ts";

const ZALO_ID = /^[0-9]{1,32}$/;
const MESSAGE_ID = /^[0-9A-Za-z_-]{1,64}$/;
export const MAX_TEXT_LENGTH = 4000;
const MAX_MENTIONS = 50;
/** Earliest plausible provider timestamp (2015-01-01) and max clock skew into the future. */
const MIN_TS_MS = Date.UTC(2015, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export type RawEventName = "message" | "undo" | "reaction" | "group_event";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

const reject = (reason: RejectReason): NormalizeResult => ({ ok: false, reason });

function threadOf(raw: Obj, isGroup: boolean): { ok: true; id: string; type: ConversationType } | { ok: false; reason: RejectReason } {
  const id = str(raw.threadId);
  if (!id) return { ok: false, reason: "missing_thread_id" };
  if (!ZALO_ID.test(id) || id === "0") return { ok: false, reason: "invalid_thread_id" };
  return { ok: true, id, type: isGroup ? "group" : "direct" };
}

/** Provider ts is milliseconds as a string (sometimes seconds): null when implausible. */
export function parseProviderTimestamp(value: unknown, now: Date): Date | null {
  const s = str(value);
  if (!s || !/^[0-9]{10,16}$/.test(s)) return null;
  const n = Number(s);
  const ms = s.length <= 10 ? n * 1000 : n;
  if (ms < MIN_TS_MS || ms > now.getTime() + MAX_FUTURE_SKEW_MS) return null;
  return new Date(ms);
}

/** Best-effort mapping of zca-js `msgType` (⚠ values observed in community code; verify on real events). */
export function classifyMessage(msgType: string | null, content: unknown): MessageType {
  if (typeof content === "string") return "text";
  const t = (msgType ?? "").toLowerCase();
  if (t.includes("photo") || t.includes("image")) return "image";
  if (t.includes("sticker")) return "sticker";
  if (t.includes("video")) return "video";
  if (t.includes("voice")) return "voice";
  if (t.includes("file") || t.includes("doc")) return "file";
  if (t.includes("link") || t.includes("recommended")) return "link";
  if (t.includes("location")) return "location";
  return "other";
}

function parseMentions(raw: unknown, textLength: number): Mention[] {
  if (!Array.isArray(raw)) return [];
  const out: Mention[] = [];
  for (const m of raw.slice(0, MAX_MENTIONS)) {
    if (!isObj(m)) continue;
    const uid = str(m.uid);
    const pos = typeof m.pos === "number" ? m.pos : Number.NaN;
    const len = typeof m.len === "number" ? m.len : Number.NaN;
    if (!uid || !ZALO_ID.test(uid)) continue;
    if (!Number.isInteger(pos) || !Number.isInteger(len) || pos < 0 || len < 0 || pos + len > textLength) continue;
    out.push({ uid, pos, len, kind: m.type === 1 ? "all" : "user" });
  }
  return out;
}

export function normalizeEvent(name: RawEventName, raw: unknown, ctx: { connectionId: string; now: Date }): NormalizeResult {
  if (!isObj(raw)) return reject("malformed");
  switch (name) {
    case "message":
      return normalizeMessage(raw, ctx);
    case "undo":
    case "reaction":
      return normalizeMessageSignal(name, raw, ctx);
    case "group_event":
      return normalizeGroupEvent(raw, ctx);
    default:
      return reject("unsupported_event");
  }
}

function normalizeMessage(raw: Obj, ctx: { connectionId: string; now: Date }): NormalizeResult {
  if (raw.type !== 0 && raw.type !== 1) return reject("unsupported_event");
  const data = raw.data;
  if (!isObj(data)) return reject("malformed");
  const thread = threadOf(raw, raw.type === 1);
  if (!thread.ok) return reject(thread.reason);

  const messageId = str(data.msgId);
  if (!messageId) return reject("missing_message_id");
  if (!MESSAGE_ID.test(messageId)) return reject("invalid_message_id");

  const sender = str(data.uidFrom);
  if (!sender) return reject("missing_sender");
  if (!ZALO_ID.test(sender) || sender === "0") return reject("invalid_sender");

  const issues: string[] = [];
  const content = data.content;
  let text: string | null = null;
  if (typeof content === "string") {
    text = content.length > MAX_TEXT_LENGTH ? content.slice(0, MAX_TEXT_LENGTH) : content;
    if (content.length > MAX_TEXT_LENGTH) issues.push("text_truncated");
  }
  const sentAt = parseProviderTimestamp(data.ts, ctx.now);
  if (!sentAt) issues.push("invalid_timestamp");

  return {
    ok: true,
    event: {
      kind: "message",
      channel: CHANNEL,
      connectionId: ctx.connectionId,
      conversationId: thread.id,
      conversationType: thread.type,
      externalMessageId: messageId,
      senderExternalId: sender,
      text,
      messageType: classifyMessage(str(data.msgType), content),
      mentions: thread.type === "group" && text !== null ? parseMentions(data.mentions, text.length) : [],
      isSelf: raw.isSelf === true,
      sentAt,
      receivedAt: ctx.now,
      issues,
    },
  };
}

function normalizeMessageSignal(kind: "undo" | "reaction", raw: Obj, ctx: { connectionId: string; now: Date }): NormalizeResult {
  const data = isObj(raw.data) ? raw.data : null;
  if (!data) return reject("malformed");
  const thread = threadOf(raw, raw.isGroup === true);
  if (!thread.ok) return reject(thread.reason);
  const sender = str(data.uidFrom);
  const content = isObj(data.content) ? data.content : null;
  const ref = kind === "undo" ? str(content?.globalMsgId) : str(data.msgId);
  return {
    ok: true,
    event: {
      kind,
      channel: CHANNEL,
      connectionId: ctx.connectionId,
      conversationId: thread.id,
      conversationType: thread.type,
      externalMessageId: ref && MESSAGE_ID.test(ref) ? ref : null,
      senderExternalId: sender && ZALO_ID.test(sender) && sender !== "0" ? sender : null,
      isSelf: raw.isSelf === true,
      subtype: kind === "reaction" ? (str(content?.rIcon) ? "icon" : null) : null,
      receivedAt: ctx.now,
    },
  };
}

function normalizeGroupEvent(raw: Obj, ctx: { connectionId: string; now: Date }): NormalizeResult {
  const thread = threadOf(raw, true);
  if (!thread.ok) return reject(thread.reason);
  const type = str(raw.type);
  return {
    ok: true,
    event: {
      kind: "group_event",
      channel: CHANNEL,
      connectionId: ctx.connectionId,
      conversationId: thread.id,
      conversationType: "group",
      externalMessageId: null,
      senderExternalId: null,
      isSelf: raw.isSelf === true,
      subtype: type && /^[a-z_]{1,40}$/.test(type) ? type : "unknown",
      receivedAt: ctx.now,
    },
  };
}

/** Stable key for duplicate detection (redelivery / reconnect replays). */
export function dedupeKey(event: { kind: string; conversationType: string; conversationId: string; externalMessageId: string | null; subtype?: string | null; senderExternalId: string | null }): string | null {
  if (!event.externalMessageId) return null;
  return [event.kind, event.conversationType, event.conversationId, event.externalMessageId, event.senderExternalId ?? "", event.subtype ?? ""].join(":");
}
