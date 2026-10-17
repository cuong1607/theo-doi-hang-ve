// ============================================================
// PHASE SHOPEE-7: payout sync (job type "payout").
//
// Source per shop (shops.payout_source, detected once):
//   payout_detail  cross-border shops — get_payout_detail windows → apply_payout
//                  (batch + orders + adjustments, idempotent, amount immutable)
//                  + the payout's escrow list as order releases
//   wallet         local shops (VN) — get_payout_detail answers "only for cross
//                  border"; the wallet ledger (get_wallet_transaction_list) is
//                  stored and build_wallet_payouts turns every withdrawal into
//                  a payout (releases = its orders, other movements =
//                  adjustments, wallet balance before/after closes the sum)
//
// Then: payout orders not stored locally are fetched through the order sync
// (bounded; orders before the orders-sync cutoff are skipped — the payout
// stays 'incomplete', never a false 'mismatch'), and open payouts are
// re-reconciled (reconcile_open_payouts) — all formulas in SQL.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { getOrdersSyncFrom } from "../core/sync-settings.ts";
import { continuation, firstFailureSummary, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../core/sync-runner.ts";
import { splitTimeWindows } from "../core/time-windows.ts";
import { INCOME_API, parsePayoutDetailPage, parseWalletTransactionPage, toApplyPayoutArgs, toWalletRpcRows } from "./income-adapter.ts";
import { FIRST_PAGE, INCOME_PAGE_SIZE, isCrossBorderOnlyError, MAX_INCOME_WINDOW_SECONDS, type IncomeProviderContext, type ShopeeIncomeProvider } from "./income-provider.ts";
import { applyIncomeReleases, jobWindow, loadIncomeShop } from "./income-sync.ts";
import type { OrderBatchAccumulator, ShopeeOrderSyncService } from "./order-sync.ts";
import { ShopeePayloadError } from "./product-adapter.ts";
import { isOrderBeforeSyncCutoff } from "./sync-decisions.ts";

export const PAYOUT_SYNC_TYPE = "payout";
const MAX_PAGES_PER_WINDOW = 200;
/** Missing payout orders fetched per job (each = order detail calls). */
const MISSING_ORDERS_PER_JOB = 20;
const WALLET_BUILD_BATCH = 50;

export type PayoutSource = "payout_detail" | "wallet";

const logPayout = (event: Record<string, unknown>) => console.info(JSON.stringify({ source: "shopee-payout", ...event }));

export class ShopeePayoutSyncService {
  private readonly db: SupabaseClient;
  private readonly provider: ShopeeIncomeProvider;
  private readonly orders: ShopeeOrderSyncService;
  private readonly now: () => Date;

  constructor(deps: { db: SupabaseClient; provider: ShopeeIncomeProvider; orders: ShopeeOrderSyncService; now?: () => Date }) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.orders = deps.orders;
    this.now = deps.now ?? (() => new Date());
  }

  /** One probe call; the answer is stored on the shop (never asked again). */
  async detectPayoutSource(shop: { id: string; ctx: IncomeProviderContext }): Promise<PayoutSource> {
    const to = Math.floor(this.now().getTime() / 1000);
    let source: PayoutSource;
    try {
      await this.provider.getPayoutDetail(shop.ctx, { from: to - 86_400, to, pageNo: FIRST_PAGE.payoutDetail, pageSize: 1 });
      source = "payout_detail";
    } catch (err) {
      if (!isCrossBorderOnlyError(err)) throw err;
      source = "wallet";
    }
    const { error } = await this.db.from("shops").update({ payout_source: source }).eq("id", shop.id);
    if (error) throw new Error(`Không lưu được nguồn payout: ${error.message}`);
    logPayout({ event: "payout_source_detected", shopId: shop.id, source });
    return source;
  }

  /** get_payout_detail page → apply_payout per payout (+ its orders as releases). */
  async syncPayoutDetail(shop: { id: string; ctx: IncomeProviderContext }, window: { from: number; to: number }, pageNo: number) {
    const payload = await this.provider.getPayoutDetail(shop.ctx, { from: window.from, to: window.to, pageNo, pageSize: INCOME_PAGE_SIZE });
    const page = parsePayoutDetailPage(payload.raw);
    const at = this.now();
    let created = 0;
    let conflicts = 0;
    for (const p of page.payouts) {
      const args = toApplyPayoutArgs(p);
      const { data, error } = await this.db.rpc("apply_payout", { p_shop_id: shop.id, p_source: "payout_detail", ...args, p_synced_at: at.toISOString() });
      if (error) throw new Error(`Không lưu được payout ${p.providerPayoutId}: ${error.message} [${error.code ?? ""}]`);
      const r = data as { created: boolean; amount_conflict: boolean; reconciliation_status: string };
      if (r.created) created++;
      if (r.amount_conflict) conflicts++;
      await applyIncomeReleases(
        this.db,
        shop.id,
        "payout_detail",
        p.orders.map((o) => ({ order_sn: o.orderSn, amount: o.amount, currency: o.currency, release_time: p.payoutTime, payment_method: p.payService, api_name: INCOME_API.payoutDetail })),
        at,
      );
      logPayout({ event: "payout_synced", shopId: shop.id, payoutId: p.providerPayoutId, created: r.created, status: r.reconciliation_status, amountConflict: r.amount_conflict });
    }
    return { page, created, conflicts };
  }

  /** get_wallet_transaction_list page → channel_wallet_transactions (idempotent). */
  async syncWalletPage(shop: { id: string; currency: string; ctx: IncomeProviderContext }, window: { from: number; to: number }, pageNo: number) {
    const payload = await this.provider.listWalletTransactions(shop.ctx, { from: window.from, to: window.to, pageNo, pageSize: INCOME_PAGE_SIZE });
    const page = parseWalletTransactionPage(payload.raw, shop.currency);
    let inserted = 0;
    if (page.rows.length > 0) {
      const { data, error } = await this.db.rpc("apply_wallet_transactions", { p_shop_id: shop.id, p_rows: toWalletRpcRows(page.rows) });
      if (error) throw new Error(`Không lưu được giao dịch ví: ${error.message} [${error.code ?? ""}]`);
      inserted = Number(data ?? 0);
    }
    return { page, inserted };
  }

  async buildWalletPayouts(shopId: string): Promise<{ built: number; frozen: number }> {
    const { data, error } = await this.db.rpc("build_wallet_payouts", { p_shop_id: shopId, p_limit: WALLET_BUILD_BATCH });
    if (error) throw new Error(`Không dựng được payout từ ví: ${error.message} [${error.code ?? ""}]`);
    return data as { built: number; frozen: number };
  }

  /** Orders referenced by not-final payouts but not stored locally (bounded). */
  async missingPayoutOrders(shopId: string, limit: number): Promise<string[]> {
    const { data, error } = await this.db
      .from("payout_orders")
      .select("external_order_sn, payout_batches!inner(shop_id, reconciliation_status)")
      .is("order_id", null)
      .eq("payout_batches.shop_id", shopId)
      .eq("payout_batches.reconciliation_status", "incomplete")
      .limit(limit * 3);
    if (error) throw new Error(`Không đọc được đơn thiếu của payout: ${error.message}`);
    return [...new Set((data ?? []).map((r) => r.external_order_sn as string))];
  }

  /** Fetch one missing order through the (metered) order sync; job-level provider errors are rethrown. */
  async fetchMissingOrder(shop: { id: string; currency: string; ctx: IncomeProviderContext }, orderSn: string, cutoff: Date | null): Promise<"stored" | "before_cutoff" | "failed"> {
    const acc: OrderBatchAccumulator = {
      counts: { fetched: 0, created: 0, updated: 0, failed: 0 },
      failures: [],
      failedSns: new Set(),
      stats: { detailsFetched: 0, ordersCompleted: 0, ordersCancelled: 0, linesUnresolved: 0, cogs: {} },
      mapping: { complete: 0, partial: 0, unmapped: 0 },
      storedOrders: 0,
    };
    await this.orders.processDetailBatch({ shopId: shop.id, ctx: shop.ctx, currency: shop.currency }, [orderSn], acc, { rethrowProviderErrors: true, createdFrom: cutoff });
    if (acc.stats.skippedBeforeCutoff) return "before_cutoff";
    return acc.storedOrders > 0 ? "stored" : "failed";
  }

  async reconcileOpenPayouts(shopId: string): Promise<number> {
    const { data, error } = await this.db.rpc("reconcile_open_payouts", { p_shop_id: shopId, p_limit: 100 });
    if (error) throw new Error(`Không đối soát lại được payout: ${error.message}`);
    return Number(data ?? 0);
  }
}

export interface PayoutJobCheckpoint {
  phase: "detect" | "fetch" | "build" | "orders" | "reconcile" | "done";
  source: PayoutSource | null;
  windowIndex: number;
  pageNo: number;
  pagesInWindow: number;
  attemptedOrderSns?: string[];
}

export class PayoutSyncJobRunner implements SyncJobRunner {
  private readonly db: SupabaseClient;
  private readonly sync: ShopeePayoutSyncService;
  private readonly providerMode: string;

  constructor(deps: { db: SupabaseClient; sync: ShopeePayoutSyncService; providerMode: string }) {
    this.db = deps.db;
    this.sync = deps.sync;
    this.providerMode = deps.providerMode;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, config, now } = input;
    const progress = input.progress as SliceInput<PayoutJobCheckpoint>["progress"];
    const row = await loadIncomeShop(this.db, job.shop_id, this.providerMode);
    const shop = { id: row.id, currency: row.currency!, ctx: { shopId: row.id, externalShopId: row.external_shop_id } };

    let windowFrom = job.window_from ? new Date(job.window_from) : null;
    let windowTo = job.window_to ? new Date(job.window_to) : null;
    if (!progress.checkpoint) {
      const w = await jobWindow(this.db, { shopId: shop.id, syncType: PAYOUT_SYNC_TYPE, job, overlapMinutes: config.payoutOverlapMinutes, lookbackDays: config.payoutLookbackDays, now: now() });
      windowFrom = w.from;
      windowTo = w.to;
      const source = (row.payout_source as PayoutSource | null) ?? null;
      progress.checkpoint = { phase: source ? "fetch" : "detect", source, windowIndex: 0, pageNo: 0, pagesInWindow: 0 };
      progress.meta.providerMode = this.providerMode;
      const first = await lease.checkpoint(progress.toPatch({ windowFrom: windowFrom.toISOString(), windowTo: windowTo.toISOString() }));
      if (first.cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint!;
    const save = async () => (await lease.checkpoint(progress.toPatch())).cancelRequested;

    if (cp.phase === "detect") {
      if (!budget.canSpend(1)) return continuation(budget, "more_pages");
      cp.source = await this.sync.detectPayoutSource(shop);
      cp.phase = "fetch";
      if (await save()) return { kind: "cancelled" };
    }
    progress.meta.payoutSource = cp.source;
    const firstPage = cp.source === "wallet" ? FIRST_PAGE.wallet : FIRST_PAGE.payoutDetail;
    if (cp.phase === "fetch" && cp.windowIndex === 0 && cp.pagesInWindow === 0) cp.pageNo = firstPage;

    // Wallet: the whole window is read (balance continuity needs it, it starts before the cutoff on purpose).
    const windows =
      windowFrom && windowTo && windowFrom < windowTo ? splitTimeWindows(Math.floor(windowFrom.getTime() / 1000), Math.floor(windowTo.getTime() / 1000), MAX_INCOME_WINDOW_SECONDS) : [];
    progress.meta.windows = windows.length;

    while (cp.phase === "fetch" && cp.windowIndex < windows.length) {
      if (budget.expired || !budget.canSpend(1)) return continuation(budget, "more_pages");
      const window = windows[cp.windowIndex];
      let more = false;
      try {
        if (cp.source === "wallet") {
          const r = await this.sync.syncWalletPage(shop, window, cp.pageNo);
          progress.counters.fetched += r.page.rows.length;
          progress.incr("walletInserted", r.inserted);
          for (const issue of r.page.issues) progress.addFailure({ externalId: issue.externalId, reason: `${issue.apiName}: ${issue.reason}` });
          more = r.page.more;
        } else {
          const r = await this.sync.syncPayoutDetail(shop, window, cp.pageNo);
          progress.counters.fetched += r.page.payouts.length;
          progress.counters.created += r.created;
          progress.incr("amountConflicts", r.conflicts);
          for (const issue of r.page.issues) progress.addFailure({ externalId: issue.externalId, reason: `${issue.apiName}: ${issue.reason}` });
          more = r.page.more;
        }
      } catch (err) {
        if (!(err instanceof ShopeePayloadError)) throw err;
        progress.incr("windowsFailed");
        progress.addFailure({ externalId: null, reason: `window ${new Date(window.from * 1000).toISOString()}: ${err.message}` });
        more = false;
      }
      progress.incr("pages");
      cp.pagesInWindow++;
      if (more && cp.pagesInWindow < MAX_PAGES_PER_WINDOW) cp.pageNo++;
      else {
        cp.windowIndex++;
        cp.pageNo = firstPage;
        cp.pagesInWindow = 0;
      }
      if (await save()) return { kind: "cancelled" };
    }
    if (cp.phase === "fetch") {
      cp.phase = cp.source === "wallet" ? "build" : "orders";
      if (await save()) return { kind: "cancelled" };
    }

    while (cp.phase === "build") {
      if (budget.expired) return continuation(budget, "more_records");
      const r = await this.sync.buildWalletPayouts(shop.id);
      progress.incr("payoutsBuilt", r.built);
      if (r.built < WALLET_BUILD_BATCH) cp.phase = "orders";
      if (await save()) return { kind: "cancelled" };
    }

    if (cp.phase === "orders") {
      const cutoff = await getOrdersSyncFrom(this.db);
      const attempted = new Set(cp.attemptedOrderSns ?? []);
      const candidates = (await this.sync.missingPayoutOrders(shop.id, MISSING_ORDERS_PER_JOB)).filter((sn) => !attempted.has(sn));
      for (const sn of candidates.slice(0, MISSING_ORDERS_PER_JOB - attempted.size)) {
        attempted.add(sn);
        if (isOrderBeforeSyncCutoff(sn, null, cutoff)) {
          progress.incrIn("missingOrders", "before_cutoff");
          continue;
        }
        if (budget.expired || !budget.canSpend(1)) {
          cp.attemptedOrderSns = [...attempted];
          if (await save()) return { kind: "cancelled" };
          return continuation(budget, "more_details");
        }
        const outcome = await this.sync.fetchMissingOrder(shop, sn, cutoff);
        progress.incrIn("missingOrders", outcome);
      }
      cp.attemptedOrderSns = [...attempted];
      cp.phase = "reconcile";
      if (await save()) return { kind: "cancelled" };
    }

    if (cp.phase === "reconcile") {
      progress.incr("payoutsReconciled", await this.sync.reconcileOpenPayouts(shop.id));
      cp.phase = "done";
      if (await save()) return { kind: "cancelled" };
    }

    const failureCount = progress.failureCount;
    const summary = firstFailureSummary(progress.failures, failureCount);
    const logStatus = failureCount === 0 ? "success" : "partial";
    return {
      kind: "done",
      logStatus,
      advanceCheckpoint: logStatus === "success" && (job.mode === "incremental" || job.mode === "manual"),
      windowFrom: windowFrom?.toISOString() ?? null,
      windowTo: windowTo?.toISOString() ?? null,
      errorCode: summary?.code ?? null,
      errorMessage: summary?.message ?? null,
    };
  }
}
