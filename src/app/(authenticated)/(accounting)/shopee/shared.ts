// Shared display helpers for the Shopee screens (server components).
// Money/quantities arrive as NUMERIC strings and are formatted as strings —
// never converted to floats. NULL renders as "—" / a status label, never as 0.
import type { ChannelModelListRow } from "@/lib/channels/core/product-queries";
import type { MappingStatus } from "@/lib/channels/core/types";
import { formatDateTime, formatDecimalString } from "@/lib/ui/format";

import type { ModelRowView } from "./products/model-row-actions";

export const MAPPING_LABELS: Record<MappingStatus, string> = {
  unmapped: "Chưa ghép",
  auto_mapped: "Tự động ghép",
  manual_mapped: "Ghép thủ công",
  mapping_conflict: "Xung đột",
};

/** URL query keys of the Shopee product list filters. */
export const PRODUCT_FILTER_KEYS = ["shop", "mapping", "status", "name", "sku", "isku"] as const;

/** dd/MM/yyyy HH:mm (Asia/Ho_Chi_Minh) — src/lib/ui/format.ts. */
export const fmtDate = (iso: string | null) => formatDateTime(iso);

/** Formats a NUMERIC string for display without converting it to a float. */
export function formatDecimal(value: string | null, unit = ""): string {
  return value === null ? "—" : formatDecimalString(value, unit);
}

export function toModelView(row: ChannelModelListRow): ModelRowView {
  return {
    channelModelId: row.channelModelId,
    shopName: row.shopName,
    externalItemId: row.externalItemId,
    externalModelId: row.externalModelId,
    isSynthetic: row.isSynthetic,
    itemName: row.itemName,
    modelName: row.modelName,
    itemSku: row.itemSku,
    modelSku: row.modelSku,
    itemStatus: row.itemStatus,
    modelStatus: row.modelStatus,
    isKit: row.isKit,
    priceText:
      row.channelCurrentPrice === row.channelOriginalPrice || !row.channelOriginalPrice
        ? formatDecimal(row.channelCurrentPrice, " ₫")
        : `${formatDecimal(row.channelCurrentPrice, " ₫")} (gốc ${formatDecimal(row.channelOriginalPrice, " ₫")})`,
    availableStock: row.availableStock === null ? null : formatDecimal(row.availableStock),
    reservedStock: row.reservedStock === null ? null : formatDecimal(row.reservedStock),
    lastSyncedText: fmtDate(row.lastSyncedAt),
    removed: row.removedAt !== null,
    internalSku: row.internalSku,
    internalProductName: row.internalProductName,
    mappingLabel: `${MAPPING_LABELS[row.mappingStatus]}${row.mappingReviewRequired ? " · cần kiểm tra lại" : ""}`,
    orderItemCount: row.orderItemCount,
  };
}
