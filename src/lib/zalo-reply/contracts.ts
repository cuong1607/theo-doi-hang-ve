// ============================================================
// PHASE 04.5 — request contracts (zod, strict: unknown keys are refused).
// ============================================================
import { z } from "zod";

import { DRAFT_STATUSES, REVIEW_ACTIONS } from "./lifecycle.ts";
import { AUTO_DIRECT_SCOPES, DIRECT_MESSAGE_MODES, REPLY_MODES } from "./store.ts";

const uuid = z.uuid();
const zaloId = z.string().regex(/^[0-9]{1,32}$/);
const connectionKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);

export const idParam = uuid;

// ---------------------------------------------------------------- worker (HMAC)
export const claimBody = z
  .object({
    v: z.literal(1),
    connectionKey,
    accountId: zaloId,
    // the worker only asks while its Zalo session is authenticated and listening
    listenerState: z.literal("active"),
  })
  .strict();

export const resultBody = z
  .object({
    v: z.literal(1),
    connectionKey,
    draftId: uuid,
    claimToken: uuid,
    outcome: z.enum(["sent", "not_sent", "failed", "unknown"]),
    zaloMsgId: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/).nullable(),
    errorCategory: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.outcome !== "sent" && b.zaloMsgId !== null) ctx.addIssue({ code: "custom", path: ["zaloMsgId"], message: "only a sent reply has a message id" });
  });

// ---------------------------------------------------------------- dashboard
export const listQuery = z
  .object({
    status: z.enum(["review", "outbound", "all", ...DRAFT_STATUSES]).default("review"),
    connectionId: uuid.optional(),
  })
  .strict();

export const actionBody = z
  .object({
    action: z.enum(REVIEW_ACTIONS),
    version: z.number().int().min(1),
    text: z.string().min(1).max(1800).optional(),
    note: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.action === "edit" && !b.text?.trim()) ctx.addIssue({ code: "custom", path: ["text"], message: "text required" });
    if (b.action !== "edit" && b.text !== undefined) ctx.addIssue({ code: "custom", path: ["text"], message: "text only for edit" });
  });

export const settingsBody = z
  .object({
    connectionId: uuid,
    replyMode: z.enum(REPLY_MODES).optional(),
    sendEnabled: z.boolean().optional(),
    autoDirect: z.enum(AUTO_DIRECT_SCOPES).optional(),
    autoGroups: z.boolean().optional(),
    directEnabled: z.boolean().optional(),
    unlinkedHelp: z.boolean().optional(),
    cooldownSeconds: z.number().int().min(5).max(3600).optional(),
    perUserPerHour: z.number().int().min(1).max(100).optional(),
    perGroupPerHour: z.number().int().min(1).max(200).optional(),
    dailySendLimit: z.number().int().min(1).max(500).optional(),
    maxPerConversationPerDay: z.number().int().min(1).max(200).optional(),
    draftTtlMinutes: z.number().int().min(5).max(1440).optional(),
  })
  .strict();

export const controlBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause_sending"), connectionId: uuid }).strict(),
  z.object({ action: z.literal("resume_sending"), connectionId: uuid, note: z.string().max(300).optional() }).strict(),
  z.object({ action: z.literal("allow_conversation"), connectionId: uuid, conversationId: uuid, note: z.string().trim().min(3).max(300) }).strict(),
  z.object({ action: z.literal("disallow_conversation"), connectionId: uuid, conversationId: uuid }).strict(),
  z.object({ action: z.literal("block_user"), connectionId: uuid, externalUserId: zaloId, note: z.string().max(300).optional() }).strict(),
  z.object({ action: z.literal("unblock_user"), connectionId: uuid, externalUserId: zaloId }).strict(),
  // which 1-1 texts the server keeps (PHASE 07: 'linked' = only chats of linked people + LINK commands)
  z.object({ action: z.literal("set_direct_mode"), connectionId: uuid, directMessageMode: z.enum(DIRECT_MESSAGE_MODES) }).strict(),
  z.object({ action: z.literal("emergency_stop"), note: z.string().max(300).optional() }).strict(),
  z.object({ action: z.literal("emergency_resume"), note: z.string().max(300).optional() }).strict(),
]);

export type ControlInput = z.infer<typeof controlBody>;
export type SettingsInput = z.infer<typeof settingsBody>;
export type ActionInput = z.infer<typeof actionBody>;
