// ============================================================
// ZALO PERSONAL Phase 04 — Ask AI API inputs (zod, pure). Question text and
// filters travel in POST bodies, never in the URL.
// ============================================================
import { z } from "zod";

const uuid = z.uuid();
const period = z
  .object({
    preset: z.enum(["today", "yesterday", "this_week", "last_week", "last_7_days", "last_30_days", "this_month", "last_month", "custom"]),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .strict()
  .refine((p) => p.preset !== "custom" || (p.from !== undefined && p.to !== undefined), { message: "Khoảng tùy chọn cần ngày bắt đầu và kết thúc", path: ["from"] });

export const askBody = z
  .object({
    sessionId: uuid.optional(),
    question: z.string().trim().min(3).max(500),
    /** empty / missing = every conversation the user may read (optionally one connection) */
    conversationIds: z.array(uuid).max(10).optional(),
    connectionId: uuid.optional(),
    period: period.optional(),
  })
  .strict();
export type AskBody = z.infer<typeof askBody>;

export const summarizeBody = z
  .object({
    conversationId: uuid,
    kind: z.enum(["daily", "conversation", "topic", "decision"]),
    topic: z.string().trim().min(2).max(100).optional(),
    period: period.optional(),
    /** regenerate even if an identical fresh summary exists (still budgeted) */
    force: z.boolean().optional(),
  })
  .strict()
  .refine((b) => (b.kind === "topic") === (b.topic !== undefined), { message: "Chủ đề chỉ dùng (và bắt buộc) cho tóm tắt theo chủ đề", path: ["topic"] });
export type SummarizeBody = z.infer<typeof summarizeBody>;

export const reviewFactBody = z.object({ evidence: z.enum(["user_confirmed", "user_rejected"]) }).strict();

export const sessionsQuery = z.object({ limit: z.preprocess((v) => (v === undefined || v === "" ? 20 : Number(v)), z.number().int().min(1).max(50)) }).strict();
