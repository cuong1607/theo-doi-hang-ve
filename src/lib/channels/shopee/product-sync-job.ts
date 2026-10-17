// ============================================================
// PHASE SHOPEE-PERF-1: product sync as a resumable, bounded job.
//
//   scan    incremental / manual: get_item_list with update_time window
//           [last_success − overlap, job start] (no success yet → full scan)
//           backfill: full catalog scan (all statuses), skip unchanged
//           repair: full scan with every listing re-fetched, or only
//           metadata.scope.itemIds when given
//   decide  per listing shouldRefreshProductDetail (update_time vs
//           channel_products.source_updated_at, units missing) → pending
//   detail  pending in chunks sized to the remaining call budget:
//           get_item_base_info (≤ 50) + get_model_list (≤ productDetailConcurrency
//           in flight) → upserts + latest snapshots
//   finish  auto-map exact SKUs + review flags (DB only)
//
// Checkpoint after every page (offset_value + pending ids) and every chunk.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { autoMapChannelModels, refreshMappingReviewFlags } from "../core/sku-mapping.ts";
import { getSyncState } from "../core/sync-log.ts";
import { continuation, firstFailureSummary, type SliceInput, type SliceOutcome, type SyncJobRunner } from "../core/sync-runner.ts";
import type { ParseIssue } from "./product-adapter.ts";
import { BASE_INFO_BATCH_SIZE, type ProductProviderContext } from "./product-provider.ts";
import { PRODUCT_SYNC_TYPE, type ShopeeProductSyncService } from "./product-sync.ts";
import { shouldRefreshProductDetail, type LocalProductState } from "./sync-decisions.ts";
import { errorInfo, JobRefusedError } from "./sync-errors.ts";

const MAX_DISCOVERY_PAGES = 1000;
/** get_model_list rounds per detail chunk (chunk ≤ productDetailConcurrency × this). */
const MODEL_ROUNDS_PER_CHUNK = 4;
export const MAX_REPAIR_ITEM_IDS = 200;

export interface ProductJobCheckpoint {
  phase: "discover" | "finalize" | "done";
  offset: number;
  pages: number;
  pendingItemIds: string[];
  /** is_kit flags from get_item_list for pending ids (base_info lacks it). */
  kitByItemId: Record<string, boolean | null>;
  /** Full scan (no update_time filter). */
  fullScan: boolean;
}

type Shop = { id: string; channel: string; external_shop_id: string; data_source: string; currency: string | null };

export class ProductSyncJobRunner implements SyncJobRunner {
  private readonly db: SupabaseClient;
  private readonly sync: ShopeeProductSyncService;
  private readonly providerMode: string;

  constructor(deps: { db: SupabaseClient; sync: ShopeeProductSyncService; providerMode: string }) {
    this.db = deps.db;
    this.sync = deps.sync;
    this.providerMode = deps.providerMode;
  }

  async runSlice(input: SliceInput): Promise<SliceOutcome> {
    const { job, lease, budget, config, now } = input;
    const progress = input.progress as SliceInput<ProductJobCheckpoint>["progress"];
    const shop = await this.loadShop(job.shop_id);
    const ctx: ProductProviderContext = { shopId: shop.id, externalShopId: shop.external_shop_id };
    const scopeIds = Array.isArray((progress.meta.scope as { itemIds?: unknown } | undefined)?.itemIds)
      ? ((progress.meta.scope as { itemIds: string[] }).itemIds).slice(0, MAX_REPAIR_ITEM_IDS)
      : null;

    let windowFrom = job.window_from ? new Date(job.window_from) : null;
    let windowTo = job.window_to ? new Date(job.window_to) : null;
    if (!progress.checkpoint) {
      windowTo = now();
      windowFrom = null;
      if (job.mode === "incremental" || job.mode === "manual") {
        const state = await getSyncState(this.db, shop.id, PRODUCT_SYNC_TYPE);
        if (state?.last_success_at) windowFrom = new Date(new Date(state.last_success_at).getTime() - config.productOverlapMinutes * 60_000);
      }
      progress.checkpoint = scopeIds
        ? { phase: "finalize", offset: 0, pages: 0, pendingItemIds: [...new Set(scopeIds)], kitByItemId: {}, fullScan: false }
        : { phase: "discover", offset: 0, pages: 0, pendingItemIds: [], kitByItemId: {}, fullScan: windowFrom === null };
      progress.meta.providerMode = this.providerMode;
      progress.meta.syncMode = progress.checkpoint.fullScan ? "full" : scopeIds ? "scoped" : "incremental";
      const first = await lease.checkpoint(progress.toPatch({ windowFrom: windowFrom?.toISOString() ?? null, windowTo: windowTo.toISOString(), offsetValue: 0 }));
      if (first.cancelRequested) return { kind: "cancelled" };
    }
    const cp = progress.checkpoint!;
    const updateWindow = !cp.fullScan && windowFrom && windowTo ? { from: Math.floor(windowFrom.getTime() / 1000), to: Math.floor(windowTo.getTime() / 1000) } : null;
    const save = async () => (await lease.checkpoint(progress.toPatch({ offsetValue: cp.offset }))).cancelRequested;

    for (;;) {
      // ---- details for queued listings
      if (cp.pendingItemIds.length > 0) {
        // base_info costs 1 call per chunk, get_model_list ≤ 1 per listing.
        // Chunk size is bounded by calls left AND by a few rounds of model calls,
        // so one chunk (which cannot be split mid-way without losing models)
        // stays short even when Shopee answers slowly.
        const left = budget.apiCallsLeft;
        if (left < 2 || !budget.canSpend(2)) return continuation(budget, "more_details");
        const chunk = cp.pendingItemIds.slice(0, Math.min(BASE_INFO_BATCH_SIZE, left - 1, config.productDetailConcurrency * MODEL_ROUNDS_PER_CHUNK));
        const acc = {
          counts: { fetched: chunk.length, created: 0, updated: 0, failed: 0 },
          failures: [] as Array<{ externalId: string | null; reason: string }>,
          failedItemIds: new Set<string>(),
          addIssues(issues: ParseIssue[]) {
            issues.forEach((i) => acc.failures.push({ externalId: i.externalId, reason: `${i.apiName}: ${i.reason}` }));
          },
          setModels(n: number) {
            progress.incr("modelsFetched", n);
          },
        };
        const kit = new Map(chunk.map((id) => [id, cp.kitByItemId[id] ?? null]));
        await this.sync.storeItems(shop.id, ctx, shop.currency, chunk, kit, acc, { rethrowProviderErrors: true });
        progress.counters.created += acc.counts.created;
        progress.counters.updated += acc.counts.updated;
        console.info(JSON.stringify({ source: "shopee-product-sync", event: "product_synced", jobId: job.id, shopId: shop.id, items: chunk.length, created: acc.counts.created, updated: acc.counts.updated, failed: acc.failedItemIds.size }));
        progress.incr("detailsFetched", chunk.length - acc.failedItemIds.size);
        for (const f of acc.failures) progress.addFailure(f);
        for (const id of acc.failedItemIds) if (!acc.failures.some((f) => f.externalId === id)) progress.addFailure({ externalId: id, reason: "chi tiết sản phẩm lỗi" });
        cp.pendingItemIds = cp.pendingItemIds.slice(chunk.length);
        for (const id of chunk) delete cp.kitByItemId[id];
        if (await save()) return { kind: "cancelled" };
        continue;
      }

      if (cp.phase !== "discover") break;

      // ---- discovery: one get_item_list page
      if (!budget.canSpend(1)) return continuation(budget, "more_pages");
      if (cp.pages >= MAX_DISCOVERY_PAGES) {
        progress.addFailure({ externalId: null, reason: "v2.product.get_item_list: quá số trang cho phép" });
        cp.phase = "finalize";
        continue;
      }
      let page: Awaited<ReturnType<ShopeeProductSyncService["fetchItemListPage"]>>;
      try {
        page = await this.sync.fetchItemListPage(ctx, cp.offset, updateWindow);
      } catch (err) {
        if (errorInfo(err).code !== "provider_parse_error") throw err;
        return this.discoveryFailed(windowFrom, windowTo, errorInfo(err).message);
      }
      cp.pages++;
      progress.incr("pages");
      progress.counters.fetched += page.items.length;
      for (const issue of page.issues) progress.addFailure({ externalId: issue.externalId, reason: `${issue.apiName}: ${issue.reason}` });

      const locals = await this.loadLocalProducts(shop.id, page.items.map((i) => i.externalItemId));
      for (const item of page.items) {
        const decision = shouldRefreshProductDetail(locals.get(item.externalItemId) ?? null, { externalItemId: item.externalItemId, updateTime: item.updateTime }, {
          force: job.mode === "repair",
        });
        progress.incrIn("refreshReasons", decision.reason);
        if (decision.refresh) {
          if (!cp.pendingItemIds.includes(item.externalItemId)) {
            cp.pendingItemIds.push(item.externalItemId);
            cp.kitByItemId[item.externalItemId] = item.isKit;
          }
        } else {
          progress.incr("detailsSkippedUnchanged");
        }
      }

      if (!page.hasNextPage) {
        cp.phase = "finalize";
      } else if (page.nextOffset === null || page.nextOffset <= cp.offset) {
        return this.discoveryFailed(windowFrom, windowTo, `next_offset không hợp lệ (${page.nextOffset}) sau offset ${cp.offset}`);
      } else {
        cp.offset = page.nextOffset;
      }
      if (await save()) return { kind: "cancelled" };
    }

    // ---- finalize: mapping (DB only, also when partial — what synced is mappable)
    try {
      const mapped = await autoMapChannelModels(this.db, shop.id, now(), { cogsBudgetMs: 3_000 });
      await refreshMappingReviewFlags(this.db, shop.id);
      progress.incr("autoMapped", mapped.mapped);
      progress.meta.autoMap = { mapped: mapped.mapped, unmapped: mapped.unmapped, conflicts: mapped.conflicts };
    } catch (err) {
      progress.addFailure({ externalId: null, reason: `auto-map: ${errorInfo(err).message}` });
    }
    cp.phase = "done";

    const failureCount = progress.failureCount;
    const detailsOk = progress.stat("detailsFetched") > 0;
    const anyDetailWanted = progress.stat("detailsFetched") + failureCount > 0;
    const logStatus = failureCount === 0 ? "success" : detailsOk || !anyDetailWanted ? "partial" : "failed";
    const summary = firstFailureSummary(progress.failures, failureCount);
    return {
      kind: "done",
      logStatus,
      // Any complete scan (window or full) covers everything up to its start → next incremental starts there.
      advanceCheckpoint: logStatus === "success" && !scopeIds,
      windowFrom: windowFrom?.toISOString() ?? null,
      windowTo: windowTo?.toISOString() ?? null,
      errorCode: summary?.code ?? null,
      errorMessage: summary?.message ?? null,
    };
  }

  private discoveryFailed(windowFrom: Date | null, windowTo: Date | null, message: string): SliceOutcome {
    return {
      kind: "done",
      logStatus: "failed",
      advanceCheckpoint: false,
      windowFrom: windowFrom?.toISOString() ?? null,
      windowTo: windowTo?.toISOString() ?? null,
      errorCode: "provider_parse_error",
      errorMessage: message.slice(0, 500),
    };
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

  /** One query per page: stored update_time + unit count per listing. */
  private async loadLocalProducts(shopId: string, itemIds: string[]): Promise<Map<string, LocalProductState>> {
    const result = new Map<string, LocalProductState>();
    if (itemIds.length === 0) return result;
    const { data, error } = await this.db
      .from("channel_products")
      .select("external_item_id, source_updated_at, channel_product_models(count)")
      .eq("shop_id", shopId)
      .in("external_item_id", itemIds);
    if (error) throw new Error(`Không đọc được sản phẩm đã lưu: ${error.message}`);
    for (const r of (data ?? []) as Array<{ external_item_id: string; source_updated_at: string | null; channel_product_models: Array<{ count: number }> }>) {
      result.set(r.external_item_id, { sourceUpdatedAt: r.source_updated_at, modelCount: r.channel_product_models?.[0]?.count ?? 0 });
    }
    return result;
  }
}
