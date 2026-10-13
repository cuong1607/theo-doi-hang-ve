// ============================================================
// PHASE SHOPEE-2: Shopee product sync orchestration.
//
// ONE implementation for both data sources — it depends on the
// ShopeeProductProvider port (live HTTP or fixtures), the payload adapter,
// and channel-agnostic persistence/mapping. Flow:
//
//   1. guard: shop exists, is a Shopee shop, its data_source == provider mode
//      (fixture data can never land in a live shop and vice versa), no other
//      product sync running for it
//   2. discovery: get_item_list pages (offset / has_next_page / next_offset),
//      ALL statuses (NORMAL, UNLIST, REVIEWING, BANNED, SELLER_DELETE,
//      SHOPEE_DELETE) so delisted/deleted items update locally
//   3. details in batches of 50: get_item_base_info → channel_products
//   4. per item: has_model → get_model_list → channel_product_models;
//      no model → one synthetic NO_MODEL unit
//   5. latest-only raw snapshots (product/model)
//   6. auto-map exact SKUs + refresh review flags
//   7. sync state + log
//
// Partial failure: a failing batch/item is recorded (id + reason) and the
// run continues → status 'partial'. Only a fully successful run advances
// last_success_at (the incremental checkpoint), so the next incremental run
// re-covers whatever failed. Discovery failure → 'failed', nothing advanced.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { upsertChannelModels, upsertChannelProducts } from "../core/product-catalog.ts";
import { autoMapChannelModels, refreshMappingReviewFlags, type AutoMapResult } from "../core/sku-mapping.ts";
import { saveLatestChannelSnapshot } from "../core/snapshots.ts";
import { finishSyncLog, getSyncState, hasRunningSync, saveSyncState, startSyncLog, type SyncCounts } from "../core/sync-log.ts";
import type { SyncLogStatus } from "../core/types.ts";
import { consoleShopeeLogger, type ShopeeLogger } from "./client.ts";
import { SHOPEE_ITEM_STATUSES } from "./dto/product.ts";
import { ShopeeApiError } from "./errors.ts";
import { parseItemBaseInfo, parseItemListPage, parseModelList, ShopeePayloadError, syntheticModelFor, type ParseIssue } from "./product-adapter.ts";
import { BASE_INFO_BATCH_SIZE, ITEM_LIST_PAGE_SIZE, type ProductProviderContext, type ShopeeProductProvider } from "./product-provider.ts";

export const PRODUCT_SYNC_TYPE = "product";
/** Incremental runs start this long before the last successful run (boundary safety). */
export const PRODUCT_SYNC_OVERLAP_SECONDS = 5 * 60;
const MAX_DISCOVERY_PAGES = 1000;
const MAX_FAILURES_IN_LOG = 50;

export interface ProductSyncOptions {
  mode?: "full" | "incremental";
  overlapSeconds?: number;
}

export interface ProductSyncResult {
  ok: boolean;
  status: Exclude<SyncLogStatus, "running">;
  logId: string | null;
  counts: SyncCounts;
  pagesFetched: number;
  itemsDiscovered: number;
  modelsFetched: number;
  autoMap: AutoMapResult | null;
  failures: Array<{ externalId: string | null; reason: string }>;
  errorCode?: string;
  errorMessage?: string;
}

export class ProductSyncRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProductSyncRefusedError";
    this.code = code;
  }
}

function errorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof ShopeeApiError) return { code: err.errorCode, message: `${err.message}${err.requestId ? ` (request_id: ${err.requestId})` : ""}` };
  if (err instanceof ShopeePayloadError) return { code: "provider_parse_error", message: err.message };
  if (err instanceof Error) return { code: "sync_error", message: err.message.slice(0, 300) };
  return { code: "sync_error", message: "Lỗi không xác định." };
}

export class ShopeeProductSyncService {
  private readonly db: SupabaseClient;
  private readonly provider: ShopeeProductProvider;
  private readonly now: () => Date;
  private readonly log: ShopeeLogger;

  constructor(deps: { db: SupabaseClient; provider: ShopeeProductProvider; now?: () => Date; logger?: ShopeeLogger }) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.logger ?? consoleShopeeLogger;
  }

  /** Throws ProductSyncRefusedError when the run must not start (nothing is written then). */
  async sync(shopId: string, options: ProductSyncOptions = {}): Promise<ProductSyncResult> {
    const { data: shop } = await this.db
      .from("shops")
      .select("id, channel, external_shop_id, data_source, currency, is_active")
      .eq("id", shopId)
      .maybeSingle<{ id: string; channel: string; external_shop_id: string; data_source: string; currency: string | null; is_active: boolean }>();
    if (!shop) throw new ProductSyncRefusedError("shop_not_found", "Không tìm thấy shop.");
    if (shop.channel !== "shopee") throw new ProductSyncRefusedError("not_shopee", "Shop không thuộc kênh Shopee.");
    if (shop.data_source !== this.provider.mode) {
      throw new ProductSyncRefusedError(
        "source_mismatch",
        shop.data_source === "fixture"
          ? "Shop fixture chỉ được đồng bộ bằng fixture provider."
          : "Không được đồng bộ dữ liệu fixture vào shop thật.",
      );
    }
    const startedAt = this.now();
    if (await hasRunningSync(this.db, shopId, PRODUCT_SYNC_TYPE, startedAt)) {
      throw new ProductSyncRefusedError("sync_running", "Đang có một lượt đồng bộ sản phẩm khác cho shop này.");
    }

    const ctx: ProductProviderContext = { shopId, externalShopId: shop.external_shop_id };
    const startedIso = startedAt.toISOString();
    const state = await getSyncState(this.db, shopId, PRODUCT_SYNC_TYPE);
    const incremental = options.mode === "incremental" && state?.last_success_at;
    const overlap = options.overlapSeconds ?? PRODUCT_SYNC_OVERLAP_SECONDS;
    const windowFrom = incremental ? new Date(new Date(state!.last_success_at!).getTime() - overlap * 1000) : null;
    const windowTo = incremental ? startedAt : null;

    const logId = await startSyncLog(this.db, shopId, PRODUCT_SYNC_TYPE, startedIso, {
      sourceMode: this.provider.mode,
      syncMode: incremental ? "incremental" : "full",
      windowFrom: windowFrom?.toISOString() ?? null,
      windowTo: windowTo?.toISOString() ?? null,
    });

    const counts: SyncCounts = { fetched: 0, created: 0, updated: 0, failed: 0 };
    const failures: Array<{ externalId: string | null; reason: string }> = [];
    const addIssues = (issues: ParseIssue[]) => issues.forEach((i) => failures.push({ externalId: i.externalId, reason: `${i.apiName}: ${i.reason}` }));
    let pagesFetched = 0;
    let modelsFetched = 0;
    let lastOffset = 0;
    let autoMap: AutoMapResult | null = null;
    const failedItemIds = new Set<string>();

    const finish = async (status: Exclude<SyncLogStatus, "running">, fatal?: { code: string; message: string }): Promise<ProductSyncResult> => {
      counts.failed = failedItemIds.size + failures.filter((f) => !f.externalId || !failedItemIds.has(f.externalId)).length;
      const completedIso = this.now().toISOString();
      const firstFailure = fatal ?? (failures[0] ? { code: "partial_failure", message: `${failures.length} lỗi; đầu tiên: ${failures[0].reason}` } : null);
      await finishSyncLog(this.db, logId, {
        status,
        completedAt: completedIso,
        counts,
        errorCode: firstFailure?.code ?? null,
        errorMessage: firstFailure?.message ?? null,
        metadata: {
          sourceMode: this.provider.mode,
          syncMode: incremental ? "incremental" : "full",
          windowFrom: windowFrom?.toISOString() ?? null,
          windowTo: windowTo?.toISOString() ?? null,
          pagesFetched,
          itemsDiscovered: counts.fetched,
          modelsFetched,
          autoMapped: autoMap?.mapped ?? 0,
          unmapped: autoMap?.unmapped ?? 0,
          conflicts: autoMap?.conflicts ?? 0,
          failures: failures.slice(0, MAX_FAILURES_IN_LOG),
        },
      });
      await saveSyncState(this.db, shopId, PRODUCT_SYNC_TYPE, {
        last_offset: lastOffset,
        last_window_from: windowFrom?.toISOString() ?? null,
        last_window_to: windowTo?.toISOString() ?? null,
        ...(status === "success"
          ? { last_success_at: startedIso, last_error_code: null, last_error_message: null }
          : { last_failure_at: completedIso, last_error_code: firstFailure?.code ?? null, last_error_message: firstFailure?.message ?? null }),
      });
      this.log({ event: "SHOPEE_PRODUCT_SYNC", ok: status === "success", shopId, detail: `${status} fetched=${counts.fetched} failed=${counts.failed}` });
      return {
        ok: status === "success",
        status,
        logId,
        counts,
        pagesFetched,
        itemsDiscovered: counts.fetched,
        modelsFetched,
        autoMap,
        failures,
        errorCode: firstFailure?.code,
        errorMessage: firstFailure?.message,
      };
    };

    // ---- 2. discovery
    const discovered = new Map<string, { isKit: boolean | null }>();
    try {
      let offset = 0;
      for (;;) {
        if (pagesFetched >= MAX_DISCOVERY_PAGES) throw new ShopeePayloadError("v2.product.get_item_list", "quá số trang cho phép");
        const payload = await this.provider.listItems(ctx, {
          offset,
          pageSize: ITEM_LIST_PAGE_SIZE,
          itemStatus: SHOPEE_ITEM_STATUSES,
          updateTimeFrom: windowFrom ? Math.floor(windowFrom.getTime() / 1000) : undefined,
          updateTimeTo: windowTo ? Math.floor(windowTo.getTime() / 1000) : undefined,
        });
        const page = parseItemListPage(payload.raw);
        pagesFetched++;
        lastOffset = offset;
        addIssues(page.issues);
        for (const item of page.items) discovered.set(item.externalItemId, { isKit: item.isKit });
        if (!page.hasNextPage) break;
        if (page.nextOffset === null || page.nextOffset <= offset) {
          throw new ShopeePayloadError("v2.product.get_item_list", `next_offset không hợp lệ (${page.nextOffset}) sau offset ${offset}`);
        }
        offset = page.nextOffset;
      }
    } catch (err) {
      return finish("failed", errorInfo(err));
    }
    counts.fetched = discovered.size;

    try {
      return await this.syncDetails({ shopId, ctx, currency: shop.currency, discovered, counts, failures, failedItemIds, addIssues, finish, setModels: (n) => (modelsFetched += n), setAutoMap: (r) => (autoMap = r) });
    } catch (err) {
      return finish("failed", errorInfo(err));
    }
  }

  private async syncDetails(s: {
    shopId: string;
    ctx: ProductProviderContext;
    currency: string | null;
    discovered: Map<string, { isKit: boolean | null }>;
    counts: SyncCounts;
    failures: Array<{ externalId: string | null; reason: string }>;
    failedItemIds: Set<string>;
    addIssues: (issues: ParseIssue[]) => void;
    finish: (status: Exclude<SyncLogStatus, "running">, fatal?: { code: string; message: string }) => Promise<ProductSyncResult>;
    setModels: (n: number) => void;
    setAutoMap: (r: AutoMapResult) => void;
  }): Promise<ProductSyncResult> {
    const { shopId, ctx, discovered, failures, finish } = s;

    // ---- 3–5. details, models, snapshots
    const itemIds = [...discovered.keys()];
    const kitByItemId = new Map([...discovered].map(([id, v]) => [id, v.isKit]));
    const anyItemSucceeded = await this.storeItems(shopId, ctx, s.currency, itemIds, kitByItemId, s);

    // ---- 6. mapping (also when partial: what did sync is mappable)
    try {
      s.setAutoMap(await autoMapChannelModels(this.db, shopId, this.now()));
      await refreshMappingReviewFlags(this.db, shopId);
    } catch (err) {
      failures.push({ externalId: null, reason: `auto-map: ${errorInfo(err).message}` });
    }

    if (failures.length === 0) return finish("success");
    return finish(anyItemSucceeded || itemIds.length === 0 ? "partial" : "failed");
  }

  /**
   * Fetch + store specific listings (no discovery, no sync log) — used by
   * order sync when an order references an item not in the catalog yet.
   * Same data-source guard as sync(); runs auto-map afterwards.
   */
  async ensureItems(shopId: string, externalItemIds: string[]): Promise<{ failures: Array<{ externalId: string | null; reason: string }> }> {
    const ids = [...new Set(externalItemIds)];
    if (ids.length === 0) return { failures: [] };
    const { data: shop } = await this.db
      .from("shops")
      .select("id, channel, external_shop_id, data_source, currency")
      .eq("id", shopId)
      .maybeSingle<{ id: string; channel: string; external_shop_id: string; data_source: string; currency: string | null }>();
    if (!shop || shop.channel !== "shopee" || shop.data_source !== this.provider.mode) {
      return { failures: ids.map((id) => ({ externalId: id, reason: "ensureItems: shop không hợp lệ cho provider này" })) };
    }
    const acc = {
      counts: { fetched: ids.length, created: 0, updated: 0, failed: 0 },
      failures: [] as Array<{ externalId: string | null; reason: string }>,
      failedItemIds: new Set<string>(),
      addIssues(issues: ParseIssue[]) {
        issues.forEach((i) => acc.failures.push({ externalId: i.externalId, reason: `${i.apiName}: ${i.reason}` }));
      },
      setModels() {},
    };
    await this.storeItems(shopId, { shopId, externalShopId: shop.external_shop_id }, shop.currency, ids, new Map(), acc);
    await autoMapChannelModels(this.db, shopId, this.now());
    return { failures: acc.failures };
  }

  private async storeItems(
    shopId: string,
    ctx: ProductProviderContext,
    currency: string | null,
    itemIds: string[],
    kitByItemId: Map<string, boolean | null>,
    s: {
      counts: SyncCounts;
      failures: Array<{ externalId: string | null; reason: string }>;
      failedItemIds: Set<string>;
      addIssues: (issues: ParseIssue[]) => void;
      setModels: (n: number) => void;
    },
  ): Promise<boolean> {
    const { counts, failures, failedItemIds, addIssues } = s;
    const shop = { currency };
    let anyItemSucceeded = false;

    for (let i = 0; i < itemIds.length; i += BASE_INFO_BATCH_SIZE) {
      const batch = itemIds.slice(i, i + BASE_INFO_BATCH_SIZE);
      const syncedIso = this.now().toISOString();
      let parsed: ReturnType<typeof parseItemBaseInfo>;
      try {
        const payload = await this.provider.getItemBaseInfo(ctx, { itemIds: batch });
        parsed = parseItemBaseInfo(payload.raw, { currency: shop.currency, kitByItemId });
      } catch (err) {
        const { code, message } = errorInfo(err);
        for (const id of batch) {
          failedItemIds.add(id);
          failures.push({ externalId: id, reason: `get_item_base_info [${code}] ${message}` });
        }
        continue;
      }
      addIssues(parsed.issues);
      parsed.issues.forEach((issue) => issue.externalId && failedItemIds.add(issue.externalId));
      const returned = new Set(parsed.products.map((p) => p.externalItemId));
      for (const id of batch) {
        if (!returned.has(id) && !failedItemIds.has(id)) {
          failedItemIds.add(id);
          failures.push({ externalId: id, reason: "get_item_base_info: item không có trong phản hồi" });
        }
      }

      let idByExternalId: Map<string, string>;
      try {
        const upserted = await upsertChannelProducts(this.db, shopId, parsed.products, syncedIso);
        idByExternalId = upserted.idByExternalId;
        counts.created += upserted.counts.created;
        counts.updated += upserted.counts.updated;
      } catch (err) {
        const { message } = errorInfo(err);
        for (const p of parsed.products) {
          failedItemIds.add(p.externalItemId);
          failures.push({ externalId: p.externalItemId, reason: `lưu channel_products: ${message}` });
        }
        continue;
      }

      for (const product of parsed.products) {
        const channelProductId = idByExternalId.get(product.externalItemId);
        if (!channelProductId) continue;
        try {
          await saveLatestChannelSnapshot(this.db, {
            shopId,
            entityType: "product",
            entityExternalId: product.externalItemId,
            apiName: "v2.product.get_item_base_info",
            payload: parsed.rawByItemId.get(product.externalItemId) ?? null,
            sourceMode: this.provider.mode,
            sourceUpdatedAt: product.sourceUpdatedAt,
            syncedAt: syncedIso,
          });

          if (product.hasModel) {
            const payload = await this.provider.getModelList(ctx, { itemId: product.externalItemId });
            const models = parseModelList(payload.raw, { currency: shop.currency });
            s.setModels(models.models.length);
            addIssues(models.issues);
            const res = await upsertChannelModels(this.db, channelProductId, models.models, syncedIso, { complete: models.issues.length === 0 });
            counts.created += res.created;
            counts.updated += res.updated;
            await saveLatestChannelSnapshot(this.db, {
              shopId,
              entityType: "model",
              entityExternalId: product.externalItemId,
              apiName: "v2.product.get_model_list",
              payload: payload.raw,
              sourceMode: this.provider.mode,
              sourceUpdatedAt: product.sourceUpdatedAt,
              syncedAt: syncedIso,
            });
            if (models.issues.length > 0) failedItemIds.add(product.externalItemId);
          } else {
            const res = await upsertChannelModels(
              this.db,
              channelProductId,
              [syntheticModelFor(product, parsed.rawByItemId.get(product.externalItemId))],
              syncedIso,
              { complete: true },
            );
            counts.created += res.created;
            counts.updated += res.updated;
          }
          anyItemSucceeded = true;
        } catch (err) {
          const { code, message } = errorInfo(err);
          failedItemIds.add(product.externalItemId);
          failures.push({ externalId: product.externalItemId, reason: `get_model_list/lưu model [${code}] ${message}` });
        }
      }
    }
    return anyItemSucceeded;
  }
}
