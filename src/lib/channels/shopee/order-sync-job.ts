// ============================================================
// PHASE SHOPEE-PERF-1: order sync as a resumable, bounded job.
//
// Same building blocks as ShopeeOrderSyncService (list page, detail batch →
// upsert → COGS → snapshot), orchestrated in slices:
//
//   window  incremental / manual: [last_success − overlap, job start]
//           (no success yet → the last 15 days) — fixed on the first slice
//           backfill: the job's window_from / window_to (any length)
//           repair: no discovery — metadata.scope.orderSns, always fetched
//   walk    15-day sub-windows in order; per page: list → decide which
//           orders need get_order_detail (shouldRefreshOrderDetail) →
//           pending order_sn → checkpoint (cursor + pending, atomically)
//   detail  pending in batches of 50, ≤ orderDetailConcurrency in flight,
//           each round checkpointed
//   budget  checked before every provider call group; when spent the
//           runner returns "more" — the next slice resumes from the cursor
//
// A crashed slice replays at most one page / one detail round: every write
// is an idempotent upsert. Only a clean incremental/manual job advances
// channel_sync_states.last_success_at (to the window end).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSyncState } from "../core/sync-log.ts";
import { continuation, firstFailureSummary, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../core/sync-runner.ts";
import { mapWithConcurrency, splitTimeWindows } from "../core/time-windows.ts";
import { errorInfo, JobRefusedError } from "./sync-errors.ts";
import { MAX_ORDER_WINDOW_SECONDS, ORDER_DETAIL_BATCH_SIZE, type OrderProviderContext } from "./order-provider.ts";
import { ORDER_INITIAL_LOOKBACK_SECONDS, ORDER_SYNC_TYPE, type OrderBatchAccumulator, type ShopeeOrderSyncService } from "./order-sync.ts";
import { shouldRefreshOrderDetail, type LocalOrderState } from "./sync-decisions.ts";

/** Pages per sub-window before the walk is declared anomalous. */
const MAX_PAGES_PER_WINDOW = 500;
/** Repair scope cap (metadata must stay small). */
export const MAX_REPAIR_ORDER_SNS = 200;

export interface OrderJobCheckpoint {
  phase: "discover" | "details" | "done";
  windowIndex: number;
  cursor: string;
  pagesInWindow: number;
  seenCursors: string[];
  pendingSns: string[];
}

type Shop = { id: string; channel: string; external_shop_id: string; data_source: string; currency: string | null };

export class OrderSyncJobRunner implements SyncJobRunner {
  private readonly db: SupabaseClient;
  private readonly sync: ShopeeOrderSyncService;
  private readonly providerMode: string;

  constructor(deps: { db: SupabaseClient; sync: ShopeeOrderSyncService; providerMode: string }) {
    this.db = deps.db;
    this.sync = deps.sync;
    this.providerMode = deps.providerMode;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, config, now } = input;
    const progress = input.progress as SliceInput<OrderJobCheckpoint>["progress"];
    const shop = await this.loadShop(job.shop_id);
    const ctx: OrderProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    const repairSns = Array.isArray((progress.meta.scope as { orderSns?: unknown } | undefined)?.orderSns)
      ? ((progress.meta.scope as { orderSns: string[] }).orderSns).slice(0, MAX_REPAIR_ORDER_SNS)
      : null;

    // ---- window + checkpoint (first slice)
    let windowFrom = job.window_from ? new Date(job.window_from) : null;
    let windowTo = job.window_to ? new Date(job.window_to) : null;
    if (!progress.checkpoint) {
      if (repairSns) {
        progress.checkpoint = { phase: "details", windowIndex: 0, cursor: "", pagesInWindow: 0, seenCursors: [], pendingSns: [...new Set(repairSns)] };
      } else {
        if (job.mode === "incremental" || job.mode === "manual" || !windowFrom || !windowTo) {
          const state = await getSyncState(this.db, shop.id, ORDER_SYNC_TYPE);
          windowTo = now();
          windowFrom = state?.last_success_at
            ? new Date(new Date(state.last_success_at).getTime() - config.orderOverlapMinutes * 60_000)
            : new Date(windowTo.getTime() - ORDER_INITIAL_LOOKBACK_SECONDS * 1000);
        }
        progress.checkpoint = { phase: "discover", windowIndex: 0, cursor: "", pagesInWindow: 0, seenCursors: [""], pendingSns: [] };
      }
      progress.meta.providerMode = this.providerMode;
      const first = await lease.checkpoint(progress.toPatch({ windowFrom: windowFrom?.toISOString() ?? null, windowTo: windowTo?.toISOString() ?? null }));
      if (first.cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint!;
    const windows =
      windowFrom && windowTo ? splitTimeWindows(Math.floor(windowFrom.getTime() / 1000), Math.floor(windowTo.getTime() / 1000), MAX_ORDER_WINDOW_SECONDS) : [];
    progress.meta.windows = windows.length;

    const save = async () => (await lease.checkpoint(progress.toPatch({ cursor: cp.cursor || null }))).cancelRequested;

    for (;;) {
      // ---- details for what discovery queued
      if (cp.pendingSns.length > 0) {
        const affordable = Math.min(config.orderDetailConcurrency, budget.apiCallsLeft);
        if (affordable < 1 || !budget.canSpend(1)) return continuation(budget, "more_details");
        const take = cp.pendingSns.slice(0, affordable * ORDER_DETAIL_BATCH_SIZE);
        const batches: string[][] = [];
        for (let i = 0; i < take.length; i += ORDER_DETAIL_BATCH_SIZE) batches.push(take.slice(i, i + ORDER_DETAIL_BATCH_SIZE));
        const acc: OrderBatchAccumulator = {
          counts: { fetched: 0, created: 0, updated: 0, failed: 0 },
          failures: [],
          failedSns: new Set(),
          stats: { detailsFetched: 0, ordersCompleted: 0, ordersCancelled: 0, linesUnresolved: 0, cogs: {} },
          mapping: { complete: 0, partial: 0, unmapped: 0 },
          storedOrders: 0,
          deferredSns: new Set(),
        };
        // Job-level provider errors (rate limit, auth, …) propagate: pending stays in the checkpoint.
        // Storing stops when the slice's time is up — what was fetched but not stored stays pending.
        await mapWithConcurrency(batches, config.orderDetailConcurrency, (batch) =>
          this.sync.processDetailBatch({ shopId: shop.id, ctx, currency: shop.currency }, batch, acc, { rethrowProviderErrors: true, shouldStop: () => budget.expired }),
        );
        progress.counters.created += acc.counts.created;
        progress.counters.updated += acc.counts.updated;
        console.info(JSON.stringify({ source: "shopee-order-sync", event: "order_synced", jobId: job.id, shopId: shop.id, detailsFetched: acc.stats.detailsFetched, created: acc.counts.created, updated: acc.counts.updated, failed: acc.counts.failed }));
        progress.incr("detailsFetched", acc.stats.detailsFetched);
        progress.incr("ordersStored", acc.storedOrders);
        progress.incr("ordersCompleted", acc.stats.ordersCompleted);
        progress.incr("ordersCancelled", acc.stats.ordersCancelled);
        progress.incr("linesUnresolved", acc.stats.linesUnresolved);
        progress.incrIn("mapping", "complete", acc.mapping.complete);
        progress.incrIn("mapping", "partial", acc.mapping.partial);
        progress.incrIn("mapping", "unmapped", acc.mapping.unmapped);
        for (const [k, v] of Object.entries(acc.stats.cogs)) progress.incrIn("cogs", k, v);
        for (const f of acc.failures) progress.addFailure(f);
        const deferred = take.filter((sn) => acc.deferredSns!.has(sn));
        if (deferred.length > 0) progress.incr("detailsDeferred", deferred.length);
        cp.pendingSns = [...deferred, ...cp.pendingSns.slice(take.length)];
        if (cp.pendingSns.length === 0 && cp.phase === "details") cp.phase = "done";
        if (await save()) return { kind: "cancelled" };
        continue;
      }

      if (cp.phase !== "discover" || cp.windowIndex >= windows.length) break;

      // ---- discovery: one list page
      if (!budget.canSpend(1)) return continuation(budget, "more_pages");
      const window = windows[cp.windowIndex];
      let page: Awaited<ReturnType<ShopeeOrderSyncService["fetchOrderListPage"]>>;
      try {
        page = await this.sync.fetchOrderListPage(ctx, window, cp.cursor);
      } catch (err) {
        // A parse problem of THIS page fails the sub-window only; provider errors are job-level.
        if (errorInfo(err).code !== "provider_parse_error") throw err;
        this.failWindow(progress, cp, window, errorInfo(err).message);
        if (await save()) return { kind: "cancelled" };
        continue;
      }
      progress.incr("pages");
      cp.pagesInWindow++;
      for (const issue of page.issues) progress.addFailure({ externalId: issue.externalId, reason: `${issue.apiName}: ${issue.reason}` });
      progress.counters.fetched += page.orders.length;

      const locals = await this.loadLocalOrders(shop.id, page.orders.map((o) => o.orderSn));
      const nowDate = now();
      for (const entry of page.orders) {
        const decision = shouldRefreshOrderDetail(locals.get(entry.orderSn) ?? null, { orderSn: entry.orderSn, orderStatus: entry.orderStatus }, {
          windowFrom: new Date(window.from * 1000),
          windowTo: new Date(window.to * 1000),
          now: nowDate,
          activeOrderTtlMinutes: config.activeOrderTtlMinutes,
          force: job.mode === "repair",
        });
        progress.incrIn("refreshReasons", decision.reason);
        if (decision.refresh) {
          if (!cp.pendingSns.includes(entry.orderSn)) cp.pendingSns.push(entry.orderSn);
        } else {
          progress.incr("detailsSkippedUnchanged");
        }
      }

      if (!page.more) {
        this.nextWindow(cp);
      } else if (!page.nextCursor || cp.seenCursors.includes(page.nextCursor) || cp.pagesInWindow >= MAX_PAGES_PER_WINDOW) {
        this.failWindow(progress, cp, window, `next_cursor lặp lại/rỗng trong khi more=true (${page.nextCursor ?? "∅"})`);
      } else {
        cp.cursor = page.nextCursor;
        cp.seenCursors.push(page.nextCursor);
      }
      if (await save()) return { kind: "cancelled" };
    }

    // ---- done
    cp.phase = "done";
    const windowsFailed = progress.stat("windowsFailed");
    const stored = progress.stat("ordersStored");
    const allWindowsFailed = windows.length > 0 && windowsFailed === windows.length;
    const failureCount = progress.failureCount;
    const logStatus = allWindowsFailed ? "failed" : failureCount === 0 ? "success" : stored > 0 || progress.counters.fetched === 0 ? "partial" : "failed";
    const summary = firstFailureSummary(progress.failures, failureCount);
    return {
      kind: "done",
      logStatus,
      advanceCheckpoint: logStatus === "success" && (job.mode === "incremental" || job.mode === "manual") && !repairSns,
      windowFrom: windowFrom?.toISOString() ?? null,
      windowTo: windowTo?.toISOString() ?? null,
      errorCode: allWindowsFailed ? "discovery_failed" : summary?.code ?? null,
      errorMessage: summary?.message ?? null,
    };
  }

  private nextWindow(cp: OrderJobCheckpoint) {
    cp.windowIndex++;
    cp.cursor = "";
    cp.pagesInWindow = 0;
    cp.seenCursors = [""];
  }

  private failWindow(progress: SliceInput<OrderJobCheckpoint>["progress"], cp: OrderJobCheckpoint, window: { from: number; to: number }, reason: string) {
    progress.incr("windowsFailed");
    progress.addFailure({
      externalId: null,
      reason: `window ${new Date(window.from * 1000).toISOString()}→${new Date(window.to * 1000).toISOString()}: ${reason}`,
    });
    this.nextWindow(cp);
  }

  private async loadShop(shopId: string): Promise<Shop> {
    const { data, error } = await this.db.from("shops").select("id, channel, external_shop_id, data_source, currency").eq("id", shopId).maybeSingle<Shop>();
    if (error) throw new Error(`Không đọc được shop: ${error.message}`);
    if (!data) throw new JobRefusedError("shop_not_found", "Không tìm thấy shop.");
    if (data.channel !== "shopee") throw new JobRefusedError("not_shopee", "Shop không thuộc kênh Shopee.");
    if (data.data_source !== this.providerMode) {
      throw new JobRefusedError("source_mismatch", data.data_source === "fixture" ? "Shop fixture chỉ được đồng bộ bằng fixture provider." : "Không được đồng bộ dữ liệu fixture vào shop thật.");
    }
    return data;
  }

  /** One query per page: status, timestamps and line count of the already-stored orders. */
  private async loadLocalOrders(shopId: string, sns: string[]): Promise<Map<string, LocalOrderState>> {
    const result = new Map<string, LocalOrderState>();
    if (sns.length === 0) return result;
    const { data, error } = await this.db
      .from("channel_orders")
      .select("external_order_sn, order_status, updated_at_channel, last_synced_at, channel_order_items(count)")
      .eq("shop_id", shopId)
      .in("external_order_sn", sns);
    if (error) throw new Error(`Không đọc được đơn đã lưu: ${error.message}`);
    for (const r of (data ?? []) as Array<{
      external_order_sn: string;
      order_status: string;
      updated_at_channel: string | null;
      last_synced_at: string | null;
      channel_order_items: Array<{ count: number }>;
    }>) {
      result.set(r.external_order_sn, {
        orderStatus: r.order_status,
        updatedAtChannel: r.updated_at_channel,
        lastSyncedAt: r.last_synced_at,
        lineCount: r.channel_order_items?.[0]?.count ?? 0,
      });
    }
    return result;
  }
}
