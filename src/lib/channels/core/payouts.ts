// ============================================================
// PHASE SHOPEE-7: income release + payout reconciliation — services and read
// models (channel-agnostic). Every formula lives in the database (migration
// 00058); this module only calls it and reads its results:
//
//   reconcileOrderRelease          reconcile_order_release: expected =
//                                  actual_shopee_income; actual = released +
//                                  order adjustments after the release
//   reconcilePayout                reconcile_payout: link orders, per-order
//   calculatePayoutExpectedAmount    difference, expected = Σ releases +
//                                  Σ adjustments (+ wallet opening − closing),
//                                  status pending/incomplete/matched/mismatch
//   resolvePayoutMismatch          add_payout_reconciliation_note: audit note
//                                  + resolution status; numbers never change
//   getCashflowSummary             finance operational metrics (cash, not profit)
//
// Money is a NUMERIC string end to end (views cast ::text); no JS arithmetic.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

export const INCOME_STATUSES = ["not_available", "pending", "released", "reconciled", "mismatch"] as const;
export type IncomeStatus = (typeof INCOME_STATUSES)[number];
export const PAYOUT_RECONCILIATION_STATUSES = ["pending", "incomplete", "matched", "mismatch"] as const;
export type PayoutReconciliationStatus = (typeof PAYOUT_RECONCILIATION_STATUSES)[number];
export const PAYOUT_RESOLUTION_STATUSES = ["open", "investigating", "resolved", "accepted"] as const;
export type PayoutResolutionStatus = (typeof PAYOUT_RESOLUTION_STATUSES)[number];

export const isPayoutReconciliationStatus = (v: unknown): v is PayoutReconciliationStatus => typeof v === "string" && (PAYOUT_RECONCILIATION_STATUSES as readonly string[]).includes(v);
export const isPayoutResolutionStatus = (v: unknown): v is PayoutResolutionStatus => typeof v === "string" && (PAYOUT_RESOLUTION_STATUSES as readonly string[]).includes(v);

export class PayoutReconciliationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PayoutReconciliationError";
    this.code = code;
  }
}

// ------------------------------------------------------------- services

export async function reconcileOrderRelease(db: SupabaseClient, releaseId: string): Promise<IncomeStatus | null> {
  const { data, error } = await db.rpc("reconcile_order_release", { p_release_id: releaseId });
  if (error) throw new Error(error.message);
  return (data as IncomeStatus | null) ?? null;
}

export async function reconcilePayout(db: SupabaseClient, payoutId: string): Promise<PayoutReconciliationStatus | null> {
  const { data, error } = await db.rpc("reconcile_payout", { p_payout_id: payoutId });
  if (error) throw new Error(error.message);
  return (data as PayoutReconciliationStatus | null) ?? null;
}

/** Recomputes and returns the stored breakdown (the formula is SQL's). */
export async function calculatePayoutExpectedAmount(db: SupabaseClient, payoutId: string): Promise<PayoutBreakdown | null> {
  await reconcilePayout(db, payoutId);
  const payout = await getPayout(db, payoutId);
  return payout ? payoutBreakdown(payout) : null;
}

export async function resolvePayoutMismatch(
  db: SupabaseClient,
  input: { payoutId: string; note: string; resolutionStatus: PayoutResolutionStatus | null; resolutionReason?: string | null; by: string | null },
): Promise<string> {
  if (!input.note.trim()) throw new PayoutReconciliationError("PO013", "Cần nội dung ghi chú.");
  if (input.resolutionStatus !== null && !isPayoutResolutionStatus(input.resolutionStatus)) throw new PayoutReconciliationError("PO011", "Trạng thái xử lý không hợp lệ.");
  const { data, error } = await db.rpc("add_payout_reconciliation_note", {
    p_payout_id: input.payoutId,
    p_note: input.note,
    p_resolution_status: input.resolutionStatus,
    p_resolution_reason: input.resolutionReason ?? null,
    p_by: input.by,
  });
  if (error) {
    if (error.code?.startsWith("PO")) throw new PayoutReconciliationError(error.code, error.message);
    throw new Error(error.message);
  }
  console.info(JSON.stringify({ source: "payouts", event: "payout_reconciliation_note", payoutId: input.payoutId, resolution: input.resolutionStatus }));
  return data as string;
}

// ---------------------------------------------------------------- reads

export interface PayoutRow {
  id: string;
  shopId: string;
  shopName: string;
  providerPayoutId: string;
  payoutSource: string | null;
  payoutStatus: "pending" | "completed" | "cancelled";
  currency: string;
  payoutAmount: string;
  payoutTime: string | null;
  paymentMethod: string | null;
  bankReference: string | null;
  ordersReleasedTotal: string | null;
  adjustmentsTotal: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  expectedAmount: string | null;
  differenceAmount: string | null;
  orderCount: number;
  missingOrderCount: number;
  adjustmentCount: number;
  reconciliationStatus: PayoutReconciliationStatus;
  incompleteReason: string | null;
  reconciledAt: string | null;
  lastProviderAmount: string | null;
  resolutionStatus: PayoutResolutionStatus;
  resolutionReason: string | null;
  resolvedAt: string | null;
  syncedAt: string | null;
}

type OverviewRow = {
  id: string;
  shop_id: string;
  shop_name: string;
  provider_payout_id: string;
  payout_source: string | null;
  payout_status: PayoutRow["payoutStatus"];
  currency: string;
  payout_amount: string;
  payout_time: string | null;
  payment_method: string | null;
  bank_reference: string | null;
  orders_released_total: string | null;
  adjustments_total: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  expected_amount: string | null;
  difference_amount: string | null;
  order_count: number;
  missing_order_count: number;
  adjustment_count: number;
  reconciliation_status: PayoutReconciliationStatus;
  incomplete_reason: string | null;
  reconciled_at: string | null;
  last_provider_amount: string | null;
  resolution_status: PayoutResolutionStatus;
  resolution_reason: string | null;
  resolved_at: string | null;
  synced_at: string | null;
};

const toPayout = (r: OverviewRow): PayoutRow => ({
  id: r.id,
  shopId: r.shop_id,
  shopName: r.shop_name,
  providerPayoutId: r.provider_payout_id,
  payoutSource: r.payout_source,
  payoutStatus: r.payout_status,
  currency: r.currency,
  payoutAmount: r.payout_amount,
  payoutTime: r.payout_time,
  paymentMethod: r.payment_method,
  bankReference: r.bank_reference,
  ordersReleasedTotal: r.orders_released_total,
  adjustmentsTotal: r.adjustments_total,
  openingBalance: r.opening_balance,
  closingBalance: r.closing_balance,
  expectedAmount: r.expected_amount,
  differenceAmount: r.difference_amount,
  orderCount: r.order_count,
  missingOrderCount: r.missing_order_count,
  adjustmentCount: r.adjustment_count,
  reconciliationStatus: r.reconciliation_status,
  incompleteReason: r.incomplete_reason,
  reconciledAt: r.reconciled_at,
  lastProviderAmount: r.last_provider_amount,
  resolutionStatus: r.resolution_status,
  resolutionReason: r.resolution_reason,
  resolvedAt: r.resolved_at,
  syncedAt: r.synced_at,
});

export interface PayoutListFilters {
  shopId?: string;
  status?: PayoutReconciliationStatus;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

/** dd boundaries are VN days: `YYYY-MM-DD` → [00:00, 24:00) +07. */
const vnDayStart = (d: string) => `${d}T00:00:00+07:00`;
const vnDayEnd = (d: string) => new Date(new Date(`${d}T00:00:00+07:00`).getTime() + 86_400_000).toISOString();

export async function listPayouts(db: SupabaseClient, filters: PayoutListFilters, page: number, pageSize: number): Promise<{ rows: PayoutRow[]; total: number }> {
  const from = (page - 1) * pageSize;
  let q = db.from("v_payout_overview").select("*", { count: "exact" });
  if (filters.shopId) q = q.eq("shop_id", filters.shopId);
  if (filters.status) q = q.eq("reconciliation_status", filters.status);
  if (filters.dateFrom) q = q.gte("payout_time", vnDayStart(filters.dateFrom));
  if (filters.dateTo) q = q.lt("payout_time", vnDayEnd(filters.dateTo));
  if (filters.search?.trim()) q = q.ilike("provider_payout_id", `%${filters.search.trim().replace(/[%_,()]/g, "")}%`);
  const { data, error, count } = await q.order("payout_time", { ascending: false, nullsFirst: false }).range(from, from + pageSize - 1);
  if (error) throw new Error(`Không đọc được payout: ${error.message}`);
  return { rows: ((data ?? []) as OverviewRow[]).map(toPayout), total: count ?? 0 };
}

export async function getPayout(db: SupabaseClient, payoutId: string): Promise<PayoutRow | null> {
  const { data, error } = await db.from("v_payout_overview").select("*").eq("id", payoutId).maybeSingle<OverviewRow>();
  if (error) throw new Error(`Không đọc được payout: ${error.message}`);
  return data ? toPayout(data) : null;
}

export interface PayoutBreakdown {
  ordersReleasedTotal: string | null;
  adjustmentsTotal: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  expectedAmount: string | null;
  payoutAmount: string;
  differenceAmount: string | null;
}

export const payoutBreakdown = (p: PayoutRow): PayoutBreakdown => ({
  ordersReleasedTotal: p.ordersReleasedTotal,
  adjustmentsTotal: p.adjustmentsTotal,
  openingBalance: p.openingBalance,
  closingBalance: p.closingBalance,
  expectedAmount: p.expectedAmount,
  payoutAmount: p.payoutAmount,
  differenceAmount: p.differenceAmount,
});

export interface PayoutOrderRow {
  externalOrderSn: string;
  orderId: string | null;
  releasedAmount: string;
  expectedAmount: string | null;
  differenceAmount: string | null;
  currency: string;
  occurredAt: string | null;
}

export async function getPayoutOrders(db: SupabaseClient, payoutId: string): Promise<PayoutOrderRow[]> {
  const { data, error } = await db
    .from("payout_orders")
    .select("external_order_sn, order_id, escrow_amount::text, expected_amount::text, difference_amount::text, currency, occurred_at")
    .eq("payout_id", payoutId)
    .order("occurred_at", { ascending: true, nullsFirst: false })
    .order("external_order_sn");
  if (error) throw new Error(`Không đọc được đơn của payout: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, string | null>>).map((r) => ({
    externalOrderSn: r.external_order_sn as string,
    orderId: r.order_id,
    releasedAmount: r.escrow_amount as string,
    expectedAmount: r.expected_amount,
    differenceAmount: r.difference_amount,
    currency: r.currency as string,
    occurredAt: r.occurred_at,
  }));
}

export interface PayoutAdjustmentRow {
  id: string;
  adjustmentType: string | null;
  description: string | null;
  amount: string;
  currency: string | null;
  externalOrderSn: string | null;
  orderId: string | null;
  occurredAt: string | null;
}

export async function getPayoutAdjustments(db: SupabaseClient, payoutId: string): Promise<PayoutAdjustmentRow[]> {
  const { data, error } = await db
    .from("payout_adjustments")
    .select("id, adjustment_type, description, remark, adjustment_amount::text, currency, external_order_sn, order_id, occurred_at")
    .eq("payout_id", payoutId)
    .order("occurred_at", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Không đọc được điều chỉnh: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, string | null>>).map((r) => ({
    id: r.id as string,
    adjustmentType: r.adjustment_type,
    description: r.description ?? r.remark,
    amount: r.adjustment_amount as string,
    currency: r.currency,
    externalOrderSn: r.external_order_sn,
    orderId: r.order_id,
    occurredAt: r.occurred_at,
  }));
}

export interface PayoutNoteRow {
  id: string;
  note: string;
  resolutionStatus: PayoutResolutionStatus | null;
  resolutionReason: string | null;
  differenceAtNote: string | null;
  createdByName: string | null;
  createdAt: string;
}

export async function getPayoutNotes(db: SupabaseClient, payoutId: string): Promise<PayoutNoteRow[]> {
  const { data, error } = await db
    .from("payout_reconciliation_notes")
    .select("id, note, resolution_status, resolution_reason, difference_at_note::text, created_at, profiles(full_name)")
    .eq("payout_id", payoutId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Không đọc được ghi chú: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const prof = r.profiles as { full_name?: string | null } | Array<{ full_name?: string | null }> | null;
    const name = Array.isArray(prof) ? prof[0]?.full_name : prof?.full_name;
    return {
      id: r.id as string,
      note: r.note as string,
      resolutionStatus: (r.resolution_status as PayoutResolutionStatus | null) ?? null,
      resolutionReason: (r.resolution_reason as string | null) ?? null,
      differenceAtNote: (r.difference_at_note as string | null) ?? null,
      createdByName: name ?? null,
      createdAt: r.created_at as string,
    };
  });
}

export interface OrderIncomeStatusRow {
  orderId: string;
  shopId: string;
  externalOrderSn: string;
  orderStatus: string;
  currency: string;
  completedAtChannel: string | null;
  expectedAmount: string | null;
  releaseId: string | null;
  releasedAmount: string | null;
  laterAdjustmentAmount: string | null;
  differenceAmount: string | null;
  actualPayoutTime: string | null;
  paymentMethod: string | null;
  releaseSource: string | null;
  incomeSyncedAt: string | null;
  incomeStatus: IncomeStatus;
  releaseStale: boolean;
  daysToRelease: string | null;
  payoutId: string | null;
  providerPayoutId: string | null;
}

type IncomeViewRow = {
  order_id: string;
  shop_id: string;
  external_order_sn: string;
  order_status: string;
  currency: string;
  completed_at_channel: string | null;
  expected_amount: string | null;
  release_id: string | null;
  released_amount: string | null;
  later_adjustment_amount: string | null;
  difference_amount: string | null;
  actual_payout_time: string | null;
  payment_method: string | null;
  release_source: string | null;
  income_synced_at: string | null;
  income_status: IncomeStatus;
  release_stale: boolean;
  days_to_release: number | string | null;
  payout_id: string | null;
  provider_payout_id: string | null;
};

const toIncome = (r: IncomeViewRow): OrderIncomeStatusRow => ({
  orderId: r.order_id,
  shopId: r.shop_id,
  externalOrderSn: r.external_order_sn,
  orderStatus: r.order_status,
  currency: r.currency,
  completedAtChannel: r.completed_at_channel,
  expectedAmount: r.expected_amount,
  releaseId: r.release_id,
  releasedAmount: r.released_amount,
  laterAdjustmentAmount: r.later_adjustment_amount,
  differenceAmount: r.difference_amount,
  actualPayoutTime: r.actual_payout_time,
  paymentMethod: r.payment_method,
  releaseSource: r.release_source,
  incomeSyncedAt: r.income_synced_at,
  incomeStatus: r.income_status,
  releaseStale: r.release_stale === true,
  daysToRelease: r.days_to_release === null ? null : String(r.days_to_release),
  payoutId: r.payout_id,
  providerPayoutId: r.provider_payout_id,
});

export async function getOrderIncomeStatus(db: SupabaseClient, orderId: string): Promise<OrderIncomeStatusRow | null> {
  const { data, error } = await db.from("v_order_income_status").select("*").eq("order_id", orderId).maybeSingle<IncomeViewRow>();
  if (error) throw new Error(`Không đọc được trạng thái giải ngân: ${error.message}`);
  return data ? toIncome(data) : null;
}

/** Compact badge data for one page of the order list (bounded id list). */
export async function getOrdersIncomeStatus(db: SupabaseClient, orderIds: string[]): Promise<Map<string, { incomeStatus: IncomeStatus; releaseStale: boolean }>> {
  const out = new Map<string, { incomeStatus: IncomeStatus; releaseStale: boolean }>();
  if (orderIds.length === 0) return out;
  const { data, error } = await db.from("v_order_income_status").select("order_id, income_status, release_stale").in("order_id", orderIds.slice(0, 200));
  if (error) throw new Error(`Không đọc được trạng thái giải ngân: ${error.message}`);
  for (const r of (data ?? []) as Array<{ order_id: string; income_status: IncomeStatus; release_stale: boolean }>) out.set(r.order_id, { incomeStatus: r.income_status, releaseStale: r.release_stale === true });
  return out;
}

export interface CashflowSummary {
  pendingOrders: number;
  pendingAmount: string;
  pendingWithoutAmount: number;
  staleOrders: number;
  releaseMismatchOrders: number;
  releasedTodayAmount: string;
  releasedTodayOrders: number;
  payoutsUnreconciled: number;
  payoutsMismatch: number;
  payoutPeriodAmount: string;
  payoutPeriodCount: number;
}

export async function getCashflowSummary(db: SupabaseClient, input: { shopId?: string | null; from?: string | null; to?: string | null } = {}): Promise<CashflowSummary> {
  const { data, error } = await db.rpc("get_shopee_cashflow_summary", { p_shop_id: input.shopId ?? null, p_from: input.from ?? null, p_to: input.to ?? null });
  if (error) throw new Error(`Không đọc được số liệu dòng tiền: ${error.message}`);
  const r = data as Record<string, number | string>;
  return {
    pendingOrders: Number(r.pending_orders),
    pendingAmount: String(r.pending_amount),
    pendingWithoutAmount: Number(r.pending_without_amount),
    staleOrders: Number(r.stale_orders),
    releaseMismatchOrders: Number(r.release_mismatch_orders),
    releasedTodayAmount: String(r.released_today_amount),
    releasedTodayOrders: Number(r.released_today_orders),
    payoutsUnreconciled: Number(r.payouts_unreconciled),
    payoutsMismatch: Number(r.payouts_mismatch),
    payoutPeriodAmount: String(r.payout_period_amount),
    payoutPeriodCount: Number(r.payout_period_count),
  };
}

export interface IncomeOverviewRow {
  shopId: string;
  currency: string;
  pendingAmount: string | null;
  releasedAmount: string | null;
  localPendingAmount: string;
  localPendingOrders: number;
  localReleasedAmount: string;
  pendingDifference: string | null;
  releasedDifference: string | null;
  fetchedAt: string;
}

/** Latest get_income_overview snapshot per shop. */
export async function getLatestIncomeOverviews(db: SupabaseClient, shopIds: string[]): Promise<Map<string, IncomeOverviewRow>> {
  const out = new Map<string, IncomeOverviewRow>();
  for (const shopId of shopIds) {
    const { data, error } = await db
      .from("channel_income_overviews")
      .select(
        "shop_id, currency, pending_amount::text, released_amount::text, local_pending_amount::text, local_pending_orders, local_released_amount::text, pending_difference::text, released_difference::text, fetched_at",
      )
      .eq("shop_id", shopId)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Không đọc được tổng quan thu nhập: ${error.message}`);
    if (!data) continue;
    const r = data as unknown as Record<string, string | number | null>;
    out.set(shopId, {
      shopId,
      currency: r.currency as string,
      pendingAmount: r.pending_amount as string | null,
      releasedAmount: r.released_amount as string | null,
      localPendingAmount: r.local_pending_amount as string,
      localPendingOrders: Number(r.local_pending_orders),
      localReleasedAmount: r.local_released_amount as string,
      pendingDifference: r.pending_difference as string | null,
      releasedDifference: r.released_difference as string | null,
      fetchedAt: r.fetched_at as string,
    });
  }
  return out;
}
