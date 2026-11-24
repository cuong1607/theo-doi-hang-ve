// ============================================================
// AI ASSISTANT — SourceCitationValidator. The model's JSON is untrusted:
//   1. parse + schema-check (zod) → else invalid_response
//   2. every sourceId must be a label of THIS request's context map → the
//      message really was retrieved for this reader (ids it invents, or
//      internal ids typed into the text, resolve to nothing)
//   3. a claim with no valid source is dropped (never shown as a finding)
//   4. "answered" with nothing left → insufficient
// Visibility is re-checked again whenever a stored answer is read later.
// ============================================================
import type { ZodType } from "zod";

import type { SourceMessage } from "./context.ts";

export interface CitedClaim {
  text: string;
  messageIds: string[];
  confidence?: number;
  date?: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false };

export function parseModelJson<T>(raw: string, schema: ZodType<T>): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { ok: false };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/** Strips internal-looking ids and markup a model might echo into claim text. */
export function cleanClaimText(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
    .replace(/<[^>]{0,200}>/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function validateClaims(
  items: ReadonlyArray<{ text: string; sourceIds: string[]; confidence?: number; date?: string }>,
  labels: ReadonlyMap<string, SourceMessage>,
): { claims: CitedClaim[]; dropped: number; invalidLabels: number } {
  const claims: CitedClaim[] = [];
  let dropped = 0;
  let invalidLabels = 0;
  for (const it of items) {
    const ids: string[] = [];
    for (const l of it.sourceIds) {
      const m = labels.get(l);
      if (!m) {
        invalidLabels++;
        continue;
      }
      if (!ids.includes(m.id)) ids.push(m.id);
    }
    const text = cleanClaimText(it.text);
    if (ids.length === 0 || !text) {
      dropped++;
      continue;
    }
    const claim: CitedClaim = { text, messageIds: ids };
    if (typeof it.confidence === "number") claim.confidence = Math.round(Math.min(1, Math.max(0, it.confidence)) * 100) / 100;
    if (it.date) claim.date = it.date;
    claims.push(claim);
  }
  return { claims, dropped, invalidLabels };
}
