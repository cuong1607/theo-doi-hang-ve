// ============================================================
// PHASE SHOPEE-6: return sync (operational layer only — never moves stock,
// never touches COGS; dispositions do, see core/returns.ts).
//
//   ShopeeReturnSyncService.syncReturnDetail   get_return_detail → order must
//       exist (missing → fetched through the order sync first; still missing →
//       channel_return_sync_retries with the reason) → snapshot (history of
//       meaningful changes, PII stripped) → apply_channel_return (one tx:
//       return + items matched to ORIGINAL order lines, dispositions kept)
//   ReturnSyncJobRunner   bounded, checkpointed job slices:
//       seed   retries + OPEN returns not refreshed for returnOpenTtlHours
//       walk   15-day update_time windows (incremental: last success −
//              overlap; never before the orders-sync cutoff), page_no paging;
//              a listed return is fetched only if new / changed / not terminal
//       detail ≤ returnDetailConcurrency in flight, checkpoint per round;
//              one broken return never blocks the others
// Orders created before channel_sync_settings.orders_from are not fetched for
// a return (the return is skipped, not failed); returns of orders already
// stored are always kept.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { saveMeaningfulOrderSnapshot } from "../core/snapshots.ts";
import { getSyncState } from "../core/sync-log.ts";
import { getOrdersSyncFrom } from "../core/sync-settings.ts";
import { continuation, firstFailureSummary, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../core/sync-runner.ts";
import { mapWithConcurrency, splitTimeWindows } from "../core/time-windows.ts";
import type { OrderBatchAccumulator, ShopeeOrderSyncService } from "./order-sync.ts";
import { ShopeePayloadError } from "./product-adapter.ts";
import { parseReturnDetail, parseReturnListPage, returnFingerprint, toApplyReturnArgs } from "./return-adapter.ts";
import { MAX_RETURN_WINDOW_SECONDS, RETURN_LIST_PAGE_SIZE, type ReturnProviderContext, type ShopeeReturnProvider } from "./return-provider.ts";
import { errorInfo, isJobLevelProviderError, JobRefusedError } from "./sync-errors.ts";

export const RETURN_SYNC_TYPE = "return";
/** No success yet → look back this far (still clamped to the orders-sync cutoff). */
export const RETURN_INITIAL_LOOKBACK_SECONDS = 15 * 24 * 60 * 60;
/** Repair scope / seed caps (metadata must stay small). */
export const MAX_REPAIR_RETURN_SNS = 100;
const SEED_LIMIT = 100;
const MAX_PAGES_PER_WINDOW = 200;

type Shop = { id: string; channel: string; external_shop_id: string; data_source: string; currency: string | null };

export type ReturnSyncOutcome =
  | { status: "stored"; created: boolean; items: number; unmatched: number; orderFetched: boolean }
  | { status: "skipped_before_cutoff" }
  | { status: "order_missing"; message: string }
  | { status: "failed"; code: string; message: string };

const logReturn = (event: Record<string, unknown>) => console.info(JSON.stringify({ source: "shopee-return", ...event }));

export class ShopeeReturnSyncService {
  private readonly db: SupabaseClient;
  private readonly provider: ShopeeReturnProvider;
  private readonly orders: ShopeeOrderSyncService;
  private readonly now: () => Date;

  constructor(deps: { db: SupabaseClient; provider: ShopeeReturnProvider; orders: ShopeeOrderSyncService; now?: () => Date }) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.orders = deps.orders;
    this.now = deps.now ?? (() => new Date());
  }

  get mode() {
    return this.provider.mode;
  }

  /** One get_return_list page (parsed). Payload problems throw ShopeePayloadError (the window fails, not the job). */
  async fetchReturnListPage(ctx: ReturnProviderContext, window: { from: number; to: number }, pageNo: number) {
    const payload = await this.provider.listReturns(ctx, { updateTimeFrom: window.from, updateTimeTo: window.to, pageNo, pageSize: RETURN_LIST_PAGE_SIZE });
    return parseReturnListPage(payload.raw);
  }

  /** One return end-to-end. Job-level provider errors (auth / rate limit) are rethrown; anything else is this return's outcome. */
  async syncReturnDetail(target: { shopId: string; ctx: ReturnProviderContext; currency: string | null }, returnSn: string, cutoff: Date | null): Promise<ReturnSyncOutcome> {
    let parsed: ReturnType<typeof parseReturnDetail>;
    try {
      const payload = await this.provider.getReturnDetail(target.ctx, { returnSn });
      parsed = parseReturnDetail(payload.raw);
    } catch (err) {
      if (isJobLevelProviderError(err)) throw err;
      const info = err instanceof ShopeePayloadError ? { code: "provider_error", message: err.message } : errorInfo(err);
      return { status: "failed", code: info.code, message: info.message };
    }
    if ("issue" in parsed) return { status: "failed", code: "invalid_payload", message: parsed.issue.reason };
    const { detail, sanitized } = parsed;

    let orderId = await this.findOrder(target.shopId, detail.externalOrderSn);
    let orderFetched = false;
    if (!orderId) {
      const acc: OrderBatchAccumulator = {
        counts: { fetched: 0, created: 0, updated: 0, failed: 0 },
        failures: [],
        failedSns: new Set(),
        stats: { detailsFetched: 0, ordersCompleted: 0, ordersCancelled: 0, linesUnresolved: 0, cogs: {} },
        mapping: { complete: 0, partial: 0, unmapped: 0 },
        storedOrders: 0,
      };
      await this.orders.processDetailBatch({ shopId: target.shopId, ctx: target.ctx, currency: target.currency }, [detail.externalOrderSn], acc, {
        rethrowProviderErrors: true,
        createdFrom: cutoff,
      });
      if (acc.stats.skippedBeforeCutoff) {
        await this.clearRetry(target.shopId, returnSn);
        return { status: "skipped_before_cutoff" };
      }
      orderId = await this.findOrder(target.shopId, detail.externalOrderSn);
      if (!orderId) {
        const message = acc.failures[0]?.reason ?? "Không lấy được đơn gốc của yêu cầu trả hàng.";
        await this.recordRetry(target.shopId, returnSn, detail.externalOrderSn, "order_missing", message);
        return { status: "order_missing", message };
      }
      orderFetched = true;
    }

    const syncedAt = this.now().toISOString();
    await saveMeaningfulOrderSnapshot(this.db, {
      shopId: target.shopId,
      orderSn: detail.externalReturnSn,
      entityType: "return",
      apiName: "v2.returns.get_return_detail",
      payload: sanitized,
      fingerprint: returnFingerprint(detail),
      sourceMode: this.provider.mode,
      sourceUpdatedAt: detail.updatedAtChannel,
      syncedAt,
    });
    const { data, error } = await this.db.rpc("apply_channel_return", { p_shop_id: target.shopId, p_order_id: orderId, ...toApplyReturnArgs(detail), p_synced_at: syncedAt });
    if (error) throw new Error(`Không lưu được yêu cầu trả hàng ${returnSn}: ${error.message} [${error.code ?? ""}]`);
    await this.clearRetry(target.shopId, returnSn);
    const r = data as { created: boolean; items: number; unmatched: number };
    logReturn({ event: "return_synced", returnSn, orderSn: detail.externalOrderSn, status: detail.status, created: r.created, items: r.items, unmatched: r.unmatched, orderFetched });
    return { status: "stored", created: r.created, items: r.items, unmatched: r.unmatched, orderFetched };
  }

  private async findOrder(shopId: string, orderSn: string): Promise<string | null> {
    const { data, error } = await this.db.from("channel_orders").select("id").eq("shop_id", shopId).eq("external_order_sn", orderSn).maybeSingle<{ id: string }>();
    if (error) throw new Error(`Không đọc được đơn: ${error.message}`);
    return data?.id ?? null;
  }

  private async recordRetry(shopId: string, returnSn: string, orderSn: string | null, reason: string, message: string) {
    const nowIso = this.now().toISOString();
    const { data: existing } = await this.db.from("channel_return_sync_retries").select("attempts").eq("shop_id", shopId).eq("external_return_sn", returnSn).maybeSingle<{ attempts: number }>();
    const { error } = await this.db.from("channel_return_sync_retries").upsert(
      { shop_id: shopId, external_return_sn: returnSn, external_order_sn: orderSn, reason, message: message.slice(0, 500), attempts: (existing?.attempts ?? 0) + 1, last_attempt_at: nowIso },
      { onConflict: "shop_id,external_return_sn" },
    );
    if (error) throw new Error(`Không ghi được hàng chờ thử lại trả hàng: ${error.message}`);
  }

  private async clearRetry(shopId: string, returnSn: string) {
    const { error } = await this.db.from("channel_return_sync_retries").delete().eq("shop_id", shopId).eq("external_return_sn", returnSn);
    if (error) throw new Error(`Không xoá được hàng chờ thử lại trả hàng: ${error.message}`);
  }
}

export interface ReturnJobCheckpoint {
  phase: "discover" | "done";
  windowIndex: number;
  pageNo: number;
  pagesInWindow: number;
  pendingSns: string[];
  /** Returns already processed by THIS job (seeded retries / open returns are not fetched twice when listed again). */
  attemptedSns?: string[];
}

const MAX_ATTEMPTED_TRACKED = 1000;

export class ReturnSyncJobRunner implements SyncJobRunner {
  private readonly db: SupabaseClient;
  private readonly sync: ShopeeReturnSyncService;
  private readonly providerMode: string;

  constructor(deps: { db: SupabaseClient; sync: ShopeeReturnSyncService; providerMode: string }) {
    this.db = deps.db;
    this.sync = deps.sync;
    this.providerMode = deps.providerMode;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, config, now } = input;
    const progress = input.progress as SliceInput<ReturnJobCheckpoint>["progress"];
    const shop = await this.loadShop(job.shop_id);
    const ctx: ReturnProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    const repairSns = Array.isArray((progress.meta.scope as { returnSns?: unknown } | undefined)?.returnSns)
      ? (progress.meta.scope as { returnSns: string[] }).returnSns.slice(0, MAX_REPAIR_RETURN_SNS)
      : null;
    const cutoff = await getOrdersSyncFrom(this.db);

    let windowFrom = job.window_from ? new Date(job.window_from) : null;
    let windowTo = job.window_to ? new Date(job.window_to) : null;
    if (!progress.checkpoint) {
      if (repairSns) {
        progress.checkpoint = { phase: "done", windowIndex: 0, pageNo: 0, pagesInWindow: 0, pendingSns: [...new Set(repairSns)] };
      } else {
        if (job.mode !== "backfill" || !windowFrom || !windowTo) {
          const state = await getSyncState(this.db, shop.id, RETURN_SYNC_TYPE);
          windowTo = now();
          windowFrom = state?.last_success_at
            ? new Date(new Date(state.last_success_at).getTime() - config.orderOverlapMinutes * 60_000)
            : new Date(windowTo.getTime() - RETURN_INITIAL_LOOKBACK_SECONDS * 1000);
        }
        progress.checkpoint = { phase: "discover", windowIndex: 0, pageNo: 0, pagesInWindow: 0, pendingSns: await this.seed(shop.id, config.returnOpenTtlHours, now()) };
        progress.incr("seeded", progress.checkpoint.pendingSns.length);
      }
      progress.meta.providerMode = this.providerMode;
      const first = await lease.checkpoint(progress.toPatch({ windowFrom: windowFrom?.toISOString() ?? null, windowTo: windowTo?.toISOString() ?? null }));
      if (first.cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint!;
    const walkFrom = windowFrom && cutoff && cutoff > windowFrom ? cutoff : windowFrom;
    const windows =
      walkFrom && windowTo && walkFrom < windowTo
        ? splitTimeWindows(Math.floor(walkFrom.getTime() / 1000), Math.floor(windowTo.getTime() / 1000), MAX_RETURN_WINDOW_SECONDS)
        : [];
    progress.meta.windows = windows.length;
    const save = async () => (await lease.checkpoint(progress.toPatch())).cancelRequested;

    for (;;) {
      if (cp.pendingSns.length > 0) {
        if (budget.expired || !budget.canSpend(1)) return continuation(budget, "more_details");
        const take = cp.pendingSns.slice(0, Math.max(1, Math.min(config.returnDetailConcurrency, budget.apiCallsLeft)));
        const done = new Set<string>();
        await mapWithConcurrency(take, config.returnDetailConcurrency, async (sn) => {
          const outcome = await this.sync.syncReturnDetail({ shopId: shop.id, ctx, currency: shop.currency }, sn, cutoff);
          done.add(sn);
          progress.incrIn("outcomes", outcome.status);
          if (outcome.status === "stored") {
            if (outcome.created) progress.counters.created++;
            else progress.counters.updated++;
            if (outcome.orderFetched) progress.incr("ordersFetchedFirst");
            if (outcome.unmatched) progress.incr("unmatchedItems", outcome.unmatched);
          } else if (outcome.status === "order_missing") {
            progress.addFailure({ externalId: sn, reason: `order_missing: ${outcome.message}` });
          } else if (outcome.status === "failed") {
            progress.addFailure({ externalId: sn, reason: `${outcome.code}: ${outcome.message}` });
          }
        });
        cp.pendingSns = cp.pendingSns.filter((sn) => !done.has(sn));
        cp.attemptedSns = [...(cp.attemptedSns ?? []), ...done].slice(-MAX_ATTEMPTED_TRACKED);
        if (await save()) return { kind: "cancelled" };
        continue;
      }

      if (cp.phase !== "discover" || cp.windowIndex >= windows.length) break;
      if (!budget.canSpend(1)) return continuation(budget, "more_pages");
      const window = windows[cp.windowIndex];
      let page: ReturnType<typeof parseReturnListPage>;
      try {
        page = await this.sync.fetchReturnListPage(ctx, window, cp.pageNo);
      } catch (err) {
        if (!(err instanceof ShopeePayloadError)) throw err;
        progress.incr("windowsFailed");
        progress.addFailure({ externalId: null, reason: `window ${new Date(window.from * 1000).toISOString()}: ${err.message}` });
        this.nextWindow(cp);
        if (await save()) return { kind: "cancelled" };
        continue;
      }
      progress.incr("pages");
      cp.pagesInWindow++;
      progress.counters.fetched += page.entries.length;
      for (const issue of page.issues) progress.addFailure({ externalId: issue.externalId, reason: `${issue.apiName}: ${issue.reason}` });
      const locals = await this.loadLocalReturns(shop.id, page.entries.map((e) => e.returnSn));
      const attempted = new Set(cp.attemptedSns ?? []);
      for (const e of page.entries) {
        if (attempted.has(e.returnSn)) continue;
        const local = locals.get(e.returnSn);
        const changed = !local || !local.isTerminal || !e.updatedAt || local.updatedAt === null || new Date(local.updatedAt).getTime() !== new Date(e.updatedAt).getTime();
        if (!changed) {
          progress.incr("detailsSkippedUnchanged");
          continue;
        }
        if (!cp.pendingSns.includes(e.returnSn)) cp.pendingSns.push(e.returnSn);
      }
      if (page.more && cp.pagesInWindow < MAX_PAGES_PER_WINDOW) cp.pageNo++;
      else this.nextWindow(cp);
      if (await save()) return { kind: "cancelled" };
    }

    cp.phase = "done";
    const failureCount = progress.failureCount;
    const summary = firstFailureSummary(progress.failures, failureCount);
    const logStatus = failureCount === 0 ? "success" : "partial";
    return {
      kind: "done",
      logStatus,
      advanceCheckpoint: logStatus === "success" && (job.mode === "incremental" || job.mode === "manual") && !repairSns,
      windowFrom: windowFrom?.toISOString() ?? null,
      windowTo: windowTo?.toISOString() ?? null,
      errorCode: summary?.code ?? null,
      errorMessage: summary?.message ?? null,
    };
  }

  /** Retries + open returns not refreshed recently (bounded) — status changes are never missed. */
  private async seed(shopId: string, openTtlHours: number, at: Date): Promise<string[]> {
    const retries = await this.db.from("channel_return_sync_retries").select("external_return_sn").eq("shop_id", shopId).order("last_attempt_at").limit(SEED_LIMIT);
    const open = await this.db
      .from("channel_returns")
      .select("external_return_sn")
      .eq("shop_id", shopId)
      .eq("is_terminal", false)
      .lt("last_synced_at", new Date(at.getTime() - openTtlHours * 3_600_000).toISOString())
      .order("last_synced_at")
      .limit(SEED_LIMIT);
    if (retries.error) throw new Error(retries.error.message);
    if (open.error) throw new Error(open.error.message);
    return [...new Set([...(retries.data ?? []), ...(open.data ?? [])].map((r) => r.external_return_sn as string))];
  }

  private nextWindow(cp: ReturnJobCheckpoint) {
    cp.windowIndex++;
    cp.pageNo = 0;
    cp.pagesInWindow = 0;
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

  private async loadLocalReturns(shopId: string, sns: string[]): Promise<Map<string, { updatedAt: string | null; isTerminal: boolean }>> {
    const result = new Map<string, { updatedAt: string | null; isTerminal: boolean }>();
    if (sns.length === 0) return result;
    const { data, error } = await this.db.from("channel_returns").select("external_return_sn, updated_at_channel, is_terminal").eq("shop_id", shopId).in("external_return_sn", sns);
    if (error) throw new Error(`Không đọc được trả hàng đã lưu: ${error.message}`);
    for (const r of (data ?? []) as Array<{ external_return_sn: string; updated_at_channel: string | null; is_terminal: boolean }>) {
      result.set(r.external_return_sn, { updatedAt: r.updated_at_channel, isTerminal: r.is_terminal });
    }
    return result;
  }
}
