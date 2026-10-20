// ============================================================
// PHASE SHOPEE-3: persistence of canonical orders (channel-agnostic).
//
// Identity resolution: an order line is matched to a sellable unit by
// PROVIDER IDENTITY — shop + external_item_id + external_model_id (no model →
// the synthetic NO_MODEL unit). SKU strings are never used to resolve.
//
// Historical snapshot rule (critical):
//   channel_product_models.internal_product_id = CURRENT mapping
//   channel_order_items.internal_product_id    = mapping SNAPSHOT of that line
// A re-sync never overwrites a non-null line snapshot; a NULL one is filled
// when the unit has a mapping (same rule as backfillUnmappedOrderItemsForModel).
// Cost columns are never written here.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { SYNTHETIC_MODEL_ID, type MappedOrder } from "./mapped.ts";

export interface ResolvedUnit {
  channelModelId: string;
  internalProductId: string | null;
}

export function unitKey(externalItemId: string, externalModelId: string | null): string {
  return `${externalItemId}|${externalModelId ?? SYNTHETIC_MODEL_ID}`;
}

/** One query pair for a whole batch of lines (no N+1). */
export async function resolveChannelUnits(
  db: SupabaseClient,
  shopId: string,
  lines: Array<{ externalItemId: string; externalModelId: string | null }>,
): Promise<Map<string, ResolvedUnit>> {
  const resolved = new Map<string, ResolvedUnit>();
  const itemIds = [...new Set(lines.map((l) => l.externalItemId))];
  if (itemIds.length === 0) return resolved;
  const { data: products, error } = await db.from("channel_products").select("id, external_item_id").eq("shop_id", shopId).in("external_item_id", itemIds);
  if (error) throw new Error(`Không đọc được channel_products: ${error.message}`);
  const itemByProductId = new Map((products ?? []).map((p: { id: string; external_item_id: string }) => [p.id, p.external_item_id]));
  if (itemByProductId.size === 0) return resolved;
  const { data: models, error: modelError } = await db
    .from("channel_product_models")
    .select("id, channel_product_id, external_model_id, internal_product_id")
    .in("channel_product_id", [...itemByProductId.keys()]);
  if (modelError) throw new Error(`Không đọc được channel_product_models: ${modelError.message}`);
  for (const m of (models ?? []) as Array<{ id: string; channel_product_id: string; external_model_id: string; internal_product_id: string | null }>) {
    const itemId = itemByProductId.get(m.channel_product_id)!;
    resolved.set(`${itemId}|${m.external_model_id}`, { channelModelId: m.id, internalProductId: m.internal_product_id });
  }
  return resolved;
}

export async function upsertChannelOrder(
  db: SupabaseClient,
  shopId: string,
  order: MappedOrder,
  syncedAt: string,
): Promise<{ orderId: string; created: boolean; previousStatus: string | null }> {
  const { data: existing } = await db
    .from("channel_orders")
    .select("id, order_status")
    .eq("shop_id", shopId)
    .eq("external_order_sn", order.externalOrderSn)
    .maybeSingle<{ id: string; order_status: string }>();

  // financial_status is NOT written: new rows get the DB default 'pending',
  // existing rows keep theirs (it is owned by the financial pipeline).
  const { data, error } = await db
    .from("channel_orders")
    .upsert(
      {
        shop_id: shopId,
        external_order_sn: order.externalOrderSn,
        booking_sn: order.bookingSn,
        order_status: order.orderStatus,
        currency: order.currency,
        payment_method: order.paymentMethod,
        cod: order.cod,
        channel_total_amount: order.channelTotalAmount,
        estimated_shipping_fee: order.estimatedShippingFee,
        reverse_shipping_fee: order.reverseShippingFee,
        created_at_channel: order.createdAtChannel,
        paid_at_channel: order.paidAtChannel,
        pickup_done_at_channel: order.pickupDoneAtChannel,
        ship_by_date: order.shipByDate,
        updated_at_channel: order.updatedAtChannel,
        shipping_carrier: order.shippingCarrier,
        // SHOPEE-6B: only written when the payload carried them (older callers / fixtures leave them untouched)
        ...(order.cancelReason !== undefined ? { cancel_reason: order.cancelReason } : {}),
        ...(order.packageLogisticsStatus !== undefined ? { logistics_status: order.packageLogisticsStatus } : {}),
        ...(order.packageNumber !== undefined ? { package_number: order.packageNumber } : {}),
        ...(order.packageCount !== undefined ? { package_count: order.packageCount } : {}),
        last_synced_at: syncedAt,
      },
      { onConflict: "shop_id,external_order_sn" },
    )
    .select("id")
    .single();
  if (error || !data) throw new Error(`Không lưu được đơn ${order.externalOrderSn}: ${error?.message ?? "unknown"}`);
  return { orderId: data.id as string, created: !existing, previousStatus: existing?.order_status ?? null };
}

export interface OrderItemsResult {
  created: number;
  updated: number;
  removed: number;
  mappedLines: number;
  totalLines: number;
  unresolvedLines: number;
}

export async function upsertChannelOrderItems(
  db: SupabaseClient,
  orderId: string,
  order: MappedOrder,
  units: Map<string, ResolvedUnit>,
): Promise<OrderItemsResult> {
  const { data: existingRows, error: readError } = await db
    .from("channel_order_items")
    .select("id, provider_line_key, internal_product_id, channel_model_id")
    .eq("order_id", orderId);
  if (readError) throw new Error(`Không đọc được dòng đơn: ${readError.message}`);
  const existing = new Map(
    ((existingRows ?? []) as Array<{ id: string; provider_line_key: string | null; internal_product_id: string | null; channel_model_id: string | null }>)
      .filter((r) => r.provider_line_key)
      .map((r) => [r.provider_line_key as string, r]),
  );

  let mappedLines = 0;
  let unresolvedLines = 0;
  const rows = order.items.map((item) => {
    const unit = units.get(unitKey(item.externalItemId, item.externalModelId));
    const prev = existing.get(item.providerLineKey);
    if (!unit) unresolvedLines++;
    // Never overwrite a non-null historical snapshot; fill NULL from the current mapping.
    const internalProductId = prev?.internal_product_id ?? unit?.internalProductId ?? null;
    if (internalProductId) mappedLines++;
    return {
      order_id: orderId,
      provider_line_key: item.providerLineKey,
      external_order_item_id: item.externalOrderItemId,
      external_item_id: item.externalItemId,
      external_model_id: item.externalModelId,
      item_name: item.itemName,
      model_name: item.modelName,
      item_sku: item.itemSku,
      model_sku: item.modelSku,
      quantity: item.quantity,
      original_unit_price: item.originalUnitPrice,
      discounted_unit_price: item.discountedUnitPrice,
      promotion_type: item.promotionType,
      promotion_id: item.promotionId,
      channel_model_id: prev?.channel_model_id ?? unit?.channelModelId ?? null,
      internal_product_id: internalProductId,
    };
  });

  if (rows.length > 0) {
    const { error } = await db.from("channel_order_items").upsert(rows, { onConflict: "order_id,provider_line_key" });
    if (error) throw new Error(`Không lưu được dòng đơn: ${error.message}`);
  }

  // Lines the provider no longer returns for this order are removed (the
  // previous structure stays in the order's raw snapshot history).
  const keep = new Set(order.items.map((i) => i.providerLineKey));
  const stale = [...existing.entries()].filter(([key]) => !keep.has(key)).map(([, r]) => r.id);
  if (stale.length > 0) {
    const { error } = await db.from("channel_order_items").delete().in("id", stale);
    if (error) throw new Error(`Không xóa được dòng đơn cũ: ${error.message}`);
  }

  const created = order.items.filter((i) => !existing.has(i.providerLineKey)).length;
  return { created, updated: order.items.length - created, removed: stale.length, mappedLines, totalLines: order.items.length, unresolvedLines };
}
