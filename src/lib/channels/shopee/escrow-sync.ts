// ============================================================
// PHASE SHOPEE-5: escrow sync — one order (syncOrder) and the bounded queue
// job (EscrowSyncJobRunner, sync_type "escrow").
//
// syncOrder(orderId):
//   1. load order + shop, data-source guard, eligibility
//   2. get_escrow_detail (provider → token cache → client)
//   3. parse (escrow-adapter + financial dictionary)
//   4. meaningful raw snapshot (entity "escrow": every financially different
//      version kept, identical polls refresh in place)
//   5. apply_order_escrow() — components + order_financials + derived P&L /
//      reconciliation + financial_status, in ONE database transaction
// "Not ready" answers are recorded on the order (back-off), never retried in
// a loop. Job-level provider errors (rate limit / 5xx / auth) propagate so
// the job retries / stops with its checkpoint intact.
//
// Never: overwrite internal_cogs, reverse COGS on refunds (SHOPEE-6), mark
// "released" (income/payout phase), call Shopee from a page.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { saveMeaningfulOrderSnapshot } from "../core/snapshots.ts";
import { firstFailureSummary, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../core/sync-runner.ts";
import { ShopeeApiError } from "./errors.ts";
import { parseEscrowDetail } from "./escrow-adapter.ts";
import { FINANCIAL_CALCULATION_VERSION } from "./financial-dictionary.ts";
import type { ShopeePaymentProvider } from "./payment-provider.ts";
import { errorInfo, isJobLevelProviderError, JobRefusedError } from "./sync-errors.ts";

/** Statuses escrow is fetched for automatically (others only via repair). */
export const ESCROW_ELIGIBLE_STATUSES: readonly string[] = ["COMPLETED"];

export function isOrderEligibleForEscrowSync(order: { orderStatus: string }): boolean {
  return ESCROW_ELIGIBLE_STATUSES.includes(order.orderStatus);
}

/**
 * Provider answers meaning "no settlement for this order (yet)". Matched on
 * the error code / message wording; confirmed codes are listed in
 * docs/shopee-financial-validation.md.
 */
export function isEscrowNotReady(err: unknown): boolean {
  if (!(err instanceof ShopeeApiError)) return false;
  if (err.retryable || err.category === "auth" || err.category === "signature") return false;
  return /not.?found|not.?exist|no.?escrow|not.?ready|not.?complete|invalid.?order|order.?status/i.test(`${err.errorCode} ${err.message}`);
}

export type EscrowSyncStatus = "applied" | "unchanged" | "not_ready" | "ineligible" | "failed";

export interface EscrowSyncOutcome {
  status: EscrowSyncStatus;
  orderSn: string;
  reconciliationStatus: string | null;
  financialStatus: string | null;
  missingCogs: boolean;
  unknownFields: string[];
  errorCode?: string;
  errorMessage?: string;
}

type OrderRow = {
  id: string;
  shop_id: string;
  external_order_sn: string;
  order_status: string;
  currency: string;
  updated_at_channel: string | null;
  shops: { external_shop_id: string; data_source: string; channel: string } | null;
};

export class ShopeeEscrowSyncService {
  private readonly db: SupabaseClient;
  private readonly provider: ShopeePaymentProvider;
  private readonly now: () => Date;

  constructor(deps: { db: SupabaseClient; provider: ShopeePaymentProvider; now?: () => Date }) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.now = deps.now ?? (() => new Date());
  }

  async syncOrder(orderId: string, options: { force?: boolean } = {}): Promise<EscrowSyncOutcome> {
    const { data: order, error } = await this.db
      .from("channel_orders")
      .select("id, shop_id, external_order_sn, order_status, currency, updated_at_channel, shops!inner(external_shop_id, data_source, channel)")
      .eq("id", orderId)
      .maybeSingle<OrderRow>();
    if (error) throw new Error(`Không đọc được đơn: ${error.message}`);
    if (!order || !order.shops) throw new JobRefusedError("order_not_found", "Không tìm thấy đơn.");
    if (order.shops.channel !== "shopee") throw new JobRefusedError("not_shopee", "Đơn không thuộc kênh Shopee.");
    if (order.shops.data_source !== this.provider.mode) {
      throw new JobRefusedError("source_mismatch", order.shops.data_source === "fixture" ? "Shop fixture chỉ được đồng bộ bằng fixture provider." : "Không được đồng bộ dữ liệu fixture vào shop thật.");
    }
    const base = { orderSn: order.external_order_sn, reconciliationStatus: null, financialStatus: null, missingCogs: false, unknownFields: [] as string[] };
    if (!options.force && !isOrderEligibleForEscrowSync({ orderStatus: order.order_status })) return { ...base, status: "ineligible" };

    const syncedAt = this.now().toISOString();
    let payload;
    try {
      payload = await this.provider.getEscrowDetail({ shopId: order.shop_id, externalShopId: order.shops.external_shop_id }, { orderSn: order.external_order_sn });
    } catch (err) {
      if (isJobLevelProviderError(err)) throw err;
      const info = errorInfo(err);
      await this.recordAttempt(order.id, info.code, info.message, syncedAt);
      return { ...base, status: isEscrowNotReady(err) ? "not_ready" : "failed", errorCode: info.code, errorMessage: info.message };
    }

    let parsed;
    try {
      parsed = parseEscrowDetail(payload.raw, { currency: order.currency, expectedOrderSn: order.external_order_sn });
    } catch (err) {
      const info = errorInfo(err);
      await this.recordAttempt(order.id, info.code, info.message, syncedAt);
      return { ...base, status: "failed", errorCode: info.code, errorMessage: info.message };
    }

    await saveMeaningfulOrderSnapshot(this.db, {
      shopId: order.shop_id,
      orderSn: order.external_order_sn,
      entityType: "escrow",
      apiName: "v2.payment.get_escrow_detail",
      payload: parsed.sanitized,
      fingerprint: parsed.fingerprint,
      sourceMode: this.provider.mode,
      sourceUpdatedAt: order.updated_at_channel,
      syncedAt,
    });

    const { data: applied, error: applyError } = await this.db
      .rpc("apply_order_escrow", {
        p_order_id: order.id,
        p_fields: parsed.fields,
        p_components: parsed.components,
        p_fingerprint: parsed.fingerprint,
        p_synced_at: syncedAt,
        p_version: FINANCIAL_CALCULATION_VERSION,
      })
      .single<{ changed: boolean; reconciliation_status: string | null; financial_status: string | null }>();
    if (applyError || !applied) throw new Error(`Không lưu được tài chính đơn ${order.external_order_sn}: ${applyError?.message ?? "unknown"} [${applyError?.code ?? ""}]`);

    const { data: fin } = await this.db.from("order_financials").select("internal_cogs").eq("order_id", order.id).maybeSingle<{ internal_cogs: string | null }>();
    return {
      ...base,
      status: applied.changed ? "applied" : "unchanged",
      reconciliationStatus: applied.reconciliation_status,
      financialStatus: applied.financial_status,
      missingCogs: !fin || fin.internal_cogs === null,
      unknownFields: parsed.unknownFields,
    };
  }

  private async recordAttempt(orderId: string, code: string, message: string, at: string) {
    const { error } = await this.db.rpc("record_order_escrow_attempt", { p_order_id: orderId, p_error_code: code, p_error_message: message, p_at: at });
    if (error) throw new Error(`Không ghi được lần thử escrow: ${error.message}`);
  }
}

/** Repair scope cap (metadata must stay small). */
export const MAX_REPAIR_ESCROW_ORDERS = 200;

interface EscrowCheckpoint {
  /** Repair: order ids still to fetch (forced). */
  pendingOrderIds: string[] | null;
}

/**
 * Bounded escrow job: each slice asks the database which orders need an
 * escrow fetch (get_orders_needing_escrow_sync), fetches up to
 * escrowBatchSize of them within the call budget, and repeats until none are
 * left. Processed orders leave the candidate set by themselves (synced now,
 * or back-off after a not-ready / failed answer).
 */
export class EscrowSyncJobRunner implements SyncJobRunner {
  private readonly db: SupabaseClient;
  private readonly sync: ShopeeEscrowSyncService;

  constructor(deps: { db: SupabaseClient; sync: ShopeeEscrowSyncService }) {
    this.db = deps.db;
    this.sync = deps.sync;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, config, now } = input;
    const progress = input.progress as SliceInput<EscrowCheckpoint>["progress"];
    const scope = progress.meta.scope as { orderSns?: string[] } | undefined;

    if (!progress.checkpoint) {
      let pendingOrderIds: string[] | null = null;
      if (Array.isArray(scope?.orderSns) && scope.orderSns.length > 0) {
        const { data, error } = await this.db.from("channel_orders").select("id").eq("shop_id", job.shop_id).in("external_order_sn", scope.orderSns.slice(0, MAX_REPAIR_ESCROW_ORDERS));
        if (error) throw new Error(`Không đọc được đơn cần sửa: ${error.message}`);
        pendingOrderIds = (data ?? []).map((r) => r.id as string);
      }
      progress.checkpoint = { pendingOrderIds };
      const first = await lease.checkpoint(progress.toPatch({ windowTo: now().toISOString() }));
      if (first.cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint!;
    const seenThisSlice = new Set<string>();

    for (;;) {
      let batch: Array<{ id: string; force: boolean }>;
      if (cp.pendingOrderIds) {
        batch = cp.pendingOrderIds.slice(0, config.escrowBatchSize).map((id) => ({ id, force: true }));
      } else {
        const limit = Math.min(config.escrowBatchSize, budget.apiCallsLeft);
        if (limit < 1) return { kind: "more" };
        const { data, error } = await this.db.rpc("get_orders_needing_escrow_sync", {
          p_shop_id: job.shop_id,
          p_limit: limit,
          p_now: now().toISOString(),
          p_statuses: [...ESCROW_ELIGIBLE_STATUSES],
          p_refresh_window_days: config.escrowRefreshWindowDays,
          p_refresh_interval_hours: config.escrowRefreshIntervalHours,
          p_error_backoff_hours: config.escrowErrorBackoffHours,
        });
        if (error) throw new Error(`Không đọc được đơn cần đồng bộ tài chính: ${error.message}`);
        batch = ((data ?? []) as Array<{ order_id: string }>).filter((r) => !seenThisSlice.has(r.order_id)).map((r) => ({ id: r.order_id, force: false }));
      }
      if (batch.length === 0) break;

      for (const item of batch) {
        if (!budget.canSpend(1)) return { kind: "more" };
        seenThisSlice.add(item.id);
        progress.incr("ordersChecked");
        try {
          const r = await this.sync.syncOrder(item.id, { force: item.force });
          progress.incrIn("outcomes", r.status);
          if (r.status === "applied" || r.status === "unchanged") {
            progress.incr("escrowFetched");
            if (r.status === "applied") progress.counters.updated++;
            if (r.financialStatus === "settlement_available") progress.incr("settlementAvailable");
            if (r.reconciliationStatus) progress.incr(r.reconciliationStatus);
            if (r.missingCogs) progress.incr("missingCogs");
            for (const f of r.unknownFields) progress.incrIn("unknownFields", f);
          } else if (r.status === "not_ready") {
            progress.incr("notReady");
          } else if (r.status === "failed") {
            progress.incr("errors");
            progress.addFailure({ externalId: r.orderSn, reason: `escrow [${r.errorCode}] ${r.errorMessage ?? ""}` });
          }
        } catch (err) {
          if (isJobLevelProviderError(err) || err instanceof JobRefusedError) throw err;
          progress.incr("errors");
          progress.addFailure({ externalId: item.id, reason: `escrow: ${errorInfo(err).message}` });
        }
        progress.counters.fetched++;
        if (cp.pendingOrderIds) cp.pendingOrderIds = cp.pendingOrderIds.filter((id) => id !== item.id);
        if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
      }
      if (cp.pendingOrderIds && cp.pendingOrderIds.length === 0) break;
    }

    const failureCount = progress.failureCount;
    const summary = firstFailureSummary(progress.failures, failureCount);
    return {
      kind: "done",
      logStatus: failureCount === 0 ? "success" : progress.stat("escrowFetched") > 0 ? "partial" : "failed",
      advanceCheckpoint: failureCount === 0 && !cp.pendingOrderIds,
      windowFrom: null,
      windowTo: job.window_to ?? now().toISOString(),
      errorCode: summary?.code ?? null,
      errorMessage: summary?.message ?? null,
    };
  }
}
