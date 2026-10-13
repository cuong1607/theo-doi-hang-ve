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

export function normalizeSku(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.toLowerCase();
}

export interface AutoMapResult {
  scanned: number;
  mapped: number;
  unmapped: number;
  conflicts: number;
}

type CandidateRow = { channel_model_id: string; channel_sku: string | null; mapping_status: string };

const PAGE = 1000;

async function loadActiveProductsBySku(db: SupabaseClient): Promise<Map<string, string[]>> {
  const bySku = new Map<string, string[]>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("products")
      .select("id, sku")
      .eq("is_active", true)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Không đọc được products: ${error.message}`);
    for (const row of (data ?? []) as Array<{ id: string; sku: string }>) {
      const key = normalizeSku(row.sku);
      if (!key) continue;
      bySku.set(key, [...(bySku.get(key) ?? []), row.id]);
    }
    if (!data || data.length < PAGE) break;
  }
  return bySku;
}

async function loadCandidates(db: SupabaseClient, shopId: string): Promise<CandidateRow[]> {
  const rows: CandidateRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("v_channel_model_listing")
      .select("channel_model_id, channel_sku, mapping_status")
      .eq("shop_id", shopId)
      .in("mapping_status", ["unmapped", "mapping_conflict"])
      .is("removed_at", null)
      .order("channel_model_id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Không đọc được danh sách model: ${error.message}`);
    rows.push(...((data ?? []) as CandidateRow[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

/** Bulk exact-SKU auto-mapping for one shop ("Tự động ghép SKU"). */
export async function autoMapChannelModels(db: SupabaseClient, shopId: string, now: Date = new Date()): Promise<AutoMapResult> {
  const [candidates, productsBySku] = await Promise.all([loadCandidates(db, shopId), loadActiveProductsBySku(db)]);
  const result: AutoMapResult = { scanned: candidates.length, mapped: 0, unmapped: 0, conflicts: 0 };
  const toUnmapped: string[] = [];
  const toConflict: string[] = [];
  const toMap: Array<{ id: string; productId: string }> = [];

  for (const row of candidates) {
    const key = normalizeSku(row.channel_sku);
    const matches = key ? productsBySku.get(key) ?? [] : [];
    if (matches.length === 1) toMap.push({ id: row.channel_model_id, productId: matches[0] });
    else if (matches.length > 1) toConflict.push(row.channel_model_id);
    else toUnmapped.push(row.channel_model_id);
  }

  // Guard every write with the expected current status so a concurrent manual mapping always wins.
  const guard = ["unmapped", "mapping_conflict"];
  if (toConflict.length) {
    const { error } = await db.from("channel_product_models").update({ mapping_status: "mapping_conflict" }).in("id", toConflict).in("mapping_status", guard);
    if (error) throw new Error(`Không cập nhật được trạng thái conflict: ${error.message}`);
  }
  if (toUnmapped.length) {
    const { error } = await db.from("channel_product_models").update({ mapping_status: "unmapped" }).in("id", toUnmapped).in("mapping_status", guard);
    if (error) throw new Error(`Không cập nhật được trạng thái unmapped: ${error.message}`);
  }
  const mappedAt = now.toISOString();
  for (let i = 0; i < toMap.length; i += 20) {
    const chunk = toMap.slice(i, i + 20);
    const results = await Promise.all(
      chunk.map(({ id, productId }) =>
        db
          .from("channel_product_models")
          .update({ internal_product_id: productId, mapping_status: "auto_mapped", mapped_at: mappedAt, mapped_by: null, mapping_review_required: false })
          .eq("id", id)
          .in("mapping_status", guard)
          .select("id"),
      ),
    );
    for (const r of results) {
      if (r.error) throw new Error(`Không ghép được SKU: ${r.error.message}`);
      result.mapped += r.data?.length ?? 0;
    }
    for (const r of results) {
      for (const row of (r.data ?? []) as Array<{ id: string }>) await backfillUnmappedOrderItemsForModel(db, row.id);
    }
  }
  result.unmapped = toUnmapped.length;
  result.conflicts = toConflict.length;
  return result;
}

/**
 * Re-checks auto mappings of a shop: channel SKU ≠ mapped product SKU (after
 * normalization) → mapping_review_required = true (mapping untouched);
 * matching again → flag cleared. Manual mappings are never flagged.
 */
export async function refreshMappingReviewFlags(db: SupabaseClient, shopId: string): Promise<number> {
  const { data, error } = await db
    .from("v_channel_model_listing")
    .select("channel_model_id, channel_sku, internal_sku, mapping_review_required")
    .eq("shop_id", shopId)
    .eq("mapping_status", "auto_mapped");
  if (error) throw new Error(`Không đọc được mapping: ${error.message}`);
  const rows = (data ?? []) as Array<{ channel_model_id: string; channel_sku: string | null; internal_sku: string | null; mapping_review_required: boolean }>;
  const flag: string[] = [];
  const clear: string[] = [];
  for (const row of rows) {
    const mismatch = normalizeSku(row.channel_sku) !== normalizeSku(row.internal_sku);
    if (mismatch && !row.mapping_review_required) flag.push(row.channel_model_id);
    if (!mismatch && row.mapping_review_required) clear.push(row.channel_model_id);
  }
  if (flag.length) await db.from("channel_product_models").update({ mapping_review_required: true }).in("id", flag).eq("mapping_status", "auto_mapped");
  if (clear.length) await db.from("channel_product_models").update({ mapping_review_required: false }).in("id", clear);
  return rows.filter((r) => normalizeSku(r.channel_sku) !== normalizeSku(r.internal_sku)).length;
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
    .select("id");
  if (updError) throw new Error(`Không cập nhật được dòng đơn: ${updError.message}`);
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
