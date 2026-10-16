// Shopee order display labels. Colours are NOT here — status → tone lives in
// src/lib/ui/status.ts (one place for the whole app).
import type { CogsReadiness, MappingReadiness } from "@/lib/channels/core/order-queries";

/** URL query keys of the order list filters (shared by the page and <OrderFilters>). */
export const ORDER_FILTER_KEYS = ["shop", "status", "mapping", "financial", "fin", "sn", "sku", "from", "to"] as const;

export const READINESS_LABELS: Record<MappingReadiness, string> = {
  complete: "Đầy đủ",
  partial: "Thiếu",
  unmapped: "Chưa ghép",
  no_items: "Không có dòng",
};

/** COGS is never shown as 0 when unknown. */
export const COGS_LABELS: Record<CogsReadiness, string> = {
  complete: "Đầy đủ",
  partial: "Một phần",
  incomplete: "Chưa tính",
};

export const COST_METHOD_LABELS: Record<string, string> = {
  moving_average: "Bình quân di động",
  fifo: "FIFO",
  manual: "Thủ công",
  unknown: "Không rõ",
};

export const FINANCIAL_STATUS_LABELS: Record<string, string> = {
  pending: "Chờ dữ liệu tài chính",
  estimated: "Đã ước tính",
  settlement_available: "Có settlement",
  released: "Đã giải ngân",
  mismatch: "Lệch đối soát",
  return_adjusted: "Điều chỉnh hoàn trả",
};

export const RECONCILIATION_LABELS: Record<"matched" | "warning" | "mismatch", string> = {
  matched: "Khớp đối soát",
  warning: "Lệch nhỏ",
  mismatch: "Lệch đối soát",
};
