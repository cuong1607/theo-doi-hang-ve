// ============================================================
// SHOPEE-6B: "Lý do hoàn" text for the list / export.
//   Hoàn Trả  Shopee return reason code (+ the buyer's own words)
//   Hoàn Hủy  order cancel_reason
// Codes seen on the real VN shop are listed first; any other code is shown
// as-is (never hidden, never guessed). Pure: no I/O.
// ============================================================
import type { ReturnOperationType } from "./classify.ts";

export const RETURN_REASON_LABELS: Record<string, string> = {
  // seen on prod (2026-10)
  CHANGE_MIND: "Đổi ý",
  CHANGE_OF_MIND: "Đổi ý",
  DIFFERENT_DESCRIPTION: "Không đúng mô tả",
  FUNCTIONAL_DMG: "Hàng lỗi, không hoạt động",
  DAMAGED_OTHERS: "Hàng hư hỏng (khác)",
  WRONG_ORDER_INFO: "Sai thông tin đơn hàng",
  SLIGHT_SCRATCH_DENTS: "Trầy xước, móp nhẹ",
  USED: "Hàng đã qua sử dụng",
  // documented
  NOT_RECEIPT: "Chưa nhận được hàng",
  WRONG_ITEM: "Giao sai hàng",
  ITEM_DAMAGED: "Hàng bị hư hỏng",
  PHYSICAL_DMG: "Hàng bị vỡ / hư hỏng bên ngoài",
  ITEM_MISSING: "Thiếu hàng",
  ITEM_WRONGDAMAGED: "Sai hàng / hư hỏng",
  EXPECTATION_FAILED: "Không như kỳ vọng",
  ITEM_FAKE: "Hàng giả",
  WRONG_SIZE: "Sai kích thước",
  MUTUAL_AGREE: "Thoả thuận với người bán",
  OTHER: "Khác",
};

export const CANCEL_REASON_LABELS: Record<string, string> = {
  "Failed Delivery": "Giao hàng không thành công",
  "Logistics Delivery Failed": "Giao hàng không thành công",
  "Buyer Refused": "Người mua từ chối nhận hàng",
  "Customer Request": "Người mua yêu cầu huỷ",
  "Undeliverable Area": "Khu vực không giao được",
  "COD Not Supported": "Không hỗ trợ COD",
  "Out of Stock": "Hết hàng",
  "Lost Parcel": "Thất lạc kiện hàng",
};

export function returnOperationReason(input: { operationType: ReturnOperationType; returnReason: string | null; returnTextReason: string | null; cancelReason: string | null }): string {
  if (input.operationType === "customer_return") {
    const code = input.returnReason?.trim();
    const label = code ? (RETURN_REASON_LABELS[code.toUpperCase()] ?? code) : null;
    const text = input.returnTextReason?.trim();
    if (label && text) return `${label}: ${text}`;
    return label ?? text ?? "";
  }
  const c = input.cancelReason?.trim();
  if (!c) return "Giao hàng không thành công";
  return CANCEL_REASON_LABELS[c] ?? c;
}
