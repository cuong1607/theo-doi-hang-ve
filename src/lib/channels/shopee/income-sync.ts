// ============================================================
// PHASE SHOPEE-7: income release sync (job type "income").
//
//   syncIncomeReleases  one get_escrow_list page → apply_income_releases
//                       (one RPC per page: upsert + audit snapshot + order
//                       reconciliation, all in SQL)
//   syncIncomeOverview  get_income_overview → record_income_overview
//                       (Shopee totals vs local aggregate, monitoring only)
//   IncomeSyncJobRunner bounded, checkpointed: release_time windows ≤ 14 days
//                       from last success − overlap (first run: lookback),
//                       never before the orders-sync cutoff, page by page,
//                       then one overview call.
//
// "Pending" is derived (COMPLETED order without a release row), so no
// per-order polling: every scan re-reads the recent release windows, which is
// also the recheck of recently completed orders (§36).
// Never touches order_financials / financial_status (P&L stays escrow-based).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSyncState } from "../core/sync-log.ts";
import { getOrdersSyncFrom } from "../core/sync-settings.ts";
import { continuation, firstFailureSummary, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../core/sync-runner.ts";
import { splitTimeWindows } from "../core/time-windows.ts";
import { INCOME_API, parseIncomeOverview, parseReleasedEscrowPage, toReleaseRpcEntries } from "./income-adapter.ts";
import { FIRST_PAGE, INCOME_PAGE_SIZE, MAX_INCOME_WINDOW_SECONDS, type IncomeProviderContext, type ShopeeIncomeProvider } from "./income-provider.ts";
import { ShopeePayloadError } from "./product-adapter.ts";
import { JobRefusedError } from "./sync-errors.ts";

export const INCOME_SYNC_TYPE = "income";
const MAX_PAGES_PER_WINDOW = 200;

export type IncomeShop = { id: string; channel: string; external_shop_id: string; data_source: string; currency: string | null; payout_source: string | null };

export interface ApplyReleasesResult {
  created: number;
  changed: number;
  unchanged: number;
  linked: number;
  unlinked: number;
}

const logIncome = (event: Record<string, unknown>) => console.info(JSON.stringify({ source: "shopee-income", ...event }));

export class ShopeeIncomeSyncService {
  private readonly db: SupabaseClient;
  private readonly provider: ShopeeIncomeProvider;
  private readonly now: () => Date;

  constructor(deps: { db: SupabaseClient; provider: ShopeeIncomeProvider; now?: () => Date }) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.now = deps.now ?? (() => new Date());
  }

  get mode() {
    return this.provider.mode;
  }

  /** One release page: parse + persist. Payload problems throw ShopeePayloadError (the window fails, not the job). */
  async syncIncomeReleases(shop: { id: string; currency: string; ctx: IncomeProviderContext }, window: { from: number; to: number }, pageNo: number) {
    const payload = await this.provider.listReleasedEscrows(shop.ctx, { from: window.from, to: window.to, pageNo, pageSize: INCOME_PAGE_SIZE });
    const page = parseReleasedEscrowPage(payload.raw);
    const applied = await applyIncomeReleases(this.db, shop.id, "escrow_list", toReleaseRpcEntries(page.entries, shop.currency, INCOME_API.escrowList), this.now());
    logIncome({ event: "income_released_page", shopId: shop.id, entries: page.entries.length, ...applied });
    return { page, applied };
  }

  async syncIncomeOverview(shop: { id: string; currency: string; ctx: IncomeProviderContext }) {
    const payload = await this.provider.getIncomeOverview(shop.ctx);
    const overview = parseIncomeOverview(payload.raw);
    const { data, error } = await this.db.rpc("record_income_overview", {
      p_shop_id: shop.id,
      p_currency: shop.currency,
      p_pending: overview.pendingAmount,
      p_released: overview.releasedAmount,
      p_payload: overview.payload,
      p_fetched_at: this.now().toISOString(),
    });
    if (error) throw new Error(`Không lưu được tổng quan thu nhập: ${error.message}`);
    logIncome({ event: "income_overview_synced", shopId: shop.id, pending: overview.pendingAmount, released: overview.releasedAmount, ...(data as object) });
    return overview;
  }
}

/** apply_income_releases (shared by the escrow-list scan and cross-border payouts). */
export async function applyIncomeReleases(db: SupabaseClient, shopId: string, source: "escrow_list" | "payout_detail" | "fixture", entries: unknown[], at: Date): Promise<ApplyReleasesResult> {
  if (entries.length === 0) return { created: 0, changed: 0, unchanged: 0, linked: 0, unlinked: 0 };
  const { data, error } = await db.rpc("apply_income_releases", { p_shop_id: shopId, p_source: source, p_entries: entries, p_synced_at: at.toISOString() });
  if (error) throw new Error(`Không lưu được dữ liệu giải ngân: ${error.message} [${error.code ?? ""}]`);
  return data as ApplyReleasesResult;
}

export async function loadIncomeShop(db: SupabaseClient, shopId: string, providerMode: string): Promise<IncomeShop> {
  const { data, error } = await db.from("shops").select("id, channel, external_shop_id, data_source, currency, payout_source").eq("id", shopId).maybeSingle<IncomeShop>();
  if (error) throw new Error(`Không đọc được shop: ${error.message}`);
  if (!data) throw new JobRefusedError("shop_not_found", "Không tìm thấy shop.");
  if (data.channel !== "shopee") throw new JobRefusedError("not_shopee", "Shop không thuộc kênh Shopee.");
  if (data.data_source !== providerMode) {
    throw new JobRefusedError("source_mismatch", data.data_source === "fixture" ? "Shop fixture chỉ được đồng bộ bằng fixture provider." : "Không được đồng bộ dữ liệu fixture vào shop thật.");
  }
  if (!data.currency) {
    // shops.currency is not filled by every connect flow — the shop's own orders say it
    const { data: o, error: oe } = await db.from("channel_orders").select("currency").eq("shop_id", shopId).order("created_at_channel", { ascending: false, nullsFirst: false }).limit(1).maybeSingle<{ currency: string }>();
    if (oe) throw new Error(`Không đọc được tiền tệ của shop: ${oe.message}`);
    if (!o?.currency) throw new JobRefusedError("currency_missing", "Shop chưa có tiền tệ (và chưa có đơn nào) — chưa đối soát được.");
    return { ...data, currency: o.currency };
  }
  return data;
}

/** Window of an incremental / manual / backfill job (seconds), clamped to the orders-sync cutoff when asked. */
export async function jobWindow(
  db: SupabaseClient,
  input: { shopId: string; syncType: string; job: SliceInput["job"]; overlapMinutes: number; lookbackDays: number; now: Date },
): Promise<{ from: Date; to: Date }> {
  if (input.job.mode === "backfill" && input.job.window_from && input.job.window_to) return { from: new Date(input.job.window_from), to: new Date(input.job.window_to) };
  const state = await getSyncState(db, input.shopId, input.syncType);
  const to = input.now;
  const from = state?.last_success_at ? new Date(new Date(state.last_success_at).getTime() - input.overlapMinutes * 60_000) : new Date(to.getTime() - input.lookbackDays * 86_400_000);
  return { from, to };
}

export interface IncomeJobCheckpoint {
  phase: "releases" | "overview" | "done";
  windowIndex: number;
  pageNo: number;
  pagesInWindow: number;
}

export class IncomeSyncJobRunner implements SyncJobRunner {
  private readonly db: SupabaseClient;
  private readonly sync: ShopeeIncomeSyncService;
  private readonly providerMode: string;

  constructor(deps: { db: SupabaseClient; sync: ShopeeIncomeSyncService; providerMode: string }) {
    this.db = deps.db;
    this.sync = deps.sync;
    this.providerMode = deps.providerMode;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, config, now } = input;
    const progress = input.progress as SliceInput<IncomeJobCheckpoint>["progress"];
    const shopRow = await loadIncomeShop(this.db, job.shop_id, this.providerMode);
    const shop = { id: shopRow.id, currency: shopRow.currency!, ctx: { shopId: shopRow.id, externalShopId: shopRow.external_shop_id } };

    let windowFrom = job.window_from ? new Date(job.window_from) : null;
    let windowTo = job.window_to ? new Date(job.window_to) : null;
    if (!progress.checkpoint) {
      const w = await jobWindow(this.db, { shopId: shop.id, syncType: INCOME_SYNC_TYPE, job, overlapMinutes: config.incomeOverlapMinutes, lookbackDays: config.incomeLookbackDays, now: now() });
      windowFrom = w.from;
      windowTo = w.to;
      progress.checkpoint = { phase: "releases", windowIndex: 0, pageNo: FIRST_PAGE.escrowList, pagesInWindow: 0 };
      progress.meta.providerMode = this.providerMode;
      const first = await lease.checkpoint(progress.toPatch({ windowFrom: windowFrom.toISOString(), windowTo: windowTo.toISOString() }));
      if (first.cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint!;
    const cutoff = await getOrdersSyncFrom(this.db);
    const walkFrom = windowFrom && cutoff && cutoff > windowFrom ? cutoff : windowFrom;
    const windows =
      walkFrom && windowTo && walkFrom < windowTo ? splitTimeWindows(Math.floor(walkFrom.getTime() / 1000), Math.floor(windowTo.getTime() / 1000), MAX_INCOME_WINDOW_SECONDS) : [];
    progress.meta.windows = windows.length;
    const save = async () => (await lease.checkpoint(progress.toPatch())).cancelRequested;

    while (cp.phase === "releases" && cp.windowIndex < windows.length) {
      if (budget.expired || !budget.canSpend(1)) return continuation(budget, "more_pages");
      const window = windows[cp.windowIndex];
      let result: Awaited<ReturnType<ShopeeIncomeSyncService["syncIncomeReleases"]>>;
      try {
        result = await this.sync.syncIncomeReleases(shop, window, cp.pageNo);
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
      progress.counters.fetched += result.page.entries.length;
      progress.counters.created += result.applied.created;
      progress.counters.updated += result.applied.changed;
      progress.incr("releasesUnchanged", result.applied.unchanged);
      progress.incr("releasesUnlinked", result.applied.unlinked);
      for (const issue of result.page.issues) progress.addFailure({ externalId: issue.externalId, reason: `${issue.apiName}: ${issue.reason}` });
      if (result.page.more && cp.pagesInWindow < MAX_PAGES_PER_WINDOW) cp.pageNo++;
      else this.nextWindow(cp);
      if (await save()) return { kind: "cancelled" };
    }
    if (cp.phase === "releases") {
      cp.phase = "overview";
      if (await save()) return { kind: "cancelled" };
    }

    if (cp.phase === "overview") {
      if (!budget.canSpend(1)) return continuation(budget, "more_records");
      try {
        await this.sync.syncIncomeOverview(shop);
        progress.incr("overviews");
      } catch (err) {
        if (!(err instanceof ShopeePayloadError)) throw err;
        progress.addFailure({ externalId: null, reason: `${INCOME_API.overview}: ${err.message}` });
      }
      cp.phase = "done";
      if (await save()) return { kind: "cancelled" };
    }

    const failureCount = progress.failureCount;
    const summary = firstFailureSummary(progress.failures, failureCount);
    const logStatus = failureCount === 0 ? "success" : "partial";
    return {
      kind: "done",
      logStatus,
      // a failed window is re-read next time (checkpoint not advanced) — the "retry" of missing income data
      advanceCheckpoint: logStatus === "success" && (job.mode === "incremental" || job.mode === "manual"),
      windowFrom: windowFrom?.toISOString() ?? null,
      windowTo: windowTo?.toISOString() ?? null,
      errorCode: summary?.code ?? null,
      errorMessage: summary?.message ?? null,
    };
  }

  private nextWindow(cp: IncomeJobCheckpoint) {
    cp.windowIndex++;
    cp.pageNo = FIRST_PAGE.escrowList;
    cp.pagesInWindow = 0;
  }
}
