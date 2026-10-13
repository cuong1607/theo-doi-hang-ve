// ============================================================
// PHASE SHOPEE-3: order status helpers (Shopee status strings stay free text
// in the DB — new provider statuses must not break inserts).
//
// COMPLETED means the buyer side is done; it is NOT "settlement final".
// Money facts come from escrow/income (SHOPEE-5), never from this status.
// ============================================================

const ACTIVE = new Set(["UNPAID", "READY_TO_SHIP", "PROCESSED", "RETRY_SHIP", "SHIPPED", "TO_CONFIRM_RECEIVE", "IN_CANCEL", "TO_RETURN"]);

export function isOrderActive(status: string | null | undefined): boolean {
  return !!status && ACTIVE.has(status);
}

export function isOrderCompleted(status: string | null | undefined): boolean {
  return status === "COMPLETED";
}

export function isOrderCancelled(status: string | null | undefined): boolean {
  return status === "CANCELLED";
}

/**
 * Statuses whose lines leave costing inventory (sale_out). Mirror of the
 * database rule public.cost_order_status_eligible() — the DB is
 * authoritative and a test asserts both agree. UNPAID never posts;
 * CANCELLED reverses a previous posting.
 */
const INVENTORY_OUT = new Set(["READY_TO_SHIP", "PROCESSED", "RETRY_SHIP", "SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED"]);

export function isOrderEligibleForInventoryOut(status: string | null | undefined): boolean {
  return !!status && INVENTORY_OUT.has(status);
}

/** COMPLETED orders become eligible for escrow/income sync (SHOPEE-5) — nothing is called yet. */
export function isFinancialSyncEligible(status: string | null | undefined): boolean {
  return isOrderCompleted(status);
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  UNPAID: "Chưa thanh toán",
  READY_TO_SHIP: "Chờ lấy hàng",
  PROCESSED: "Đã xử lý",
  RETRY_SHIP: "Giao lại",
  SHIPPED: "Đang giao",
  TO_CONFIRM_RECEIVE: "Chờ xác nhận nhận hàng",
  IN_CANCEL: "Đang hủy",
  CANCELLED: "Đã hủy",
  TO_RETURN: "Trả hàng",
  COMPLETED: "Hoàn thành",
};
