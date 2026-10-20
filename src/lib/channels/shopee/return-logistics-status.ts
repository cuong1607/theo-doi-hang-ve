// ============================================================
// PHASE SHOPEE-6B: the ONE mapping of return-logistics provider statuses →
// canonical return-operation statuses (UI + sync import from here only).
//
//   Hoàn Trả  v2.returns.get_reverse_tracking_info
//             reverse_logistics_status / post_return_logistics_status
//             (documented family LOGISTICS_*)
//   Hoàn Hủy  v2.logistics.get_tracking_info
//             tracking_info[].logistics_status (documented TrackingLogisticsStatus
//             family: PICKED_UP, DELIVERED, RETURN_STARTED, RETURNED, …) and the
//             package-level logistics_status (LOGISTICS_*)
//
// EVERY provider value below is a CANDIDATE taken from the documented enums —
// NOT yet confirmed on a real VN payload (docs/shopee-return-operations.md
// §API validation). Unknown values map to "unknown" (shown raw, flagged
// needs_attention), never to a guessed status. Description text is NEVER
// parsed for meaning.
// Pure: no I/O.
// ============================================================

export const RETURN_OP_CANONICAL_STATUSES = [
  "pending",
  "in_transit_to_seller",
  "out_for_delivery_to_seller",
  "delivered_to_seller",
  "delivery_failed",
  "lost",
  "cancelled",
  "unknown",
] as const;
export type ReturnOpCanonicalStatus = (typeof RETURN_OP_CANONICAL_STATUSES)[number];

export type ReturnLogisticsSegment = "post_return" | "reverse" | "failed_delivery_rts";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const RETURN_OP_STATUS_INFO: Record<ReturnOpCanonicalStatus, { label: string; tone: Tone }> = {
  pending: { label: "Chờ vận chuyển", tone: "neutral" },
  in_transit_to_seller: { label: "Đang hoàn về shop", tone: "info" },
  out_for_delivery_to_seller: { label: "Đang giao về shop", tone: "info" },
  delivered_to_seller: { label: "Đã giao về shop", tone: "success" },
  delivery_failed: { label: "Giao về shop thất bại", tone: "danger" },
  lost: { label: "Thất lạc", tone: "danger" },
  cancelled: { label: "Đã huỷ", tone: "neutral" },
  unknown: { label: "Không rõ trạng thái", tone: "warning" },
};

export const isReturnOpCanonicalStatus = (v: unknown): v is ReturnOpCanonicalStatus =>
  typeof v === "string" && (RETURN_OP_CANONICAL_STATUSES as readonly string[]).includes(v);

/**
 * Reverse / post-return logistics status (Hoàn Trả). Same LOGISTICS_* family
 * for both segments; which segment ends at the seller is decided by
 * pickReturnSegment, not here. CANDIDATE values.
 */
const RETURN_SEGMENT_STATUS: Record<string, ReturnOpCanonicalStatus> = {
  LOGISTICS_NOT_START: "pending",
  LOGISTICS_PENDING_ARRANGE: "pending",
  LOGISTICS_READY: "pending",
  LOGISTICS_REQUEST_CREATED: "pending",
  LOGISTICS_PICKUP_RETRY: "pending",
  LOGISTICS_PICKUP_DONE: "in_transit_to_seller",
  LOGISTICS_IN_TRANSIT: "in_transit_to_seller",
  LOGISTICS_OUT_FOR_DELIVERY: "out_for_delivery_to_seller",
  LOGISTICS_DELIVERY_DONE: "delivered_to_seller",
  LOGISTICS_DELIVERY_FAILED: "delivery_failed",
  LOGISTICS_PICKUP_FAILED: "delivery_failed",
  LOGISTICS_LOST: "lost",
  LOGISTICS_REQUEST_CANCELED: "cancelled",
  LOGISTICS_REQUEST_CANCELLED: "cancelled",
};

/**
 * Failed-delivery RTS (Hoàn Hủy) — per tracking event (TrackingLogisticsStatus)
 * and the package-level LOGISTICS_* status. The parcel travelled to the buyer
 * first, so DELIVERED / LOGISTICS_DELIVERY_DONE here mean "delivered to the
 * BUYER" — NOT to the seller — and must never be read as returned.
 * CANDIDATE values.
 */
const RTS_EVENT_STATUS: Record<string, ReturnOpCanonicalStatus> = {
  // outbound leg (towards the buyer): the return has not started yet
  INITIAL: "pending",
  ORDER_INIT: "pending",
  ORDER_SUBMITTED: "pending",
  ORDER_FINALIZED: "pending",
  ORDER_CREATED: "pending",
  PICKUP_REQUESTED: "pending",
  PICKUP_PENDING: "pending",
  PICKED_UP: "pending",
  DELIVERY_PENDING: "pending",
  PICKUP_RETRY: "pending",
  UPDATE: "pending",
  UPDATE_SUBMITTED: "pending",
  UPDATE_CREATED: "pending",
  // delivery to the BUYER failed → the parcel is due back, the return leg
  // has not been reported yet (the trigger of Hoàn Hủy, not a problem of it)
  FAILED_DELIVERED: "pending",
  TIMEOUT: "pending",
  // return leg (towards the seller)
  RETURN_INITIATED: "in_transit_to_seller",
  RETURN_STARTED: "in_transit_to_seller",
  RETURN_PENDING: "in_transit_to_seller",
  RETURNED: "delivered_to_seller",
  FAILED_RETURNED: "delivery_failed",
  FAILED_RETURN_STARTED: "delivery_failed",
  LOST: "lost",
};

const RTS_PACKAGE_STATUS: Record<string, ReturnOpCanonicalStatus> = {
  // outbound failure (to the buyer) → waiting for the return leg
  LOGISTICS_DELIVERY_FAILED: "pending",
  LOGISTICS_COD_REJECTED: "pending",
  LOGISTICS_LOST: "lost",
  LOGISTICS_PICKUP_DONE: "pending",
  LOGISTICS_REQUEST_CANCELED: "cancelled",
};

const norm = (s: string | null | undefined) => (typeof s === "string" && s.trim() ? s.trim().toUpperCase() : null);

/** Centralized provider status → canonical status. null provider status → "pending" (nothing reported yet). */
export function mapReturnLogisticsStatus(segment: ReturnLogisticsSegment, providerStatus: string | null | undefined, level: "status" | "event" = "status"): ReturnOpCanonicalStatus {
  const s = norm(providerStatus);
  if (!s) return "pending";
  if (segment === "failed_delivery_rts") {
    const table = level === "event" ? RTS_EVENT_STATUS : RTS_PACKAGE_STATUS;
    return table[s] ?? (level === "status" ? RTS_EVENT_STATUS[s] : undefined) ?? "unknown";
  }
  return RETURN_SEGMENT_STATUS[s] ?? "unknown";
}

/** Event-level "this event = parcel delivered back to the seller/shop". */
export function isDeliveredToSellerEvent(segment: ReturnLogisticsSegment, providerStatus: string | null | undefined): boolean {
  return mapReturnLogisticsStatus(segment, providerStatus, "event") === "delivered_to_seller";
}

export function returnOpStatusInfo(status: string | null | undefined) {
  return isReturnOpCanonicalStatus(status) ? RETURN_OP_STATUS_INFO[status] : RETURN_OP_STATUS_INFO.unknown;
}

// ------------------------------------------------------------ attention

export const ATTENTION_REASONS = ["delivered_but_not_confirmed", "stuck_in_return_transit", "tracking_missing", "delivery_failed", "lost", "unknown_status"] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const ATTENTION_LABELS: Record<AttentionReason, string> = {
  delivered_but_not_confirmed: "Vận chuyển báo đã giao — chưa xác nhận nhận",
  stuck_in_return_transit: "Kẹt trên đường hoàn quá lâu",
  tracking_missing: "Chưa có mã vận đơn hoàn",
  delivery_failed: "Giao hoàn thất bại",
  lost: "Thất lạc",
  unknown_status: "Trạng thái vận chuyển lạ",
};

export const attentionLabel = (reason: string | null | undefined) =>
  reason && (ATTENTION_REASONS as readonly string[]).includes(reason) ? ATTENTION_LABELS[reason as AttentionReason] : reason ?? "";
