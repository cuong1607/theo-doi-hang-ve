// ============================================================
// PRODUCT-ANALYTICS-2: isolated READ-ONLY sync for product analytics.
//
//   product_sales_facts_read   get_order_list (cursor) → get_order_detail (≤50)
//                              → shopee_product_sales_facts (idempotent upsert,
//                              an older provider update never overwrites a newer one)
//     backfill  orders CREATED in the last 30 completed days + today (≤15-day windows)
//     hot       orders UPDATED in the last 48 h, every 30 min — status changes of
//               any order (whatever its create date) surface here: overlap is built in
//     cold      orders UPDATED in the last 8 days, 04:00 / 16:00 VN (outage safety net)
//   product_extra_info_read    get_item_extra_info (≤50) → shopee_product_extra_snapshots
//                              twice a day; SNAPSHOT metrics only (semantics UNKNOWN)
//
// NOT the legacy 'order' / 'product' jobs (they stay retired and are never
// enqueued): own job types, own lanes (pa_*), own checkpoints, own tables.
// Resumable: the checkpoint (window, cursor, pending order_sn) is saved after
// every provider call, so a timeout or crash resumes — never restarts from zero.
// Never writes to Shopee. Never runs from a page render.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { continuation, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../../core/sync-runner.ts";
import type { SyncJobRow } from "../../core/sync-jobs.ts";
import { splitTimeWindows, type TimeWindow } from "../../core/time-windows.ts";
import { mapOrderToSalesFacts, type ProductSalesFactRow } from "../../../product-analytics/sales-facts.ts";
import { PRODUCT_ANALYTICS_LANES, PRODUCT_ANALYTICS_PRIORITY, type ProductAnalyticsSyncConfig } from "../../../product-analytics/config.ts";

import { PRODUCT_EXTRA_INFO_BATCH, PRODUCT_SALES_DETAIL_BATCH, PRODUCT_SALES_MAX_WINDOW_SECONDS, type ProductSalesContext, type ProductSalesReader } from "./sales-reader.ts";

export const PRODUCT_SALES_SYNC_TYPE = "product_sales_facts_read";
export const PRODUCT_EXTRA_INFO_SYNC_TYPE = "product_extra_info_read";
export const PRODUCT_ANALYTICS_SYNC_TYPES = [PRODUCT_SALES_SYNC_TYPE, PRODUCT_EXTRA_INFO_SYNC_TYPE] as const;
export type ProductAnalyticsSyncType = (typeof PRODUCT_ANALYTICS_SYNC_TYPES)[number];
export type ProductSalesStrategy = "backfill" | "hot" | "cold" | "manual";

export function isProductAnalyticsSyncType(type: string): type is ProductAnalyticsSyncType {
  return (PRODUCT_ANALYTICS_SYNC_TYPES as readonly string[]).includes(type);
}

const DAY_S = 86_400;
const MAX_PAGES_PER_JOB = 400;
const UPSERT_CHUNK = 500;

// ------------------------------------------------------------------ pure helpers

/** VN calendar day (YYYY-MM-DD) of an instant. */
export function zonedDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Unix seconds of 00:00 of a calendar day in a +07:00 zone (Asia/Ho_Chi_Minh has no DST). */
export function dayStartSeconds(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00+07:00`) / 1000);
}

export interface SalesWindowPlan {
  field: "create_time" | "update_time";
  windows: TimeWindow[];
}

/** Which orders a job reads (pure; unit tested). */
export function planSalesWindows(strategy: ProductSalesStrategy, now: Date, config: Pick<ProductAnalyticsSyncConfig, "backfillDays" | "hotLookbackHours" | "coldLookbackDays" | "timeZone">): SalesWindowPlan {
  const to = Math.floor(now.getTime() / 1000);
  if (strategy === "backfill") {
    const today = zonedDay(now, config.timeZone);
    const from = dayStartSeconds(today) - config.backfillDays * DAY_S;
    return { field: "create_time", windows: splitTimeWindows(from, to, PRODUCT_SALES_MAX_WINDOW_SECONDS) };
  }
  const lookback = strategy === "cold" ? config.coldLookbackDays * DAY_S : config.hotLookbackHours * 3600;
  return { field: "update_time", windows: splitTimeWindows(to - lookback, to, PRODUCT_SALES_MAX_WINDOW_SECONDS) };
}

export interface ParsedOrderListPage {
  orderSns: string[];
  more: boolean;
  nextCursor: string | null;
}

export class ProductSalesPayloadError extends Error {
  readonly code = "payload_invalid";
  constructor(api: string, message: string) {
    super(`${api}: ${message}`.slice(0, 300));
    this.name = "ProductSalesPayloadError";
  }
}

function envelope(raw: unknown, api: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new ProductSalesPayloadError(api, "không phải JSON object");
  const r = raw as Record<string, unknown>;
  if (typeof r.error === "string" && r.error) throw new ProductSalesPayloadError(api, `error=${r.error}`);
  const response = r.response;
  if (!response || typeof response !== "object") throw new ProductSalesPayloadError(api, "thiếu response");
  return response as Record<string, unknown>;
}

export function parseSalesOrderListPage(raw: unknown): ParsedOrderListPage {
  const response = envelope(raw, "get_order_list");
  const list = Array.isArray(response.order_list) ? response.order_list : [];
  const orderSns = [...new Set(list.map((e) => (e && typeof e === "object" ? String((e as Record<string, unknown>).order_sn ?? "").trim() : "")).filter((s) => s && s.length <= 64))];
  const cursor = response.next_cursor === null || response.next_cursor === undefined ? null : String(response.next_cursor);
  return { orderSns, more: response.more === true, nextCursor: cursor ? cursor : null };
}

export function parseSalesOrderDetails(raw: unknown): { rows: ProductSalesFactRow[]; returnedSns: Set<string>; issues: Array<{ orderSn: string | null; reason: string }> } {
  const response = envelope(raw, "get_order_detail");
  const list = Array.isArray(response.order_list) ? response.order_list : [];
  const rows: ProductSalesFactRow[] = [];
  const returnedSns = new Set<string>();
  const issues: Array<{ orderSn: string | null; reason: string }> = [];
  for (const entry of list) {
    const r = mapOrderToSalesFacts(entry);
    if ("issue" in r) {
      issues.push(r.issue);
      if (r.issue.orderSn) returnedSns.add(r.issue.orderSn);
      continue;
    }
    rows.push(...r.rows);
    returnedSns.add(r.rows[0].provider_order_id);
  }
  return { rows, returnedSns, issues };
}

export interface ExtraInfoRow {
  provider_item_id: string;
  sale: number | null;
  views: number | null;
  likes: number | null;
  rating_star: number | null;
  comment_count: number | null;
}

/** get_item_extra_info → snapshot rows (values as returned; semantics UNKNOWN). */
export function parseExtraInfo(raw: unknown): ExtraInfoRow[] {
  const response = envelope(raw, "get_item_extra_info");
  const list = Array.isArray(response.item_list) ? response.item_list : [];
  const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const out: ExtraInfoRow[] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const id = typeof r.item_id === "number" && Number.isSafeInteger(r.item_id) ? String(r.item_id) : typeof r.item_id === "string" && /^[0-9]{1,20}$/.test(r.item_id) ? r.item_id : null;
    if (!id) continue;
    const rating = typeof r.rating_star === "number" && Number.isFinite(r.rating_star) && r.rating_star >= 0 && r.rating_star <= 5 ? Math.round(r.rating_star * 100) / 100 : null;
    out.push({ provider_item_id: id, sale: count(r.sale), views: count(r.views), likes: count(r.likes), rating_star: rating, comment_count: count(r.comment_count) });
  }
  return out;
}

// ------------------------------------------------------------------ DB helpers

async function loadShop(db: SupabaseClient, shopId: string): Promise<ProductSalesContext> {
  const { data, error } = await db.from("shops").select("id, external_shop_id, channel").eq("id", shopId).maybeSingle<{ id: string; external_shop_id: string | null; channel: string }>();
  if (error) throw new Error(`Không đọc được shop: ${error.message}`);
  if (!data || data.channel !== "shopee" || !data.external_shop_id) throw new Error("Shop không tồn tại hoặc không phải Shopee.");
  return { shopId: data.id, externalShopId: data.external_shop_id };
}

export interface FactUpsertResult {
  inserted: number;
  updated: number;
  skippedStale: number;
  productsCreated: number;
}

export async function upsertProductSalesFacts(db: SupabaseClient, shopId: string, rows: ProductSalesFactRow[]): Promise<FactUpsertResult> {
  const total: FactUpsertResult = { inserted: 0, updated: 0, skippedStale: 0, productsCreated: 0 };
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { data, error } = await db.rpc("upsert_shopee_product_sales_facts", { p_shop_id: shopId, p_rows: rows.slice(i, i + UPSERT_CHUNK) }).single<{ inserted: number; updated: number; skipped_stale: number; products_created: number }>();
    if (error || !data) throw new Error(`Không lưu được dữ liệu bán hàng sản phẩm: ${error?.message ?? "unknown"}`);
    total.inserted += data.inserted;
    total.updated += data.updated;
    total.skippedStale += data.skipped_stale;
    total.productsCreated += data.products_created;
  }
  return total;
}

async function shopSettings(db: SupabaseClient, shopId: string): Promise<{ sales_sync_enabled: boolean; extra_info_enabled: boolean } | null> {
  const { data, error } = await db.from("product_analytics_shop_settings").select("sales_sync_enabled, extra_info_enabled").eq("shop_id", shopId).maybeSingle();
  if (error) throw new Error(`Không đọc được cấu hình Product Analytics: ${error.message}`);
  return (data as { sales_sync_enabled: boolean; extra_info_enabled: boolean } | null) ?? null;
}

const done = (failures: number, firstFailure: string | null, from: number | null, finishedAt: Date): SliceOutcome => ({
  kind: "done",
  logStatus: failures > 0 ? "partial" : "success",
  advanceCheckpoint: true,
  windowFrom: from === null ? null : new Date(from * 1000).toISOString(),
  windowTo: finishedAt.toISOString(),
  errorCode: failures > 0 ? "partial_failure" : null,
  errorMessage: failures > 0 ? `${failures} lỗi; đầu tiên: ${firstFailure ?? ""}`.slice(0, 500) : null,
});

// ------------------------------------------------------------------ sales facts runner

interface SalesCheckpoint {
  strategy: ProductSalesStrategy;
  field: "create_time" | "update_time";
  windows: TimeWindow[];
  windowIndex: number;
  cursor: string;
  /** order_sn discovered on the current page, details not stored yet. */
  pending: string[];
  pages: number;
}

export interface ProductAnalyticsRunnerDeps {
  db: SupabaseClient;
  reader: ProductSalesReader;
  config: ProductAnalyticsSyncConfig;
}

export function jobStrategy(job: SyncJobRow): ProductSalesStrategy {
  const s = job.metadata?.strategy;
  return s === "backfill" || s === "cold" || s === "manual" ? s : "hot";
}

export class ProductSalesFactsReadRunner implements SyncJobRunner {
  private readonly deps: ProductAnalyticsRunnerDeps;

  constructor(deps: ProductAnalyticsRunnerDeps) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const { db, reader, config } = this.deps;
    const progress = input.progress as SliceInput<SalesCheckpoint>["progress"];
    const ctx = await loadShop(db, job.shop_id);

    if (!progress.checkpoint) {
      // switched off since the job was queued → finish without a provider call (a manual refresh still runs)
      const settings = await shopSettings(db, ctx.shopId);
      if (job.mode !== "manual" && (!config.salesSyncEnabled || !settings?.sales_sync_enabled)) {
        progress.meta.skipped = "disabled";
        return done(0, null, null, now());
      }
      const strategy = jobStrategy(job);
      const plan = planSalesWindows(strategy === "manual" ? "hot" : strategy, now(), config);
      progress.checkpoint = { strategy, field: plan.field, windows: plan.windows, windowIndex: 0, cursor: "", pending: [], pages: 0 };
      progress.meta.salesScope = { strategy, field: plan.field, from: new Date(plan.windows[0].from * 1000).toISOString(), to: new Date(plan.windows.at(-1)!.to * 1000).toISOString(), windows: plan.windows.length };
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint;
    let calls = 0;

    while (true) {
      if (cp.pending.length > 0) {
        if (!budget.canSpend(1)) return continuation(budget, "more_details");
        if (calls >= config.callsPerSlice) return { kind: "more", reason: "batch_limit", remaining: "more_details" };
        const batch = cp.pending.slice(0, PRODUCT_SALES_DETAIL_BATCH);
        const raw = await reader.getOrderDetails(ctx, batch);
        calls++;
        const parsed = parseSalesOrderDetails(raw);
        const written = await upsertProductSalesFacts(db, ctx.shopId, parsed.rows);
        progress.counters.fetched += parsed.returnedSns.size;
        progress.counters.created += written.inserted;
        progress.counters.updated += written.updated;
        progress.incr("detailCalls");
        progress.incr("ordersFetched", parsed.returnedSns.size);
        progress.incr("factLines", parsed.rows.length);
        progress.incr("factsSkippedStale", written.skippedStale);
        progress.incr("productsCreated", written.productsCreated);
        for (const issue of parsed.issues) progress.addFailure({ externalId: issue.orderSn, reason: issue.reason });
        const missing = batch.filter((sn) => !parsed.returnedSns.has(sn));
        if (missing.length) progress.incr("ordersNotReturned", missing.length);
        cp.pending = cp.pending.slice(batch.length);
        if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
        continue;
      }
      if (cp.windowIndex >= cp.windows.length) break;
      if (cp.pages >= MAX_PAGES_PER_JOB) throw new Error("Quá nhiều trang đơn hàng trong một job (giới hạn an toàn).");
      if (!budget.canSpend(1)) return continuation(budget, "more_pages");
      if (calls >= config.callsPerSlice) return { kind: "more", reason: "batch_limit", remaining: "more_pages" };
      const w = cp.windows[cp.windowIndex];
      const raw = await reader.listOrders(ctx, { timeRangeField: cp.field, timeFrom: w.from, timeTo: w.to, cursor: cp.cursor });
      calls++;
      cp.pages++;
      const page = parseSalesOrderListPage(raw);
      progress.incr("listCalls");
      progress.incr("ordersListed", page.orderSns.length);
      cp.pending = page.orderSns;
      if (page.more) {
        // a repeated / empty cursor while more=true would loop forever: fail the job (retried later)
        if (!page.nextCursor || page.nextCursor === cp.cursor) throw new ProductSalesPayloadError("get_order_list", "more=true nhưng next_cursor rỗng / lặp lại");
        cp.cursor = page.nextCursor;
      } else {
        cp.windowIndex++;
        cp.cursor = "";
      }
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }

    const failures = progress.failureCount;
    if (cp.strategy === "backfill" && failures === 0) {
      const { error } = await db.from("product_analytics_shop_settings").update({ sales_backfill_done_at: now().toISOString() }).eq("shop_id", ctx.shopId);
      if (error) throw new Error(`Không ghi được mốc backfill: ${error.message}`);
    }
    return done(failures, progress.failures[0]?.reason ?? null, cp.windows[0]?.from ?? null, now());
  }
}

// ------------------------------------------------------------------ extra info runner

interface ExtraCheckpoint {
  ids: string[];
  batchIndex: number;
  capturedAt: string;
}

export class ProductExtraInfoReadRunner implements SyncJobRunner {
  private readonly deps: ProductAnalyticsRunnerDeps;

  constructor(deps: ProductAnalyticsRunnerDeps) {
    this.deps = deps;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, now } = input;
    const { db, reader, config } = this.deps;
    const progress = input.progress as SliceInput<ExtraCheckpoint>["progress"];
    const ctx = await loadShop(db, job.shop_id);
    if (!progress.checkpoint) {
      const settings = await shopSettings(db, ctx.shopId);
      if (job.mode !== "manual" && (!config.extraInfoSyncEnabled || !settings?.extra_info_enabled)) {
        progress.meta.skipped = "disabled";
        return done(0, null, null, now());
      }
      const ids: string[] = [];
      for (let page = 0; page < 20; page++) {
        const { data, error } = await db.from("shopee_products").select("provider_item_id").eq("shop_id", ctx.shopId).order("provider_item_id").range(page * 1000, page * 1000 + 999);
        if (error) throw new Error(`Không đọc được danh sách sản phẩm: ${error.message}`);
        const rows = (data ?? []) as Array<{ provider_item_id: string }>;
        ids.push(...rows.map((r) => r.provider_item_id));
        if (rows.length < 1000) break;
      }
      // one captured_at for the whole run: snapshots of one run line up
      progress.checkpoint = { ids, batchIndex: 0, capturedAt: now().toISOString() };
      progress.meta.extraScope = { items: ids.length };
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint;
    const batches: string[][] = [];
    for (let i = 0; i < cp.ids.length; i += PRODUCT_EXTRA_INFO_BATCH) batches.push(cp.ids.slice(i, i + PRODUCT_EXTRA_INFO_BATCH));
    let calls = 0;
    while (cp.batchIndex < batches.length) {
      if (!budget.canSpend(1)) return continuation(budget, "more_records");
      if (calls >= config.callsPerSlice) return { kind: "more", reason: "batch_limit", remaining: "more_records" };
      const batch = batches[cp.batchIndex];
      const rows = parseExtraInfo(await reader.getItemExtraInfo(ctx, batch));
      calls++;
      if (rows.length) {
        const { error } = await db
          .from("shopee_product_extra_snapshots")
          .upsert(rows.map((r) => ({ ...r, shop_id: ctx.shopId, captured_at: cp.capturedAt })), { onConflict: "shop_id,provider_item_id,captured_at", ignoreDuplicates: true });
        if (error) throw new Error(`Không lưu được snapshot sản phẩm: ${error.message}`);
      }
      progress.counters.fetched += rows.length;
      progress.counters.created += rows.length;
      progress.incr("itemsRequested", batch.length);
      progress.incr("itemsReturned", rows.length);
      cp.batchIndex++;
      if ((await lease.checkpoint(progress.toPatch())).cancelRequested) return { kind: "cancelled" };
    }
    // bounded retention (kept long enough for a future semantics study)
    const cutoff = new Date(now().getTime() - config.extraInfoRetentionDays * DAY_S * 1000).toISOString();
    const { error } = await db.from("shopee_product_extra_snapshots").delete().eq("shop_id", ctx.shopId).lt("captured_at", cutoff);
    if (error) throw new Error(`Không dọn được snapshot cũ: ${error.message}`);
    return done(0, null, null, now());
  }
}

export function createProductAnalyticsRunner(job: SyncJobRow, deps: ProductAnalyticsRunnerDeps): SyncJobRunner {
  if (job.sync_type === PRODUCT_SALES_SYNC_TYPE) return new ProductSalesFactsReadRunner(deps);
  if (job.sync_type === PRODUCT_EXTRA_INFO_SYNC_TYPE) return new ProductExtraInfoReadRunner(deps);
  throw new Error(`Không phải job Product Analytics: ${job.sync_type}`);
}

// ------------------------------------------------------------------ enqueue

export async function enqueueProductAnalyticsJob(
  db: SupabaseClient,
  input: { shopId: string; syncType: ProductAnalyticsSyncType; strategy: ProductSalesStrategy | "extra"; notBefore?: Date | null; createdBy?: string | null; now?: Date },
): Promise<{ jobId: string; created: boolean; status: string }> {
  const lane =
    input.syncType === PRODUCT_EXTRA_INFO_SYNC_TYPE
      ? PRODUCT_ANALYTICS_LANES.extraInfo
      : input.strategy === "backfill"
        ? PRODUCT_ANALYTICS_LANES.backfill
        : input.strategy === "cold"
          ? PRODUCT_ANALYTICS_LANES.cold
          : PRODUCT_ANALYTICS_LANES.hot;
  const priority =
    input.syncType === PRODUCT_EXTRA_INFO_SYNC_TYPE
      ? PRODUCT_ANALYTICS_PRIORITY.extraInfo
      : PRODUCT_ANALYTICS_PRIORITY[input.strategy === "extra" ? "hot" : input.strategy];
  const mode = input.strategy === "manual" ? "manual" : input.strategy === "backfill" ? "backfill" : "incremental";
  const { data, error } = await db
    .rpc("enqueue_sync_job", {
      p_shop_id: input.shopId,
      p_sync_type: input.syncType,
      p_mode: mode,
      p_priority: priority,
      p_metadata: { lane, strategy: input.strategy, requestedAt: (input.now ?? new Date()).toISOString() },
      p_created_by: input.createdBy ?? null,
    })
    .single<{ job_id: string; created: boolean; status: string }>();
  if (error || !data) throw new Error(`Không tạo được job Product Analytics: ${error?.message ?? "unknown"}`);
  // stagger jitter (not claimable before notBefore) — only for a job this call created
  if (data.created && input.notBefore) await db.from("channel_sync_jobs").update({ next_attempt_at: input.notBefore.toISOString() }).eq("id", data.job_id).eq("status", "pending");
  return { jobId: data.job_id, created: data.created, status: data.status };
}
