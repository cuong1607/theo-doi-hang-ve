// ============================================================
// PHASE SHOPEE-3: Shopee order sync orchestration (fixture-first).
//
// ONE implementation for live and fixture (ShopeeOrderProvider port).
//
//   1. guard: shop exists, Shopee, data_source == provider mode, no other
//      order sync running
//   2. range → windows ≤ 15 days (splitTimeWindows; callers never pre-split)
//        incremental: [last_success_at − overlap, now]   (no success yet → last 15 days)
//        backfill:    [from, to] given by the caller (never advances the checkpoint)
//      time_range_field = update_time: old orders that change status are seen again
//   3. discovery per window: cursor pagination (page_size 100) until more=false;
//      a repeated/empty next_cursor while more=true fails THAT window
//      (pagination anomaly) — other windows continue
//   4. detail strategy "B": EVERY order_sn discovered in the window is
//      re-fetched (correctness over optimisation; documented). Batches of
//      ORDER_DETAIL_BATCH_SIZE, at most `detailConcurrency` batches in flight.
//   5. per order: resolve lines by identity (shop+item+model; no model → NO_MODEL);
//      lines whose listing is unknown → ensureItems() once per batch, re-resolve;
//      still unknown → stored with internal_product_id NULL (never a guess)
//   6. upsert order + lines (line snapshot never overwritten), meaningful snapshot
//   7. state + log. Partial failures never roll back stored orders; only a
//      fully successful INCREMENTAL run advances last_success_at.
//
// Not here: fees, escrow, settlement, COGS, profit. financial_status stays
// 'pending' (no estimated financial snapshot exists yet).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveChannelUnits, unitKey, upsertChannelOrder, upsertChannelOrderItems, type ResolvedUnit } from "../core/order-store.ts";
import { saveMeaningfulOrderSnapshot } from "../core/snapshots.ts";
import { finishSyncLog, getSyncState, hasRunningSync, saveSyncState, startSyncLog, type SyncCounts } from "../core/sync-log.ts";
import { mapWithConcurrency, splitTimeWindows, type TimeWindow } from "../core/time-windows.ts";
import type { SyncLogStatus } from "../core/types.ts";
import { CostEngine } from "../../inventory-cost/engine.ts";
import { consoleShopeeLogger, type ShopeeLogger } from "./client.ts";
import { errorInfo, isJobLevelProviderError } from "./sync-errors.ts";
import { orderFingerprint, parseOrderDetails, parseOrderListPage } from "./order-adapter.ts";
import { MAX_ORDER_WINDOW_SECONDS, ORDER_DETAIL_BATCH_SIZE, ORDER_LIST_PAGE_SIZE, type OrderProviderContext, type ShopeeOrderProvider } from "./order-provider.ts";
import { isOrderCancelled, isOrderCompleted } from "./order-status.ts";
import { ShopeePayloadError } from "./product-adapter.ts";

export const ORDER_SYNC_TYPE = "order";
/** Incremental runs re-read this much before the last successful run (boundary safety). */
export const ORDER_SYNC_OVERLAP_SECONDS = 10 * 60;
/** First incremental run with no checkpoint looks back this far (one window). */
export const ORDER_INITIAL_LOOKBACK_SECONDS = MAX_ORDER_WINDOW_SECONDS;
/** Detail batches in flight. Real Shopee rate limits are unverified → keep small. */
export const ORDER_DETAIL_CONCURRENCY = 3;
const MAX_PAGES_PER_WINDOW = 500;
const MAX_FAILURES_IN_LOG = 50;

export interface OrderSyncOptions {
  mode?: "incremental" | "backfill";
  from?: Date;
  to?: Date;
  overlapSeconds?: number;
}

export interface OrderSyncResult {
  ok: boolean;
  status: Exclude<SyncLogStatus, "running">;
  logId: string;
  counts: SyncCounts;
  windowsProcessed: number;
  windowsFailed: number;
  pagesFetched: number;
  ordersDiscovered: number;
  detailsFetched: number;
  ordersCompleted: number;
  ordersCancelled: number;
  mapping: { complete: number; partial: number; unmapped: number };
  linesUnresolved: number;
  /** COGS outcomes per line (calculated, no_cost, unmapped, ineligible, already, reversed, …). */
  cogs: Record<string, number>;
  failures: Array<{ externalId: string | null; reason: string }>;
  errorCode?: string;
  errorMessage?: string;
}

export class OrderSyncRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrderSyncRefusedError";
    this.code = code;
  }
}

export interface ProductEnsurer {
  ensureItems(shopId: string, externalItemIds: string[]): Promise<{ failures: Array<{ externalId: string | null; reason: string }> }>;
}

export interface OrderBatchStats {
  detailsFetched: number;
  ordersCompleted: number;
  ordersCancelled: number;
  linesUnresolved: number;
  cogs: Record<string, number>;
}

/** Mutable totals a detail batch adds to (shared by sync() and the job runner). */
export interface OrderBatchAccumulator {
  counts: SyncCounts;
  failures: Array<{ externalId: string | null; reason: string }>;
  failedSns: Set<string>;
  stats: OrderBatchStats;
  mapping: { complete: number; partial: number; unmapped: number };
  storedOrders: number;
  /**
   * Fetched but NOT stored because the slice ran out of time (shouldStop) —
   * the job runner keeps them pending for the next slice. Never "failed".
   */
  deferredSns?: Set<string>;
}

const toSeconds = (d: Date) => Math.floor(d.getTime() / 1000);

export class ShopeeOrderSyncService {
  private readonly db: SupabaseClient;
  private readonly provider: ShopeeOrderProvider;
  private readonly products: ProductEnsurer | null;
  private readonly now: () => Date;
  private readonly log: ShopeeLogger;
  private readonly detailConcurrency: number;
  private readonly costs: Pick<CostEngine, "processOrder">;

  constructor(deps: {
    db: SupabaseClient;
    provider: ShopeeOrderProvider;
    products?: ProductEnsurer | null;
    now?: () => Date;
    logger?: ShopeeLogger;
    detailConcurrency?: number;
    costs?: Pick<CostEngine, "processOrder">;
  }) {
    this.db = deps.db;
    this.costs = deps.costs ?? new CostEngine({ db: deps.db, logger: () => {} });
    this.provider = deps.provider;
    this.products = deps.products ?? null;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.logger ?? consoleShopeeLogger;
    this.detailConcurrency = deps.detailConcurrency ?? ORDER_DETAIL_CONCURRENCY;
  }

  /** Initial / historical import over any range (auto-split into ≤ 15-day windows). */
  backfill(input: { shopId: string; from: Date; to: Date }): Promise<OrderSyncResult> {
    return this.sync(input.shopId, { mode: "backfill", from: input.from, to: input.to });
  }

  async sync(shopId: string, options: OrderSyncOptions = {}): Promise<OrderSyncResult> {
    const { data: shop } = await this.db
      .from("shops")
      .select("id, channel, external_shop_id, data_source, currency")
      .eq("id", shopId)
      .maybeSingle<{ id: string; channel: string; external_shop_id: string; data_source: string; currency: string | null }>();
    if (!shop) throw new OrderSyncRefusedError("shop_not_found", "Không tìm thấy shop.");
    if (shop.channel !== "shopee") throw new OrderSyncRefusedError("not_shopee", "Shop không thuộc kênh Shopee.");
    if (shop.data_source !== this.provider.mode) {
      throw new OrderSyncRefusedError(
        "source_mismatch",
        shop.data_source === "fixture" ? "Shop fixture chỉ được đồng bộ bằng fixture provider." : "Không được đồng bộ dữ liệu fixture vào shop thật.",
      );
    }
    const startedAt = this.now();
    if (await hasRunningSync(this.db, shopId, ORDER_SYNC_TYPE, startedAt)) {
      throw new OrderSyncRefusedError("sync_running", "Đang có một lượt đồng bộ đơn hàng khác cho shop này.");
    }

    const mode = options.mode ?? "incremental";
    let from: Date;
    let to: Date;
    if (mode === "backfill") {
      if (!options.from || !options.to || options.to < options.from) throw new OrderSyncRefusedError("bad_range", "Khoảng thời gian backfill không hợp lệ.");
      from = options.from;
      to = options.to;
    } else {
      const state = await getSyncState(this.db, shopId, ORDER_SYNC_TYPE);
      to = startedAt;
      from = state?.last_success_at
        ? new Date(new Date(state.last_success_at).getTime() - (options.overlapSeconds ?? ORDER_SYNC_OVERLAP_SECONDS) * 1000)
        : new Date(startedAt.getTime() - ORDER_INITIAL_LOOKBACK_SECONDS * 1000);
    }
    const windows = splitTimeWindows(toSeconds(from), toSeconds(to), MAX_ORDER_WINDOW_SECONDS);
    const ctx: OrderProviderContext = { shopId, externalShopId: shop.external_shop_id };
    const startedIso = startedAt.toISOString();
    const logId = await startSyncLog(this.db, shopId, ORDER_SYNC_TYPE, startedIso, {
      providerMode: this.provider.mode,
      syncMode: mode,
      from: from.toISOString(),
      to: to.toISOString(),
      windows: windows.length,
    });

    const counts: SyncCounts = { fetched: 0, created: 0, updated: 0, failed: 0 };
    const failures: Array<{ externalId: string | null; reason: string }> = [];
    const failedSns = new Set<string>();
    const stats = {
      windowsProcessed: 0,
      windowsFailed: 0,
      pagesFetched: 0,
      detailsFetched: 0,
      ordersCompleted: 0,
      ordersCancelled: 0,
      linesUnresolved: 0,
      cogs: {} as Record<string, number>,
    };
    const mapping = { complete: 0, partial: 0, unmapped: 0 };
    let storedOrders = 0;

    const finish = async (status: Exclude<SyncLogStatus, "running">, fatal?: { code: string; message: string }): Promise<OrderSyncResult> => {
      counts.failed = failedSns.size + failures.filter((f) => !f.externalId || !failedSns.has(f.externalId)).length;
      const completedIso = this.now().toISOString();
      const first = fatal ?? (failures[0] ? { code: "partial_failure", message: `${failures.length} lỗi; đầu tiên: ${failures[0].reason}` } : null);
      await finishSyncLog(this.db, logId, {
        status,
        completedAt: completedIso,
        counts,
        errorCode: first?.code ?? null,
        errorMessage: first?.message ?? null,
        metadata: {
          providerMode: this.provider.mode,
          syncMode: mode,
          from: from.toISOString(),
          to: to.toISOString(),
          windowsProcessed: stats.windowsProcessed,
          windowsFailed: stats.windowsFailed,
          pagesFetched: stats.pagesFetched,
          detailsFetched: stats.detailsFetched,
          ordersCompleted: stats.ordersCompleted,
          ordersCancelled: stats.ordersCancelled,
          mappingComplete: mapping.complete,
          mappingPartial: mapping.partial,
          mappingUnmapped: mapping.unmapped,
          linesUnresolved: stats.linesUnresolved,
          cogs: stats.cogs,
          failures: failures.slice(0, MAX_FAILURES_IN_LOG),
        },
      });
      const advance = status === "success" && mode === "incremental";
      await saveSyncState(this.db, shopId, ORDER_SYNC_TYPE, {
        last_window_from: from.toISOString(),
        last_window_to: to.toISOString(),
        ...(advance ? { last_success_at: startedIso, last_error_code: null, last_error_message: null } : {}),
        ...(status !== "success" ? { last_failure_at: completedIso, last_error_code: first?.code ?? null, last_error_message: first?.message ?? null } : {}),
      });
      this.log({ event: "SHOPEE_ORDER_SYNC", ok: status === "success", shopId, detail: `${status} discovered=${counts.fetched} failed=${counts.failed}` });
      return {
        ok: status === "success",
        status,
        logId,
        counts,
        windowsProcessed: stats.windowsProcessed,
        windowsFailed: stats.windowsFailed,
        pagesFetched: stats.pagesFetched,
        ordersDiscovered: counts.fetched,
        detailsFetched: stats.detailsFetched,
        ordersCompleted: stats.ordersCompleted,
        ordersCancelled: stats.ordersCancelled,
        mapping,
        linesUnresolved: stats.linesUnresolved,
        cogs: stats.cogs,
        failures,
        errorCode: first?.code,
        errorMessage: first?.message,
      };
    };

    try {
      // ---- 3. discovery
      const discovered = new Map<string, string | null>();
      for (const window of windows) {
        try {
          await this.discoverWindow(ctx, window, discovered, stats, (issue) => failures.push(issue));
          stats.windowsProcessed++;
        } catch (err) {
          stats.windowsFailed++;
          const { code, message } = errorInfo(err);
          failures.push({ externalId: null, reason: `window ${new Date(window.from * 1000).toISOString()}→${new Date(window.to * 1000).toISOString()} [${code}] ${message}` });
        }
      }
      counts.fetched = discovered.size;
      if (stats.windowsFailed === windows.length) return finish("failed", { code: "discovery_failed", message: failures[0]?.reason ?? "Không lấy được danh sách đơn." });

      // ---- 4–6. details, bounded concurrency
      const sns = [...discovered.keys()];
      const batches: string[][] = [];
      for (let i = 0; i < sns.length; i += ORDER_DETAIL_BATCH_SIZE) batches.push(sns.slice(i, i + ORDER_DETAIL_BATCH_SIZE));

      const acc: OrderBatchAccumulator = { counts, failures, failedSns, stats, mapping, storedOrders: 0 };
      await mapWithConcurrency(batches, this.detailConcurrency, (batch) => this.processDetailBatch({ shopId, ctx, currency: shop.currency }, batch, acc));
      storedOrders = acc.storedOrders;
    } catch (err) {
      return finish("failed", errorInfo(err));
    }

    if (failures.length === 0) return finish("success");
    return finish(storedOrders > 0 || counts.fetched === 0 ? "partial" : "failed");
  }

  /**
   * One get_order_detail batch → parse → resolve units (ensureItems once for
   * unknown listings) → upsert order + lines → COGS → meaningful snapshot.
   * Order-level problems are recorded in `acc` and never stop the batch.
   *
   * rethrowProviderErrors (job runner): a provider failure of the WHOLE batch
   * that is job-level — retryable (rate limit / transient) or auth/signature —
   * is thrown so the job is retried / stopped with its checkpoint intact,
   * instead of marking every order of the batch failed.
   *
   * shouldStop (job runner): checked before storing each order after the
   * first — storing is several DB round trips per order, and from a far
   * region a 50-order batch can outlive the function (killed before the
   * checkpoint → the same orders replay forever). The rest of the batch goes
   * to acc.deferredSns and stays pending.
   */
  async processDetailBatch(
    target: { shopId: string; ctx: OrderProviderContext; currency: string | null },
    batch: readonly string[],
    acc: OrderBatchAccumulator,
    options: { rethrowProviderErrors?: boolean; shouldStop?: () => boolean } = {},
  ): Promise<void> {
    const { shopId, ctx } = target;
    const { counts, failures, failedSns, stats, mapping } = acc;
    const syncedIso = this.now().toISOString();
    let parsed: ReturnType<typeof parseOrderDetails>;
    try {
      const payload = await this.provider.getOrderDetails(ctx, { orderSns: batch });
      parsed = parseOrderDetails(payload.raw, { fallbackCurrency: target.currency });
    } catch (err) {
      if (options.rethrowProviderErrors && isJobLevelProviderError(err)) throw err;
      const { code, message } = errorInfo(err);
      for (const sn of batch) {
        failedSns.add(sn);
        failures.push({ externalId: sn, reason: `get_order_detail [${code}] ${message}` });
      }
      return;
    }
    stats.detailsFetched += parsed.orders.length;
    for (const issue of parsed.issues) {
      if (issue.externalId) failedSns.add(issue.externalId);
      failures.push({ externalId: issue.externalId, reason: `${issue.apiName}: ${issue.reason}` });
    }
    const returned = new Set(parsed.orders.map((o) => o.externalOrderSn));
    for (const sn of batch) {
      if (!returned.has(sn) && !failedSns.has(sn)) {
        failedSns.add(sn);
        failures.push({ externalId: sn, reason: "get_order_detail: đơn không có trong phản hồi" });
      }
    }

    // Resolve identities for the whole batch; fetch unknown listings once.
    const lines = parsed.orders.flatMap((o) => o.items);
    let units: Map<string, ResolvedUnit> = await resolveChannelUnits(this.db, shopId, lines);
    const missingItems = [...new Set(lines.filter((l) => !units.has(unitKey(l.externalItemId, l.externalModelId))).map((l) => l.externalItemId))];
    if (missingItems.length > 0 && this.products) {
      try {
        await this.products.ensureItems(shopId, missingItems);
        units = await resolveChannelUnits(this.db, shopId, lines);
      } catch (err) {
        failures.push({ externalId: null, reason: `ensureItems: ${errorInfo(err).message}` });
      }
    }

    for (const [index, order] of parsed.orders.entries()) {
      if (index > 0 && options.shouldStop?.()) {
        acc.deferredSns ??= new Set();
        for (const rest of parsed.orders.slice(index)) acc.deferredSns.add(rest.externalOrderSn);
        break;
      }
      try {
        const saved = await upsertChannelOrder(this.db, shopId, order, syncedIso);
        const items = await upsertChannelOrderItems(this.db, saved.orderId, order, units);
        // SHOPEE-4: post COGS (eligible status) or reverse it (CANCELLED). A cost
        // problem never fails the order sync — it only leaves COGS "chưa tính".
        try {
          const cogs = await this.costs.processOrder(saved.orderId);
          for (const [key, n] of Object.entries(cogs)) stats.cogs[key] = (stats.cogs[key] ?? 0) + n;
        } catch (err) {
          stats.cogs.error = (stats.cogs.error ?? 0) + 1;
          failures.push({ externalId: null, reason: `COGS ${order.externalOrderSn}: ${errorInfo(err).message}` });
        }
        if (saved.created) counts.created++;
        else counts.updated++;
        acc.storedOrders++;
        stats.linesUnresolved += items.unresolvedLines;
        if (items.totalLines > 0 && items.mappedLines === items.totalLines) mapping.complete++;
        else if (items.mappedLines === 0) mapping.unmapped++;
        else mapping.partial++;
        if (isOrderCompleted(order.orderStatus)) stats.ordersCompleted++;
        if (isOrderCancelled(order.orderStatus)) stats.ordersCancelled++;
        await saveMeaningfulOrderSnapshot(this.db, {
          shopId,
          orderSn: order.externalOrderSn,
          apiName: "v2.order.get_order_detail",
          payload: parsed.rawBySn.get(order.externalOrderSn) ?? null,
          fingerprint: orderFingerprint(order),
          sourceMode: this.provider.mode,
          sourceUpdatedAt: order.updatedAtChannel,
          syncedAt: syncedIso,
        });
      } catch (err) {
        failedSns.add(order.externalOrderSn);
        failures.push({ externalId: order.externalOrderSn, reason: `lưu đơn: ${errorInfo(err).message}` });
      }
    }
  }

  /** One get_order_list page (parsed). Pagination anomalies are the caller's to judge. */
  async fetchOrderListPage(ctx: OrderProviderContext, window: TimeWindow, cursor: string) {
    const payload = await this.provider.listOrders(ctx, {
      timeRangeField: "update_time",
      timeFrom: window.from,
      timeTo: window.to,
      pageSize: ORDER_LIST_PAGE_SIZE,
      cursor,
    });
    return parseOrderListPage(payload.raw);
  }

  private async discoverWindow(
    ctx: OrderProviderContext,
    window: TimeWindow,
    discovered: Map<string, string | null>,
    stats: { pagesFetched: number },
    onIssue: (failure: { externalId: string | null; reason: string }) => void,
  ) {
    let cursor = "";
    const seenCursors = new Set<string>([cursor]);
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES_PER_WINDOW) throw new ShopeePayloadError("v2.order.get_order_list", "vượt số trang tối đa trong một cửa sổ");
      const parsed = await this.fetchOrderListPage(ctx, window, cursor);
      stats.pagesFetched++;
      parsed.issues.forEach((i) => onIssue({ externalId: i.externalId, reason: `${i.apiName}: ${i.reason}` }));
      for (const o of parsed.orders) discovered.set(o.orderSn, o.orderStatus);
      if (!parsed.more) return;
      if (!parsed.nextCursor || seenCursors.has(parsed.nextCursor)) {
        this.log({ event: "SHOPEE_ORDER_PAGINATION_ANOMALY", ok: false, shopId: ctx.shopId, detail: `cursor=${parsed.nextCursor ?? "∅"} repeated/empty with more=true` });
        throw new ShopeePayloadError("v2.order.get_order_list", `next_cursor lặp lại/rỗng trong khi more=true (${parsed.nextCursor ?? "∅"})`);
      }
      seenCursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
  }
}
