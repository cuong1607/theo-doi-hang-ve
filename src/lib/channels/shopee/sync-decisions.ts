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
//     unless the status differs or an ACTIVE order is older than the TTL
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
}

export interface OrderListEntry {
  orderSn: string;
  orderStatus: string | null;
  /** ISO; only when the provider list carries it (Shopee's currently does not). */
  updateTime?: string | null;
}

export interface OrderRefreshContext {
  windowFrom: Date;
  windowTo: Date;
  now: Date;
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
  if (isOrderActive(local.orderStatus) && ctx.now.getTime() - synced > ctx.activeOrderTtlMinutes * 60_000) {
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
