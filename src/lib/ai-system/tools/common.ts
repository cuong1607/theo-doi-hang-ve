// ============================================================
// PHASE 05 — helpers shared by the system tools. Pure except the injected DB.
//
//   periods      the model proposes a PRESET (or two dates); the server
//                resolves it on the real clock in Asia/Ho_Chi_Minh
//                (src/lib/ai-assistant/time-range.ts — max 92 days)
//   names        a supplier / shop / invoice is given as TEXT and resolved
//                deterministically inside what the user may see — the model
//                never supplies an id, never a pattern, never SQL
//   formatting   vi-VN display strings the answer must copy verbatim
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { customPeriod, presetPeriod, PERIOD_ERROR_TEXT, type Period } from "../../ai-assistant/time-range.ts";
import { foldVi } from "../../ai-assistant/text.ts";
import type { SourceInfo, ToolOutcome, ToolResult } from "../types.ts";

// ------------------------------------------------------------------ periods

export const PERIOD_PRESETS = ["today", "yesterday", "this_week", "last_week", "last_7_days", "last_30_days", "this_month", "last_month"] as const;
export type PeriodPresetArg = (typeof PERIOD_PRESETS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const periodArg = z
  .object({
    preset: z.enum([...PERIOD_PRESETS, "custom"]).describe("Kỳ theo lịch Việt Nam. 'custom' cần from/to."),
    from: isoDate.optional().describe("YYYY-MM-DD, chỉ khi preset = custom"),
    to: isoDate.optional().describe("YYYY-MM-DD, chỉ khi preset = custom"),
  })
  .strict();
export type PeriodArg = z.infer<typeof periodArg>;

/** A real calendar day (2026-13-01 / 2026-02-30 are not). */
const isRealDay = (d: string | undefined) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

export function resolvePeriodArg(p: PeriodArg | undefined, fallback: PeriodPresetArg, now: Date): Period | { error: string } {
  if (!p) return presetPeriod(fallback, now, "default");
  if (p.preset === "custom") {
    // checked HERE: the Phase 04 customPeriod() throws a RangeError on an impossible month / day
    if (!isRealDay(p.from) || !isRealDay(p.to)) return { error: PERIOD_ERROR_TEXT.invalid_date };
    const r = customPeriod(p.from ?? "", p.to ?? "", now, "question");
    return typeof r === "string" ? { error: PERIOD_ERROR_TEXT[r] } : r;
  }
  return presetPeriod(p.preset, now, "question");
}

/** Short free text the model may pass as a NAME to look up (never a pattern). */
export const nameArg = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^%_\\*;<>{}]+$/u, "không chứa ký tự đặc biệt")
    .describe(what);

// ------------------------------------------------------------------ formatting (vi-VN, copied verbatim by the model)

const nf0 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
export const vnd = (v: unknown): string => {
  const n = num(v);
  return n === null ? "không có dữ liệu" : `${nf0.format(Math.round(n))} ₫`;
};
export const qty = (v: unknown): string => {
  const n = num(v);
  return n === null ? "không có dữ liệu" : nf2.format(n);
};
export const pct = (v: unknown, digits = 1): string => {
  const n = num(v);
  return n === null ? "—" : `${n > 0 ? "+" : ""}${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: digits }).format(n)}%`;
};
export const ratio = (v: unknown, digits = 2): string => {
  const n = num(v);
  return n === null ? "—" : new Intl.NumberFormat("vi-VN", { maximumFractionDigits: digits }).format(n);
};
export const dmy = (iso: string | null | undefined): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
export function vnDateTime(iso: string | null | undefined): string {
  if (!iso) return "chưa có";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "chưa có";
  const v = new Date(d.getTime() + 7 * 3_600_000).toISOString();
  return `${v.slice(11, 16)} ${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`;
}
export const vnToday = (now: Date) => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
export const daysSince = (date: string, now: Date) => Math.round((Date.parse(`${vnToday(now)}T00:00:00Z`) - Date.parse(`${date.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

// ------------------------------------------------------------------ result builders

export function fail(outcome: Exclude<ToolOutcome, "ok" | "empty">, message: string, scope: Record<string, unknown> = {}): ToolResult {
  return { outcome, data: null, lines: [message], source: null, rowCount: 0, caveats: [], scope, message };
}

export function done(r: { data: Record<string, unknown>; lines: string[]; source: SourceInfo; rowCount: number; caveats?: string[]; scope: Record<string, unknown>; empty?: boolean }): ToolResult {
  return { outcome: r.empty ? "empty" : "ok", data: r.data, lines: r.lines, source: r.source, rowCount: r.rowCount, caveats: r.caveats ?? [], scope: r.scope };
}

/** Read errors never leak the DB message to the user / model. */
export class ToolReadError extends Error {
  constructor(what: string, cause?: string) {
    super(`${what}${cause ? `: ${cause.slice(0, 120)}` : ""}`);
    this.name = "ToolReadError";
  }
}

// ------------------------------------------------------------------ supplier lookup

export interface SupplierRef {
  id: string;
  code: string;
  name: string;
}

export type Lookup<T> = { kind: "one"; value: T } | { kind: "none" } | { kind: "many"; values: T[] };

/** Exact code → exact name → every word of the phrase in code/name (accent-insensitive). Never a guess. */
export function matchByName<T extends { code?: string | null; name: string }>(phrase: string, candidates: readonly T[]): Lookup<T> {
  const q = foldVi(phrase).replace(/\s+/g, " ").trim();
  if (!q) return { kind: "none" };
  const exactCode = candidates.filter((c) => c.code && foldVi(c.code) === q);
  if (exactCode.length === 1) return { kind: "one", value: exactCode[0]! };
  const exactName = candidates.filter((c) => foldVi(c.name).replace(/\s+/g, " ").trim() === q);
  if (exactName.length === 1) return { kind: "one", value: exactName[0]! };
  const terms = q.split(" ").filter((t) => t.length >= 2);
  if (!terms.length) return { kind: "none" };
  const hits = candidates.filter((c) => {
    const hay = foldVi(`${c.code ?? ""} ${c.name}`);
    return terms.every((t) => hay.includes(t));
  });
  if (hits.length === 1) return { kind: "one", value: hits[0]! };
  return hits.length ? { kind: "many", values: hits } : { kind: "none" };
}

export async function findSupplier(db: SupabaseClient, phrase: string): Promise<Lookup<SupplierRef>> {
  const { data, error } = await db.from("suppliers").select("id, code, name").order("code").range(0, 999);
  if (error) throw new ToolReadError("nhà cung cấp", error.message);
  return matchByName(phrase, (data ?? []) as SupplierRef[]);
}

export function lookupFailure(kind: "none" | "many", what: string, phrase: string, values: Array<{ code?: string | null; name: string }> = []): ToolResult {
  if (kind === "none") return fail("not_found", `Không tìm thấy ${what} “${phrase}”.`, { lookup: what, found: 0 });
  const shown = values.slice(0, 5).map((v) => (v.code ? `${v.name} (${v.code})` : v.name));
  return fail("ambiguous", `Có ${values.length} ${what} khớp với “${phrase}”: ${shown.join("; ")}${values.length > 5 ? "; …" : ""}. Bạn nêu rõ mã hoặc tên đầy đủ nhé.`, { lookup: what, found: values.length });
}

/** Escapes ILIKE wildcards (same rule as src/lib/supabase/search.ts). */
export const escapeIlike = (v: string) => v.replace(/[%_\\]/g, (m) => `\\${m}`);
