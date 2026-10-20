// ============================================================
// PHASE SHOPEE-PERF-1: "does this record need a detail call?" (pure).
//
// The main performance win of incremental sync: a listing/order discovered
// again is only re-fetched when something may have changed. Kept out of the
// sync loops so the rules are visible and unit-tested.
//
// Orders — get_order_list (time_range_field = update_time) returns order_sn
// + order_status but NO update_time per order. Listing an order in window
// [from, to] means its provider update_time u ∈ [from, to]. So:
//   • local last_synced_at ≥ to   → our copy was fetched after u → unchanged
//   • local last_synced_at < from → the order changed after our last fetch
//   • in between (the overlap re-read, a repeated manual sync): unchanged
//     unless the status differs or an ACTIVE order is older than its
//     status TTL (ORDER_DETAIL_TTL_MINUTES)
// If a provider ever returns update_time in the list, it is compared too.
// ============================================================
import { isOrderActive } from "./order-status.ts";

export type RefreshReason =
  | "new"
  | "forced"
  | "status_changed"
  | "update_time_changed"
  | "detail_missing"
  | "changed_since_last_sync"
  | "active_stale";

export type RefreshDecision = { refresh: true; reason: RefreshReason } | { refresh: false; reason: "unchanged" };

export interface LocalOrderState {
  orderStatus: string;
  updatedAtChannel: string | null;
  lastSyncedAt: string | null;
  lineCount: number;
  /** ISO create time of the stored order (orders-sync cutoff check). */
  createdAtChannel?: string | null;
}

/** Shopee order_sn starts with the order's creation day as YYMMDD (e.g. 261017… = 17/10/2026). */
const ORDER_SN_DAY = /^(\d{2})(\d{2})(\d{2})/;
/** The SN day ends at most 36 h after its UTC midnight (UTC−12) — the safe "whole day is over" point. */
const SN_DAY_END_MS = 36 * 3_600_000;

/**
 * PATCH orders-sync cutoff (00055): is this listed order created BEFORE the
 * cutoff, so it must not be fetched? Known locally → always fetched (refresh).
 * Unknown → the order_sn day, only when that whole day (in ANY time zone)
 * lies before the cutoff; anything unsure is fetched and the
 * detail's create_time decides (isCreatedBeforeCutoff).
 */
export function isOrderBeforeSyncCutoff(orderSn: string, local: Pick<LocalOrderState, "createdAtChannel"> | null, cutoff: Date | null): boolean {
  if (!cutoff) return false;
  // SHOPEE-6B fix: the cutoff only stops IMPORTING history. An order already
  // stored keeps being refreshed (SHIPPED → CANCELLED / COMPLETED …) whatever
  // its create time — otherwise failed deliveries and completions of orders
  // in transit at cutoff time are never seen.
  if (local) return false;
  const m = ORDER_SN_DAY.exec(orderSn);
  if (!m) return false;
  const [y, mo, d] = [2000 + Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  return Date.UTC(y, mo - 1, d) + SN_DAY_END_MS <= cutoff.getTime();
}

/** Final check on the detail: created strictly before the cutoff (unknown create time → keep). */
export function isCreatedBeforeCutoff(createdAt: string | null | undefined, cutoff: Date | null): boolean {
  if (!cutoff || !createdAt) return false;
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) && t < cutoff.getTime();
}

export interface OrderListEntry {
  orderSn: string;
  orderStatus: string | null;
  /** ISO; only when the provider list carries it (Shopee's currently does not). */
  updateTime?: string | null;
}

/**
 * SHOPEE-PERF-2: how long a stored copy of an order in this status stays
 * fresh when the order is listed again with the same status. The ONLY place
 * these numbers live. null = never re-fetched by age (final statuses: only
 * a status change, a newer update_time or a repair fetches them). Active
 * statuses not listed use SHOPEE_SYNC_ACTIVE_ORDER_TTL_MINUTES.
 */
export const ORDER_DETAIL_TTL_MINUTES: Readonly<Record<string, number | null>> = {
  UNPAID: 30,
  READY_TO_SHIP: 30,
  PROCESSED: 30,
  RETRY_SHIP: 30,
  SHIPPED: 60,
  TO_CONFIRM_RECEIVE: 60,
  IN_CANCEL: 15,
  TO_RETURN: 60,
  COMPLETED: null,
  CANCELLED: null,
};

export function orderDetailTtlMinutes(status: string, fallbackActiveTtlMinutes: number): number | null {
  if (status in ORDER_DETAIL_TTL_MINUTES) return ORDER_DETAIL_TTL_MINUTES[status];
  return isOrderActive(status) ? fallbackActiveTtlMinutes : null;
}

export interface OrderRefreshContext {
  windowFrom: Date;
  windowTo: Date;
  now: Date;
  /** Fallback TTL for active statuses missing from ORDER_DETAIL_TTL_MINUTES. */
  activeOrderTtlMinutes: number;
  /** repair / explicitly requested order_sn → always fetch. */
  force?: boolean;
}

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);

export function shouldRefreshOrderDetail(local: LocalOrderState | null, entry: OrderListEntry, ctx: OrderRefreshContext): RefreshDecision {
  if (!local) return { refresh: true, reason: "new" };
  if (ctx.force) return { refresh: true, reason: "forced" };
  if (entry.orderStatus && entry.orderStatus !== local.orderStatus) return { refresh: true, reason: "status_changed" };
  if (entry.updateTime && ms(entry.updateTime) !== ms(local.updatedAtChannel)) return { refresh: true, reason: "update_time_changed" };
  if (local.lineCount === 0) return { refresh: true, reason: "detail_missing" };
  const synced = ms(local.lastSyncedAt);
  if (!Number.isFinite(synced)) return { refresh: true, reason: "detail_missing" };
  if (synced >= ctx.windowTo.getTime()) return { refresh: false, reason: "unchanged" };
  if (synced < ctx.windowFrom.getTime()) return { refresh: true, reason: "changed_since_last_sync" };
  const ttl = orderDetailTtlMinutes(local.orderStatus, ctx.activeOrderTtlMinutes);
  if (ttl !== null && ctx.now.getTime() - synced > ttl * 60_000) {
    return { refresh: true, reason: "active_stale" };
  }
  return { refresh: false, reason: "unchanged" };
}

// ------------------------------------------------------------ products
//
// get_item_list DOES carry update_time per item. A listing is re-fetched
// (get_item_base_info + get_model_list) when it is new, its update_time
// differs from channel_products.source_updated_at, or no unit of it is
// stored locally (an earlier detail fetch failed half-way).

export interface LocalProductState {
  sourceUpdatedAt: string | null;
  /** Units stored for this listing (synthetic NO_MODEL counts). */
  modelCount: number;
}

export interface ItemListEntry {
  externalItemId: string;
  updateTime: string | null;
}

export function shouldRefreshProductDetail(local: LocalProductState | null, entry: ItemListEntry, options: { force?: boolean } = {}): RefreshDecision {
  if (!local) return { refresh: true, reason: "new" };
  if (options.force) return { refresh: true, reason: "forced" };
  if (local.modelCount === 0) return { refresh: true, reason: "detail_missing" };
  if (!entry.updateTime || !local.sourceUpdatedAt) return { refresh: true, reason: "update_time_changed" };
  if (ms(entry.updateTime) !== ms(local.sourceUpdatedAt)) return { refresh: true, reason: "update_time_changed" };
  return { refresh: false, reason: "unchanged" };
}
