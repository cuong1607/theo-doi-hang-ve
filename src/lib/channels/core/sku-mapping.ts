// ============================================================
// PHASE SHOPEE-2: channel sellable unit → internal product mapping
// (channel-agnostic business logic; works on canonical tables only).
//
// Identity vs aid: a channel unit is identified by (shop, item id, model id).
// The SKU string is only a MATCHING AID for the first, automatic mapping —
// once mapped, internal_product_id is the source of truth.
//
// Auto-match rule (conservative, exact):
//   normalizeSku = trim outer whitespace + lower-case (internal SKUs are
//   lower-case snake_case; Shopee sellers often type them upper-case). Nothing
//   else: no symbol stripping, no fuzzy/similar match, no name match.
//   Candidates = ACTIVE internal products. 1 match → auto_mapped,
//   0 → unmapped, ≥2 (e.g. "ABC" and "abc" both exist) → mapping_conflict.
//   Only unmapped / mapping_conflict rows are ever touched; manual_mapped and
//   existing auto_mapped rows are never overwritten.
//
// Stability: if the channel SKU of an auto_mapped unit later stops matching
// its product's SKU, the mapping is KEPT and mapping_review_required is set.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

/** Outer whitespace trimmed by normalizeSku — the SAME set as SQL normalize_channel_sku() (migration 00046). */
const SKU_TRIM = /^[ \t\n\r\v\f ﻿]+|[ \t\n\r\v\f ﻿]+$/g;

export function normalizeSku(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(SKU_TRIM, "");
  return trimmed === "" ? null : trimmed.toLowerCase();
}

export interface AutoMapResult {
  scanned: number;
  mapped: number;
  unmapped: number;
  conflicts: number;
  /** Units of the shop not considered (already mapped, manual, removed). */
  skipped: number;
  /** Order lines whose NULL product snapshot was filled by the new mappings. */
  orderLinesBackfilled: number;
  /** Orders whose COGS could not be (re)computed within the time budget — "Tính COGS còn thiếu" catches up. */
  cogsPendingOrders: number;
}

/** A database call of the mapping flow failed — carries the safe Postgres details for server logs. */
export class MappingDbError extends Error {
  readonly operation: string;
  readonly postgresCode: string | null;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(operation: string, error: { code?: string; message?: string; details?: string | null; hint?: string | null }) {
    super(`${operation}: ${error.message ?? "lỗi cơ sở dữ liệu"}`);
    this.name = "MappingDbError";
    this.operation = operation;
    this.postgresCode = error.code ?? null;
    this.details = error.details ?? null;
    this.hint = error.hint ?? null;
  }
}

/** COGS recomputation after mapping stops starting new orders after this long (the rest stays "chưa tính"). */
const COGS_AFTER_MAPPING_BUDGET_MS = 15_000;

/**
 * Bulk exact-SKU auto-mapping for one shop ("Tự động ghép SKU").
 * DATABASE ONLY: reads the catalog product sync already stored and maps it
 * in one set-based RPC (auto_map_channel_models, migration 00046) — never
 * calls the Shopee API, so it works with Shopee offline and in seconds for
 * thousands of units. Newly mapped order lines are then costed (bounded).
 */
export async function autoMapChannelModels(
  db: SupabaseClient,
  shopId: string,
  now: Date = new Date(),
  options: { cogsBudgetMs?: number } = {},
): Promise<AutoMapResult> {
  const { data, error } = await db
    .rpc("auto_map_channel_models", { p_shop_id: shopId, p_now: now.toISOString() })
    .single<{ scanned: number; mapped: number; unmapped: number; conflicts: number; skipped: number; order_lines_backfilled: number; affected_order_ids: string[] | null }>();
  if (error || !data) throw new MappingDbError("auto_map_channel_models", error ?? { message: "không có kết quả" });

  // SHOPEE-4: the newly mapped lines can now be costed. A cost problem never
  // fails the mapping; what does not fit the budget stays "chưa tính".
  const orders = data.affected_order_ids ?? [];
  const deadline = Date.now() + (options.cogsBudgetMs ?? COGS_AFTER_MAPPING_BUDGET_MS);
  let processed = 0;
  for (const orderId of orders) {
    if (Date.now() > deadline) break;
    const { error: costError } = await db.rpc("cost_process_order", { p_order_id: orderId });
    if (costError) console.warn(JSON.stringify({ source: "cost", event: "COGS_AFTER_MAPPING_FAILED", orderId, postgresCode: costError.code, message: costError.message }));
    processed++;
  }
  return {
    scanned: data.scanned,
    mapped: data.mapped,
    unmapped: data.unmapped,
    conflicts: data.conflicts,
    skipped: data.skipped,
    orderLinesBackfilled: data.order_lines_backfilled,
    cogsPendingOrders: orders.length - processed,
  };
}

/**
 * Re-checks auto mappings of a shop: channel SKU ≠ mapped product SKU (after
 * normalization) → mapping_review_required = true (mapping untouched);
 * matching again → flag cleared. Manual mappings are never flagged.
 * Set-based in SQL (refresh_channel_mapping_review_flags) — no id lists over HTTP.
 */
export async function refreshMappingReviewFlags(db: SupabaseClient, shopId: string): Promise<number> {
  const { data, error } = await db.rpc("refresh_channel_mapping_review_flags", { p_shop_id: shopId });
  if (error) throw new MappingDbError("refresh_channel_mapping_review_flags", error);
  return Number(data ?? 0);
}

/**
 * After a unit gains a mapping: fill the product snapshot of its order lines
 * that were synced while it was unmapped (internal_product_id IS NULL) — and
 * ONLY those. Non-null historical snapshots are never touched.
 */
export async function backfillUnmappedOrderItemsForModel(db: SupabaseClient, channelModelId: string): Promise<number> {
  const { data: model, error } = await db.from("channel_product_models").select("internal_product_id").eq("id", channelModelId).maybeSingle<{ internal_product_id: string | null }>();
  if (error) throw new Error(`Không đọc được biến thể: ${error.message}`);
  if (!model?.internal_product_id) return 0;
  const { data, error: updError } = await db
    .from("channel_order_items")
    .update({ internal_product_id: model.internal_product_id })
    .eq("channel_model_id", channelModelId)
    .is("internal_product_id", null)
    .select("id, order_id");
  if (updError) throw new Error(`Không cập nhật được dòng đơn: ${updError.message}`);
  // SHOPEE-4: the newly mapped lines can now be costed (immutable snapshots
  // elsewhere in those orders are untouched by the SQL engine).
  const orderIds = [...new Set(((data ?? []) as Array<{ order_id: string }>).map((r) => r.order_id))];
  for (const orderId of orderIds) {
    const { error: costError } = await db.rpc("cost_process_order", { p_order_id: orderId });
    if (costError) console.warn(JSON.stringify({ source: "cost", event: "COGS_AFTER_MAPPING_FAILED", orderId, message: costError.message }));
  }
  return data?.length ?? 0;
}

export type MappingActionResult =
  | { ok: true }
  | { ok: false; message: string; code?: "used_by_orders_unmap" | "used_by_orders_remap" | "invalid" | "not_found" };

/** Maps the DB guard's SQLSTATEs (migration 00041) to user-facing results. */
function guardError(error: { code?: string; message?: string } | null, fallback: string): MappingActionResult {
  switch (error?.code) {
    case "CM001":
      return { ok: false, code: "used_by_orders_unmap", message: "Không thể bỏ ghép biến thể này vì đã có đơn hàng sử dụng mapping." };
    case "CM002":
      return {
        ok: false,
        code: "used_by_orders_remap",
        message: "Mapping đã được sử dụng trong đơn hàng lịch sử. Không thể đổi trực tiếp (chỉ admin điều chỉnh có ghi lý do).",
      };
    case "CM003":
      return { ok: false, code: "invalid", message: error.message ?? fallback };
    case "CM004":
      return { ok: false, code: "not_found", message: error.message ?? fallback };
    default:
      return { ok: false, message: fallback };
  }
}

/** Manual mapping. Both ids are re-validated server-side; nothing else from the browser is trusted. */
export async function mapChannelModelToProduct(
  db: SupabaseClient,
  input: { channelModelId: string; internalProductId: string; mappedBy: string },
  now: Date = new Date(),
): Promise<MappingActionResult> {
  const [{ data: model }, { data: product }] = await Promise.all([
    db.from("channel_product_models").select("id").eq("id", input.channelModelId).maybeSingle(),
    db.from("products").select("id").eq("id", input.internalProductId).maybeSingle(),
  ]);
  if (!model) return { ok: false, message: "Không tìm thấy biến thể Shopee." };
  if (!product) return { ok: false, message: "Không tìm thấy sản phẩm nội bộ." };
  const { error } = await db
    .from("channel_product_models")
    .update({
      internal_product_id: input.internalProductId,
      mapping_status: "manual_mapped",
      mapped_at: now.toISOString(),
      mapped_by: input.mappedBy,
      mapping_review_required: false,
    })
    .eq("id", input.channelModelId);
  if (error) return guardError(error, "Không lưu được mapping.");
  await backfillUnmappedOrderItemsForModel(db, input.channelModelId);
  return { ok: true };
}

/**
 * Unmap. Refused by the database (CM001) once any order item was resolved
 * through this unit — historical order lines must keep their product.
 */
export async function unmapChannelModel(db: SupabaseClient, input: { channelModelId: string }): Promise<MappingActionResult> {
  const { data, error } = await db
    .from("channel_product_models")
    .update({ internal_product_id: null, mapping_status: "unmapped", mapped_at: null, mapped_by: null, mapping_review_required: false })
    .eq("id", input.channelModelId)
    .select("id");
  if (error) return guardError(error, "Không bỏ ghép được.");
  if (!data || data.length === 0) return { ok: false, code: "not_found", message: "Không tìm thấy biến thể Shopee." };
  return { ok: true };
}

/**
 * Controlled remap of a unit that orders already use: new product required,
 * written reason required, recorded in channel_model_mapping_history.
 * Affects FUTURE order lines only — existing order items keep their own
 * internal_product_id snapshot.
 */
export async function changeChannelModelMappingControlled(
  db: SupabaseClient,
  input: { channelModelId: string; internalProductId: string; reason: string; changedBy: string },
): Promise<MappingActionResult> {
  const { error } = await db.rpc("change_channel_model_mapping", {
    p_channel_model_id: input.channelModelId,
    p_internal_product_id: input.internalProductId,
    p_reason: input.reason,
    p_changed_by: input.changedBy,
  });
  if (error) return guardError(error, "Không điều chỉnh được mapping.");
  await backfillUnmappedOrderItemsForModel(db, input.channelModelId); // only NULL lines
  return { ok: true };
}
