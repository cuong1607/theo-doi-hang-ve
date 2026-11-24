// ============================================================
// ZALO PERSONAL Phase 03 — dashboard API inputs (zod, pure). Every list is
// bounded; ids are uuids; free text is trimmed and length-capped. Search
// text travels in a POST body (never in the URL query string).
// ============================================================
import { z } from "zod";

const uuid = z.uuid();
const zaloId = z.string().regex(/^[0-9]{1,32}$/);
const optionalUuid = z.preprocess((v) => (v === "" || v === "all" ? undefined : v), uuid.optional());
const intIn = (min: number, max: number, fallback: number) =>
  z.preprocess((v) => (v === undefined || v === "" ? fallback : Number(v)), z.number().int().min(min).max(max));

export const MESSAGE_TYPES = ["text", "image", "sticker", "video", "voice", "file", "link", "location", "other"] as const;
export const GROUP_MODES = ["disabled", "monitor", "mention_only", "interactive"] as const;

/** Max search window and result size (no unbounded query). */
export const SEARCH_MAX_DAYS = 92;
export const SEARCH_MAX_RESULTS = 100;
export const PAGE_MAX = 100;

export const listGroupsQuery = z
  .object({
    connectionId: optionalUuid,
    mode: z.preprocess((v) => (v === "" || v === "all" ? undefined : v), z.enum(GROUP_MODES).optional()),
    page: intIn(1, 10_000, 1),
    size: intIn(1, PAGE_MAX, 25),
  })
  .strict();

export const listConversationsQuery = z
  .object({
    connectionId: optionalUuid,
    type: z.preprocess((v) => (v === "" || v === "all" ? undefined : v), z.enum(["user", "group"]).optional()),
    groupId: optionalUuid,
    name: z.preprocess((v) => (typeof v === "string" ? v.trim() || undefined : v), z.string().max(100).optional()),
    page: intIn(1, 10_000, 1),
    size: intIn(1, PAGE_MAX, 25),
  })
  .strict();

export const listMessagesQuery = z
  .object({
    beforeAt: z.preprocess((v) => (v === "" ? undefined : v), z.iso.datetime({ offset: true }).optional()),
    beforeId: optionalUuid,
    limit: intIn(1, PAGE_MAX, 30),
  })
  .strict()
  .refine((q) => (q.beforeAt === undefined) === (q.beforeId === undefined), { message: "beforeAt và beforeId phải đi cùng nhau", path: ["beforeId"] });

export const searchBody = z
  .object({
    text: z.preprocess((v) => (typeof v === "string" ? v.trim() || undefined : v), z.string().min(2).max(200).optional()),
    conversationId: optionalUuid,
    senderId: z.preprocess((v) => (v === "" ? undefined : v), zaloId.optional()),
    messageType: z.preprocess((v) => (v === "" || v === "all" ? undefined : v), z.enum(MESSAGE_TYPES).optional()),
    /** inclusive day, Asia/Ho_Chi_Minh (YYYY-MM-DD) */
    from: z.iso.date(),
    to: z.iso.date(),
    limit: intIn(1, SEARCH_MAX_RESULTS, 50),
  })
  .strict()
  .refine((b) => b.from <= b.to, { message: "Ngày bắt đầu phải trước ngày kết thúc", path: ["from"] })
  .refine((b) => vnDayRange(b.from, b.to).days <= SEARCH_MAX_DAYS, { message: `Khoảng thời gian tối đa ${SEARCH_MAX_DAYS} ngày`, path: ["to"] });

export const updateGroupBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_mode"), mode: z.enum(GROUP_MODES) }).strict(),
  z.object({ action: z.literal("grant_consent"), note: z.string().trim().min(3).max(500), confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal("withdraw_consent"), note: z.string().trim().max(500).optional() }).strict(),
]);

export const grantBody = z
  .object({
    granteeUserId: uuid,
    scope: z.enum(["connection", "conversation"]),
    conversationId: uuid.optional(),
    level: z.enum(["sync", "read", "manage"]),
    note: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((b) => (b.scope === "conversation") === (b.conversationId !== undefined), { message: "conversationId chỉ dùng (và bắt buộc) cho quyền theo hội thoại", path: ["conversationId"] })
  .refine((b) => b.scope === "connection" || b.level === "read", { message: "Quyền theo hội thoại chỉ có mức xem", path: ["level"] });

export const syncEventsQuery = z
  .object({
    page: intIn(1, 1000, 1),
    size: intIn(1, PAGE_MAX, 25),
  })
  .strict();

export const idParam = uuid;

/** "a: msg; b: msg" — field paths and messages only, never the input values. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** Escapes LIKE wildcards so user text matches literally. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const VN_OFFSET_MS = 7 * 3600_000; // Asia/Ho_Chi_Minh: UTC+7, no DST

/** [from 00:00, to+1 00:00) in Asia/Ho_Chi_Minh as UTC instants. */
export function vnDayRange(from: string, to: string): { start: Date; end: Date; days: number } {
  const start = new Date(Date.parse(`${from}T00:00:00Z`) - VN_OFFSET_MS);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) - VN_OFFSET_MS + 86_400_000);
  return { start, end, days: Math.round((end.getTime() - start.getTime()) / 86_400_000) };
}

/** Start of "today" in Asia/Ho_Chi_Minh. */
export function vnStartOfDay(now: Date = new Date()): Date {
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - VN_OFFSET_MS);
}

/** YYYY-MM-DD of a day in Asia/Ho_Chi_Minh. */
export function vnDate(d: Date = new Date()): string {
  return new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}
