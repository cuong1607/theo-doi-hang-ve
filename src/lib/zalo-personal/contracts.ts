// ============================================================
// ZALO PERSONAL Phase 02 — wire contract worker → backend (zod, strict).
// Anything unknown is refused: an unexpected field never reaches the database.
// Pure (zod only).
// ============================================================
import { z } from "zod";

const zaloId = z.string().regex(/^[0-9]{1,32}$/);
const isoTime = z.iso.datetime({ offset: true });

export const EVENT_KINDS = ["message", "undo", "reaction", "group_event", "group_discovery"] as const;
export const MESSAGE_TYPES = ["text", "image", "sticker", "video", "voice", "file", "link", "location", "other"] as const;
export const MAX_EVENTS_PER_BATCH = 25;

const mention = z.object({ uid: zaloId, pos: z.number().int().min(0).max(4000), len: z.number().int().min(0).max(4000), kind: z.enum(["user", "all"]) }).strict();

export const ingestEventSchema = z
  .object({
    eventKey: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(EVENT_KINDS),
    conversationType: z.enum(["user", "group"]),
    conversationId: zaloId,
    externalMessageId: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/).nullable(),
    senderId: zaloId.nullable(),
    messageType: z.enum(MESSAGE_TYPES).nullable(),
    /** null when the worker stripped it (policy) or the message has no text */
    text: z.string().max(4000).nullable(),
    textLength: z.number().int().min(0).max(4000),
    mentions: z.array(mention).max(50),
    mentionsSelf: z.boolean(),
    isSelf: z.boolean(),
    subtype: z.string().regex(/^[a-z_]{1,40}$/).nullable(),
    sentAt: isoTime.nullable(),
    receivedAt: isoTime,
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.kind === "message" && (!e.externalMessageId || !e.senderId || !e.messageType)) {
      ctx.addIssue({ code: "custom", message: "message requires externalMessageId, senderId and messageType" });
    }
    if (e.text !== null && e.text.length !== e.textLength) ctx.addIssue({ code: "custom", path: ["textLength"], message: "textLength must equal text length" });
    if (e.kind === "group_discovery" && e.conversationType !== "group") ctx.addIssue({ code: "custom", path: ["conversationType"], message: "discovery is for groups" });
    if (e.kind !== "message" && e.text !== null) ctx.addIssue({ code: "custom", path: ["text"], message: "only messages carry text" });
  });

export type IngestEvent = z.infer<typeof ingestEventSchema>;

export const ingestBatchSchema = z
  .object({
    v: z.literal(1),
    connectionKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
    accountId: zaloId,
    events: z.array(ingestEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
  })
  .strict()
  .superRefine((b, ctx) => {
    const keys = new Set(b.events.map((e) => e.eventKey));
    if (keys.size !== b.events.length) ctx.addIssue({ code: "custom", path: ["events"], message: "duplicate eventKey in one batch" });
  });

export type IngestBatch = z.infer<typeof ingestBatchSchema>;

export const heartbeatSchema = z
  .object({
    v: z.literal(1),
    connectionKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
    /** null until the Zalo session is authenticated */
    accountId: zaloId.nullable(),
    workerVersion: z.string().regex(/^[0-9A-Za-z._-]{1,32}$/),
    workerStartedAt: isoTime,
    sessionState: z.enum(["unknown", "authenticated", "unauthenticated", "rejected"]),
    listenerState: z.enum(["unknown", "active", "connecting", "reconnecting", "inactive", "error"]),
    lastMessageReceivedAt: isoTime.nullable(),
    lastDeliveryOkAt: isoTime.nullable(),
    outboxDepth: z.number().int().min(0).max(1_000_000),
    deadLetterCount: z.number().int().min(0).max(1_000_000),
    outboxFullDrops: z.number().int().min(0).max(1_000_000_000),
    lastErrorCategory: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable(),
  })
  .strict();

export type Heartbeat = z.infer<typeof heartbeatSchema>;

export type EventResultStatus = "stored" | "recorded" | "duplicate" | "ignored" | "rejected";
export interface EventResult {
  eventKey: string;
  status: EventResultStatus;
  reason: string | null;
}

/** Issue paths only — never the offending values (they may be message text). */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
}
