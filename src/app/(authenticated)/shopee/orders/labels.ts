import type { CogsReadiness, MappingReadiness } from "@/lib/channels/core/order-queries";

export const READINESS_LABELS: Record<MappingReadiness, string> = {
  complete: "Đầy đủ",
  partial: "Thiếu",
  unmapped: "Chưa ghép",
  no_items: "Không có dòng",
};

export const READINESS_VARIANT: Record<MappingReadiness, "default" | "secondary" | "destructive" | "outline"> = {
  complete: "outline",
  partial: "destructive",
  unmapped: "destructive",
  no_items: "secondary",
};

/** COGS is never shown as 0 when unknown. */
export const COGS_LABELS: Record<CogsReadiness, string> = {
  complete: "Đã tính",
  pending: "Chưa tính",
  incomplete: "Chưa tính (thiếu mapping)",
};

export const FINANCIAL_STATUS_LABELS: Record<string, string> = {
  pending: "Chờ dữ liệu tài chính",
  estimated: "Đã ước tính",
  settlement_available: "Có settlement",
  released: "Đã giải ngân",
  mismatch: "Lệch đối soát",
  return_adjusted: "Điều chỉnh hoàn trả",
};
