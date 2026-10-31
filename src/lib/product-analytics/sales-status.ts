// ============================================================
// PRODUCT-ANALYTICS-2: the ONE mapping from a Shopee order status to what a
// product sales fact counts towards (docs/product-sales-facts-sync.md §3).
//
//   counted (orders / units / GMV)   READY_TO_SHIP, PROCESSED, RETRY_SHIP,
//                                    SHIPPED, TO_CONFIRM_RECEIVE, COMPLETED,
//                                    TO_RETURN (gross: a return is NOT netted —
//                                    refund-adjusted sales are unsupported)
//   not counted                      UNPAID (not placed yet), IN_CANCEL
//                                    (cancellation requested — conservative),
//                                    CANCELLED, any unknown status
//
// No "paid / confirmed" guess: COD orders never pass through UNPAID, so
// pay_time is NOT a criterion. A fact keeps its status: a later restatement
// (e.g. SHIPPED → CANCELLED) flips the flags on upsert, nothing is deleted.
// Pure.
// ============================================================

export type ProductSalesStatusClass = "pending_payment" | "open" | "completed" | "return_in_progress" | "cancel_pending" | "cancelled" | "unknown";

export interface ProductSalesStatusDecision {
  statusClass: ProductSalesStatusClass;
  isValidForSales: boolean;
  isCancelled: boolean;
  isCompleted: boolean;
}

const CLASS_OF: Record<string, ProductSalesStatusClass> = {
  UNPAID: "pending_payment",
  READY_TO_SHIP: "open",
  PROCESSED: "open",
  RETRY_SHIP: "open",
  SHIPPED: "open",
  TO_CONFIRM_RECEIVE: "open",
  COMPLETED: "completed",
  TO_RETURN: "return_in_progress",
  IN_CANCEL: "cancel_pending",
  CANCELLED: "cancelled",
};

const COUNTED: ReadonlySet<ProductSalesStatusClass> = new Set(["open", "completed", "return_in_progress"]);

export function classifyProductSalesOrderStatus(status: string | null | undefined): ProductSalesStatusDecision {
  const statusClass = (status && CLASS_OF[status.trim().toUpperCase()]) || "unknown";
  return {
    statusClass,
    isValidForSales: COUNTED.has(statusClass),
    isCancelled: statusClass === "cancelled",
    isCompleted: statusClass === "completed",
  };
}

/** Documentation table (docs + UI legend), derived from the mapping above. */
export const PRODUCT_SALES_STATUS_TABLE: ReadonlyArray<{ status: string; statusClass: ProductSalesStatusClass; counted: boolean }> = Object.entries(CLASS_OF).map(([status, statusClass]) => ({
  status,
  statusClass,
  counted: COUNTED.has(statusClass),
}));
