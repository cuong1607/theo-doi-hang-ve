// ============================================================
// PHASE UIUX-1: status → semantic tone, in ONE place (pure — unit tested).
//
//   success  done / healthy        (Đã đồng bộ, Hoàn thành, Khớp, Có lãi)
//   warning  needs attention       (Đang thử lại, Thiếu, Một phần, Lệch nhỏ)
//   danger   broken / loss         (Thất bại, Lệch đối soát, Xung đột, Lỗ)
//   info     in progress           (Đang đồng bộ, Đang giao)
//   neutral  not started / n.a.    (Chưa đồng bộ, Đang chờ, Chưa ghép, Đã hủy)
//
// Colour is never the only signal: StatusBadge always renders the label
// (+ an icon per tone). "Chưa ghép" is neutral on its own — pages raise it
// to warning only where it blocks something (e.g. an order line).
// ============================================================

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/** Sync matrix state (src/lib/channels/core/sync-display.ts). */
export const SYNC_STATE_TONE: Record<string, Tone> = {
  never: "neutral",
  queued: "neutral",
  syncing: "info",
  retrying: "warning",
  synced: "success",
  failed: "danger",
};

/** channel_sync_jobs.status */
export const JOB_STATUS_TONE: Record<string, Tone> = {
  pending: "neutral",
  running: "info",
  retry: "warning",
  success: "success",
  failed: "danger",
  cancelled: "neutral",
};

/** channel_product_models.mapping_status */
export const MAPPING_STATUS_TONE: Record<string, Tone> = {
  unmapped: "neutral",
  auto_mapped: "success",
  manual_mapped: "success",
  mapping_conflict: "danger",
};

/** Order mapping readiness (v_channel_order_summary). */
export const READINESS_TONE: Record<string, Tone> = {
  complete: "success",
  partial: "warning",
  unmapped: "warning",
  no_items: "neutral",
};

/** Order COGS readiness. */
export const COGS_READINESS_TONE: Record<string, Tone> = {
  complete: "success",
  partial: "warning",
  incomplete: "neutral",
};

/** order_financials.reconciliation_status */
export const RECONCILIATION_TONE: Record<string, Tone> = {
  matched: "success",
  warning: "warning",
  mismatch: "danger",
};

/** channel_orders.financial_status */
export const FINANCIAL_STATUS_TONE: Record<string, Tone> = {
  pending: "neutral",
  estimated: "info",
  settlement_available: "success",
  released: "success",
  mismatch: "danger",
  return_adjusted: "warning",
};

/** Shopee order status. */
export const ORDER_STATUS_TONE: Record<string, Tone> = {
  UNPAID: "neutral",
  READY_TO_SHIP: "info",
  PROCESSED: "info",
  RETRY_SHIP: "warning",
  SHIPPED: "info",
  TO_CONFIRM_RECEIVE: "info",
  IN_CANCEL: "warning",
  CANCELLED: "neutral",
  TO_RETURN: "warning",
  COMPLETED: "success",
};

/** Outstanding goods status (src/lib/outstanding). */
export const OUTSTANDING_STATUS_TONE: Record<string, Tone> = {
  need_makeup: "warning",
  low: "info",
  complete: "success",
  normal: "neutral",
};

/** Supplier invoice payment status (src/lib/debt). */
export const PAYMENT_STATUS_TONE: Record<string, Tone> = {
  unpaid: "warning",
  partial: "info",
  paid: "success",
};

/** Unknown statuses fall back to neutral — never a scary colour by accident. */
export function toneOf(map: Record<string, Tone>, status: string | null | undefined): Tone {
  return (status && map[status]) || "neutral";
}

/**
 * Money semantics: colour ONLY a profit/loss figure (not every amount).
 * Positive → success, negative → danger, zero / unknown → neutral.
 */
export function profitTone(sign: 1 | -1 | 0 | null): Tone {
  return sign === 1 ? "success" : sign === -1 ? "danger" : "neutral";
}

/** Tailwind classes per tone (tokens from globals.css — no raw palette colours). */
export const TONE_BADGE_CLASS: Record<Tone, string> = {
  success: "border-success/25 bg-success-soft text-success-text",
  warning: "border-warning/35 bg-warning-soft text-warning-text",
  danger: "border-destructive/25 bg-danger-soft text-danger-text",
  info: "border-info/25 bg-info-soft text-info-text",
  neutral: "border-border bg-muted text-muted-foreground",
};

export const TONE_TEXT_CLASS: Record<Tone, string> = {
  success: "text-success-text",
  warning: "text-warning-text",
  danger: "text-danger-text",
  info: "text-info-text",
  neutral: "text-foreground",
};

export const TONE_CALLOUT_CLASS: Record<Tone, string> = {
  success: "border-success/30 bg-success-soft text-success-text",
  warning: "border-warning/40 bg-warning-soft text-warning-text",
  danger: "border-destructive/30 bg-danger-soft text-danger-text",
  info: "border-info/30 bg-info-soft text-info-text",
  neutral: "border-border bg-muted/50 text-muted-foreground",
};
