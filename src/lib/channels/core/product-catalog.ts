// ============================================================
// PHASE SHOPEE-2: persistence of canonical catalog rows (channel-agnostic).
//
// Writes ONLY provider-owned columns. Mapping columns (internal_product_id,
// mapping_status, mapped_*) are never part of a sync upsert, so a re-sync
// can never overwrite a manual (or auto) mapping.
//
// Takes the DB client as a parameter (service-role on the server, injected
// in tests); no "server-only" marker so integration tests can drive it.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { MappedChannelModel, MappedChannelProduct } from "./mapped.ts";

export interface UpsertCounts {
  created: number;
  updated: number;
}

export async function upsertChannelProducts(
  db: SupabaseClient,
  shopId: string,
  products: MappedChannelProduct[],
  syncedAt: string,
): Promise<{ idByExternalId: Map<string, string>; counts: UpsertCounts }> {
  const idByExternalId = new Map<string, string>();
  if (products.length === 0) return { idByExternalId, counts: { created: 0, updated: 0 } };

  const externalIds = products.map((p) => p.externalItemId);
  const { data: existing, error: existingError } = await db
    .from("channel_products")
    .select("external_item_id")
    .eq("shop_id", shopId)
    .in("external_item_id", externalIds);
  if (existingError) throw new Error(`Không đọc được channel_products: ${existingError.message}`);
  const existingIds = new Set((existing ?? []).map((r: { external_item_id: string }) => r.external_item_id));

  const { data, error } = await db
    .from("channel_products")
    .upsert(
      products.map((p) => ({
        shop_id: shopId,
        external_item_id: p.externalItemId,
        item_name: p.itemName,
        item_sku: p.itemSku,
        category_id: p.categoryId,
        item_status: p.itemStatus,
        has_model: p.hasModel,
        is_kit: p.isKit,
        channel_original_price: p.channelOriginalPrice,
        channel_current_price: p.channelCurrentPrice,
        available_stock: p.availableStock,
        reserved_stock: p.reservedStock,
        source_created_at: p.sourceCreatedAt,
        source_updated_at: p.sourceUpdatedAt,
        last_synced_at: syncedAt,
      })),
      { onConflict: "shop_id,external_item_id" },
    )
    .select("id, external_item_id");
  if (error) throw new Error(`Không lưu được channel_products: ${error.message}`);

  for (const row of (data ?? []) as Array<{ id: string; external_item_id: string }>) idByExternalId.set(row.external_item_id, row.id);
  const created = externalIds.filter((id) => !existingIds.has(id)).length;
  return { idByExternalId, counts: { created, updated: externalIds.length - created } };
}

/**
 * Upserts the sellable units of one listing. When `complete` is true the list
 * is the provider's full, cleanly parsed set: any other unit of this listing
 * is marked removed (kept with its mapping, never deleted); units present
 * again are un-removed. With `complete = false` (some models failed to parse)
 * nothing is marked removed.
 */
export async function upsertChannelModels(
  db: SupabaseClient,
  channelProductId: string,
  models: MappedChannelModel[],
  syncedAt: string,
  options: { complete: boolean },
): Promise<UpsertCounts> {
  const { data: existing, error: existingError } = await db
    .from("channel_product_models")
    .select("id, external_model_id, removed_at")
    .eq("channel_product_id", channelProductId);
  if (existingError) throw new Error(`Không đọc được channel_product_models: ${existingError.message}`);
  const existingRows = (existing ?? []) as Array<{ id: string; external_model_id: string; removed_at: string | null }>;
  const existingIds = new Set(existingRows.map((r) => r.external_model_id));

  if (models.length > 0) {
    const { error } = await db.from("channel_product_models").upsert(
      models.map((m) => ({
        channel_product_id: channelProductId,
        external_model_id: m.externalModelId,
        is_synthetic: m.isSynthetic,
        model_name: m.modelName,
        model_sku: m.modelSku,
        model_status: m.modelStatus,
        channel_original_price: m.channelOriginalPrice,
        channel_current_price: m.channelCurrentPrice,
        available_stock: m.availableStock,
        reserved_stock: m.reservedStock,
        weight: m.weight,
        package_length: m.packageLength,
        package_width: m.packageWidth,
        package_height: m.packageHeight,
        removed_at: null,
        last_synced_at: syncedAt,
      })),
      { onConflict: "channel_product_id,external_model_id" },
    );
    if (error) throw new Error(`Không lưu được channel_product_models: ${error.message}`);
  }

  if (options.complete) {
    const present = new Set(models.map((m) => m.externalModelId));
    const toRemove = existingRows.filter((r) => !present.has(r.external_model_id) && r.removed_at === null).map((r) => r.id);
    if (toRemove.length > 0) {
      const { error } = await db.from("channel_product_models").update({ removed_at: syncedAt }).in("id", toRemove);
      if (error) throw new Error(`Không đánh dấu được model đã bị gỡ: ${error.message}`);
    }
  }

  const created = models.filter((m) => !existingIds.has(m.externalModelId)).length;
  return { created, updated: models.length - created };
}
