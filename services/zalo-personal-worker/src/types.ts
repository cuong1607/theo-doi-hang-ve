// ============================================================
// Internal event model of the Zalo Personal connector.
//
// Everything downstream of event-normalizer.ts sees ONLY these types — never
// a raw zca-js object — so the rest of the worker does not depend on the
// library's (unofficial, frequently changing) payload shapes.
// ============================================================

export const CHANNEL = "zalo_personal" as const;
export type Channel = typeof CHANNEL;

export type ConversationType = "direct" | "group";

/** Best-effort classification of a message (see event-normalizer.ts for the mapping). */
export type MessageType = "text" | "image" | "sticker" | "video" | "voice" | "file" | "link" | "location" | "other";

export interface Mention {
  /** Zalo UID of the mentioned account. */
  uid: string;
  /** Character offset in `text`. */
  pos: number;
  len: number;
  /** zca-js TMention.type: 0 = one user, 1 = everyone (⚠ verify on a real event). */
  kind: "user" | "all";
}

export interface NormalizedMessage {
  kind: "message";
  channel: Channel;
  connectionId: string;
  conversationId: string;
  conversationType: ConversationType;
  externalMessageId: string;
  senderExternalId: string;
  /** Only for plain-text messages; null for attachments / stickers / others. Never persisted in Phase 01. */
  text: string | null;
  messageType: MessageType;
  mentions: Mention[];
  isSelf: boolean;
  /** null when the provider timestamp is missing or implausible (see `issues`). */
  sentAt: Date | null;
  receivedAt: Date;
  /** Non-fatal problems found while normalizing (e.g. "invalid_timestamp"). */
  issues: string[];
}

export type SignalKind = "undo" | "reaction" | "group_event";

/** Non-message events: kept as metadata only. */
export interface NormalizedSignal {
  kind: SignalKind;
  channel: Channel;
  connectionId: string;
  conversationId: string;
  conversationType: ConversationType;
  /** The message the signal refers to, when the payload carries one. */
  externalMessageId: string | null;
  senderExternalId: string | null;
  isSelf: boolean;
  /** e.g. the group event type ("join", "leave", …) or the reaction icon category. */
  subtype: string | null;
  receivedAt: Date;
}

export type NormalizedEvent = NormalizedMessage | NormalizedSignal;

export type RejectReason =
  | "malformed"
  | "unsupported_event"
  | "missing_thread_id"
  | "invalid_thread_id"
  | "missing_message_id"
  | "invalid_message_id"
  | "missing_sender"
  | "invalid_sender"
  /** an id arrived as a JS number beyond 2^53 (precision already lost) */
  | "unsafe_numeric_id";

export type NormalizeResult = { ok: true; event: NormalizedEvent } | { ok: false; reason: RejectReason };
