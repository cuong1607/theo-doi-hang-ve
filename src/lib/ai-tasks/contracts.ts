// ============================================================
// PHASE 06 — API / page input contracts (zod, strict). Pure.
// The client never sends a user id, a role or a status to SET: only an action
// name + the revision it saw; the server decides what that action does.
// ============================================================
import { z } from "zod";

import { TASK_STATUSES } from "./lifecycle.ts";

const uuid = z.uuid();
export const idParam = uuid;
const iso = z.iso.datetime({ offset: true });
const revision = z.number().int().min(1);
const intParam = (def: number, min: number, max: number) => z.preprocess((v) => (v === undefined || v === "" ? def : Number(v)), z.number().int().min(min).max(max));
const optEnum = <T extends [string, ...string[]]>(values: T) => z.preprocess((v) => (v === "" || v === "all" ? undefined : v), z.enum(values).optional());

export const listTasksQuery = z
  .object({
    view: optEnum(["pending", "mine", "overdue"]),
    status: optEnum([...TASK_STATUSES] as [string, ...string[]]),
    conversation: z.preprocess((v) => (v === "" || v === "all" ? undefined : v), uuid.optional()),
    assignee: optEnum(["me"]),
    due: optEnum(["today", "week", "none"]),
    page: intParam(1, 1, 1000),
    size: intParam(25, 1, 100),
  })
  .strict();

const title = z.string().trim().min(1).max(300);
const description = z.string().max(2000).nullable();
const assignees = { assigneeUserIds: z.array(uuid).max(10).optional(), keepExternal: z.array(z.string().regex(/^[0-9]{1,32}$/)).max(10).optional() };

export const actionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), revision, title: title.optional(), description: description.optional(), deadlineAt: iso.nullable().optional(), ...assignees }).strict(),
  z.object({ action: z.literal("edit"), revision, title: title.optional(), description: description.optional(), deadlineAt: iso.nullable().optional(), priority: z.enum(["low", "normal", "high"]).nullable().optional(), ...assignees }).strict(),
  z.object({ action: z.enum(["dismiss", "cancel"]), revision, reason: z.string().max(300).nullable().optional() }).strict(),
  z.object({ action: z.enum(["start", "reopen", "accept_proposal", "reject_proposal"]), revision }).strict(),
  z.object({ action: z.literal("progress"), revision, progress: z.number().int().min(0).max(100), note: z.string().max(500).nullable().optional() }).strict(),
  z.object({ action: z.literal("complete"), revision, note: z.string().max(300).nullable().optional() }).strict(),
]);

export const notificationsQuery = z.object({ unread: z.preprocess((v) => v === "1" || v === "true", z.boolean()), page: intParam(1, 1, 1000), size: intParam(30, 1, 100) }).strict();

export const markReadBody = z.union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(uuid).min(1).max(200) }).strict()]);

export const preferencesBody = z
  .object({
    day_enabled: z.boolean(),
    hour_enabled: z.boolean(),
    overdue_enabled: z.boolean(),
    morning_enabled: z.boolean(),
    mention_enabled: z.boolean(),
    confirmation_enabled: z.boolean(),
    zalo_personal_enabled: z.boolean(),
    zalo_oa_enabled: z.boolean(),
  })
  .strict();

export const historyQuery = z.object({ page: intParam(1, 1, 1000), size: intParam(30, 1, 100) }).strict();
