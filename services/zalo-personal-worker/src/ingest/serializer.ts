// ============================================================
// NormalizedEvent → wire event (contract: src/lib/zalo-personal/contracts.ts).
//
// eventKey = sha256 of the event IDENTITY (connection, kind, conversation,
// Zalo message id, sender, subtype). It is the same for every delivery of
// the same event — across retries, reconnect replays and worker restarts —
// so the database stores it once. Never derived from text or time, except
// for id-less group events (receive time is their only identity).
//
// Data minimization happens HERE, before anything is written to the outbox:
// 1-1 text is dropped unless ZP_DIRECT_MESSAGES=content (the server enforces
// its own policy on top). Display names / raw payloads are never present.
// ============================================================
import { createHash } from "node:crypto";

import type { DirectMessageMode } from "../config.ts";
import type { NormalizedEvent } from "../types.ts";

export type WireKind = "message" | "undo" | "reaction" | "group_event" | "group_discovery";

export interface WireEvent {
  eventKey: string;
  kind: WireKind;
  conversationType: "user" | "group";
  conversationId: string;
  externalMessageId: string | null;
  senderId: string | null;
  messageType: string | null;
  text: string | null;
  textLength: number;
  mentions: Array<{ uid: string; pos: number; len: number; kind: "user" | "all" }>;
  mentionsSelf: boolean;
  isSelf: boolean;
  subtype: string | null;
  sentAt: string | null;
  receivedAt: string;
}

export function eventKey(parts: Array<string | null>): string {
  return createHash("sha256").update(["zp1", ...parts.map((p) => p ?? "")].join("|"), "utf8").digest("hex");
}

export function toWireEvent(event: NormalizedEvent, ctx: { ownId: string | null; directMessages: DirectMessageMode }): WireEvent {
  const conversationType = event.conversationType === "direct" ? "user" : "group";
  if (event.kind === "message") {
    const keepText = conversationType === "group" || ctx.directMessages === "content";
    return {
      eventKey: eventKey([event.connectionId, "message", conversationType, event.conversationId, event.externalMessageId, event.senderExternalId]),
      kind: "message",
      conversationType,
      conversationId: event.conversationId,
      externalMessageId: event.externalMessageId,
      senderId: event.senderExternalId,
      messageType: event.messageType,
      text: keepText ? event.text : null,
      textLength: event.text?.length ?? 0,
      mentions: event.mentions.map((m) => ({ uid: m.uid, pos: m.pos, len: m.len, kind: m.kind })),
      mentionsSelf: ctx.ownId !== null && event.mentions.some((m) => m.uid === ctx.ownId),
      isSelf: event.isSelf,
      subtype: null,
      sentAt: event.sentAt?.toISOString() ?? null,
      receivedAt: event.receivedAt.toISOString(),
    };
  }
  const idless = event.externalMessageId === null;
  return {
    eventKey: eventKey([event.connectionId, event.kind, conversationType, event.conversationId, event.externalMessageId, event.senderExternalId, event.subtype, idless ? String(event.receivedAt.getTime()) : null]),
    kind: event.kind,
    conversationType,
    conversationId: event.conversationId,
    externalMessageId: event.externalMessageId,
    senderId: event.senderExternalId,
    messageType: null,
    text: null,
    textLength: 0,
    mentions: [],
    mentionsSelf: false,
    isSelf: event.isSelf,
    subtype: event.subtype,
    sentAt: null,
    receivedAt: event.receivedAt.toISOString(),
  };
}

/** Registers a discovered group on the server (as `disabled`): id only, nothing from the message. */
export function discoveryWireEvent(connectionId: string, groupId: string, at: Date): WireEvent {
  return {
    eventKey: eventKey([connectionId, "group_discovery", "group", groupId]),
    kind: "group_discovery",
    conversationType: "group",
    conversationId: groupId,
    externalMessageId: null,
    senderId: null,
    messageType: null,
    text: null,
    textLength: 0,
    mentions: [],
    mentionsSelf: false,
    isSelf: true,
    subtype: null,
    sentAt: null,
    receivedAt: at.toISOString(),
  };
}
