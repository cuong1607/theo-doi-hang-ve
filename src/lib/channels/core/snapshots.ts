// ============================================================
// PHASE SHOPEE-2: raw provider snapshot storage.
//
// saveLatestChannelSnapshot — LATEST-ONLY retention, for catalog data
// (product / model) ONLY: keeps exactly one row per
// (shop, entity_type, entity_external_id, api_name). An identical payload
// (same sha-256) just refreshes synced_at; a changed one replaces the old row.
//
// Do NOT use this for escrow / income / payout / return payloads: those are
// financial audit records and must keep history (docs "Snapshot retention").
// ============================================================
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SourceMode } from "./types.ts";

const LATEST_ONLY_ENTITY_TYPES = new Set(["product", "model"]);

/** Stable JSON (sorted keys) so key order never changes the hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export async function saveLatestChannelSnapshot(
  db: SupabaseClient,
  input: {
    shopId: string;
    entityType: "product" | "model";
    entityExternalId: string;
    apiName: string;
    payload: unknown;
    sourceMode: SourceMode;
    sourceUpdatedAt?: string | null;
    syncedAt: string;
  },
): Promise<"inserted" | "unchanged"> {
  if (!LATEST_ONLY_ENTITY_TYPES.has(input.entityType)) {
    throw new Error(`saveLatestChannelSnapshot chỉ dùng cho dữ liệu catalog, không dùng cho ${input.entityType}.`);
  }
  const hash = payloadHash(input.payload);
  const key = { shop_id: input.shopId, entity_type: input.entityType, entity_external_id: input.entityExternalId, api_name: input.apiName };

  const { data: existing, error: readError } = await db
    .from("channel_api_snapshots")
    .select("id, payload_hash")
    .match(key)
    .order("synced_at", { ascending: false });
  if (readError) throw new Error(`Không đọc được snapshot: ${readError.message}`);
  const rows = (existing ?? []) as Array<{ id: string; payload_hash: string | null }>;

  if (rows[0]?.payload_hash === hash) {
    await db.from("channel_api_snapshots").update({ synced_at: input.syncedAt }).eq("id", rows[0].id);
    const stale = rows.slice(1).map((r) => r.id);
    if (stale.length) await db.from("channel_api_snapshots").delete().in("id", stale);
    return "unchanged";
  }

  const { data: inserted, error } = await db
    .from("channel_api_snapshots")
    .insert({
      ...key,
      payload: input.payload,
      payload_hash: hash,
      source_mode: input.sourceMode,
      source_updated_at: input.sourceUpdatedAt ?? null,
      synced_at: input.syncedAt,
    })
    .select("id")
    .single();
  if (error || !inserted) throw new Error(`Không lưu được snapshot: ${error?.message ?? "unknown"}`);
  const stale = rows.map((r) => r.id);
  if (stale.length) await db.from("channel_api_snapshots").delete().in("id", stale);
  return "inserted";
}
