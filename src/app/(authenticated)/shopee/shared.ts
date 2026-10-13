// Shared display helpers for the Shopee screens (server components).
// Money/quantities arrive as NUMERIC strings and are formatted as strings —
// never converted to floats. NULL renders as "—" / a status label, never as 0.
import type { ChannelModelListRow } from "@/lib/channels/core/product-queries";
import type { MappingStatus } from "@/lib/channels/core/types";

import type { ModelRowView } from "./products/model-row-actions";

export const MAPPING_LABELS: Record<MappingStatus, string> = {
  unmapped: "Chưa ghép",
  auto_mapped: "Tự động ghép",
  manual_mapped: "Ghép thủ công",
  mapping_conflict: "Xung đột",
};

export const MAPPING_VARIANT: Record<MappingStatus, "default" | "secondary" | "destructive" | "outline"> = {
  unmapped: "secondary",
  auto_mapped: "outline",
  manual_mapped: "default",
  mapping_conflict: "destructive",
};

const dateTime = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const fmtDate = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : "—");

/** Formats a NUMERIC string for display without converting it to a float. */
export function formatDecimal(value: string | null, unit = ""): string {
  if (value === null) return "—";
  const [intPart, frac = ""] = value.replace(/^-/, "").split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const trimmedFrac = frac.replace(/0+$/, "");
  return `${value.startsWith("-") ? "-" : ""}${grouped}${trimmedFrac ? `,${trimmedFrac}` : ""}${unit}`;
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
