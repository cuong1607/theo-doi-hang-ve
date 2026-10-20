// ============================================================
// PHASE SHOPEE-6B: classifyReturnOperation — the ONE rule deciding whether
// an order is tracked as Hoàn Trả, Hoàn Hủy or not at all.
//
//   customer return record exists, not cancelled, goods physically come back
//       → customer_return (Hoàn Trả)
//   else order CANCELLED after it was handed to the carrier (pickup done, or
//   the package reports an outbound delivery failure / COD rejection / loss)
//   and no customer return record at all
//       → failed_delivery_return (Hoàn Hủy)
//   else → null (not a return operation; e.g. cancelled before shipping,
//          completed normally, refund-only return)
//
// The SQL mirror is public.return_failed_delivery_candidate() (00060) — a
// parity test (return-operations.integration.test.ts) keeps both equal.
// TO_RETURN without a return record is NOT classified (unconfirmed provider
// semantics — docs §API validation).
// Pure: no I/O.
// ============================================================

export type ReturnOperationType = "customer_return" | "failed_delivery_return";
export const RETURN_OPERATION_TYPES: readonly ReturnOperationType[] = ["customer_return", "failed_delivery_return"];

export const RETURN_OPERATION_LABELS: Record<ReturnOperationType, string> = {
  customer_return: "Hoàn Trả",
  failed_delivery_return: "Hoàn Hủy",
};

export const isReturnOperationType = (v: unknown): v is ReturnOperationType => v === "customer_return" || v === "failed_delivery_return";

/** Package statuses proving the parcel left the seller (or failed on the way to the buyer). CANDIDATE values. */
export const SHIPPED_PACKAGE_STATUSES: readonly string[] = [
  "LOGISTICS_PICKUP_DONE",
  "LOGISTICS_DELIVERY_FAILED",
  "LOGISTICS_COD_REJECTED",
  "LOGISTICS_LOST",
  "LOGISTICS_DELIVERY_DONE",
];

export interface ClassifyInput {
  orderStatus: string | null;
  pickupDoneAt: string | null;
  packageLogisticsStatus: string | null;
  /** Every customer return record of the order (any status). */
  returns: Array<{ status: string | null; needsLogistics: boolean | null }>;
}

export function isCustomerReturnTracked(r: { status: string | null; needsLogistics: boolean | null }): boolean {
  return (r.status ?? "").toUpperCase() !== "CANCELLED" && r.needsLogistics !== false;
}

export function classifyReturnOperation(input: ClassifyInput): ReturnOperationType | null {
  if (input.returns.some(isCustomerReturnTracked)) return "customer_return";
  if (input.returns.length > 0) return null;
  if ((input.orderStatus ?? "").toUpperCase() !== "CANCELLED") return null;
  const pkg = (input.packageLogisticsStatus ?? "").toUpperCase();
  const shipped = !!input.pickupDoneAt || SHIPPED_PACKAGE_STATUSES.includes(pkg);
  return shipped ? "failed_delivery_return" : null;
}
