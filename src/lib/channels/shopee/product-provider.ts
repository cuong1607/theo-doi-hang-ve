// ============================================================
// PHASE SHOPEE-2: the product API port + its two implementations.
//
//   ShopeeProductProvider (port) ← the sync service depends ONLY on this
//     ├─ RealShopeeProductProvider    → SHOPEE-1 client + token service (HTTP)
//     └─ FixtureShopeeProductProvider → documented-example JSON (tests / local dev)
//
// Providers return the RAW provider JSON (+ request id). Parsing/mapping is
// the adapter's job (./product-adapter.ts), and raw payloads are what the
// latest-snapshot store keeps. A provider never decides business rules.
//
// Fixture mode is a different data SOURCE, never a silent fallback: the sync
// refuses to run a fixture provider against a live shop and vice versa.
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SourceMode } from "../core/types.ts";
import type { ShopeeClient } from "./client.ts";
import type { ShopeeItemStatus } from "./dto/product.ts";
import type { ShopeeTokenSource } from "./token.ts";
import { ShopeeApiError } from "./errors.ts";

export type ProviderMode = SourceMode;

export interface ProductProviderContext {
  /** Internal shops.id. */
  shopId: string;
  externalShopId: string;
}

export interface ListItemsInput {
  offset: number;
  pageSize: number;
  itemStatus: readonly ShopeeItemStatus[];
  /** Unix seconds. */
  updateTimeFrom?: number;
  updateTimeTo?: number;
}

export interface ProviderPayload {
  apiName: string;
  raw: unknown;
  requestId: string | null;
}

export interface ShopeeProductProvider {
  readonly mode: ProviderMode;
  listItems(ctx: ProductProviderContext, input: ListItemsInput): Promise<ProviderPayload>;
  getItemBaseInfo(ctx: ProductProviderContext, input: { itemIds: readonly string[] }): Promise<ProviderPayload>;
  getModelList(ctx: ProductProviderContext, input: { itemId: string }): Promise<ProviderPayload>;
}

export const PRODUCT_PATHS = {
  itemList: "/api/v2/product/get_item_list",
  baseInfo: "/api/v2/product/get_item_base_info",
  modelList: "/api/v2/product/get_model_list",
} as const;

/** Shopee limits (documented): get_item_list page_size ≤ 100, get_item_base_info ≤ 50 ids per call. */
export const ITEM_LIST_PAGE_SIZE = 100;
export const BASE_INFO_BATCH_SIZE = 50;

// ------------------------------------------------------------------ live

export class RealShopeeProductProvider implements ShopeeProductProvider {
  readonly mode = "live" as const;
  private readonly client: ShopeeClient;
  private readonly connections: ShopeeTokenSource;

  constructor(deps: { client: ShopeeClient; connections: ShopeeTokenSource }) {
    this.client = deps.client;
    this.connections = deps.connections;
  }

  private async call(
    ctx: ProductProviderContext,
    apiName: string,
    apiPath: string,
    query: Record<string, string | number | ReadonlyArray<string | number> | undefined>,
  ): Promise<ProviderPayload> {
    const accessToken = await this.connections.getValidAccessToken(ctx.shopId);
    try {
      const { data, requestId } = await this.client.request({
        path: apiPath,
        method: "GET",
        shop: { externalShopId: ctx.externalShopId, accessToken },
        query,
        logShopId: ctx.shopId,
      });
      return { apiName, raw: data, requestId };
    } catch (err) {
      if (err instanceof ShopeeApiError) await this.connections.recordApiFailure(ctx.shopId, err);
      throw err;
    }
  }

  listItems(ctx: ProductProviderContext, input: ListItemsInput) {
    return this.call(ctx, "v2.product.get_item_list", PRODUCT_PATHS.itemList, {
      offset: input.offset,
      page_size: Math.min(input.pageSize, ITEM_LIST_PAGE_SIZE),
      item_status: input.itemStatus,
      update_time_from: input.updateTimeFrom,
      update_time_to: input.updateTimeTo,
    });
  }

  getItemBaseInfo(ctx: ProductProviderContext, input: { itemIds: readonly string[] }) {
    // Comma-separated list — to be confirmed against the real API (docs checklist).
    return this.call(ctx, "v2.product.get_item_base_info", PRODUCT_PATHS.baseInfo, {
      item_id_list: input.itemIds.slice(0, BASE_INFO_BATCH_SIZE).join(","),
    });
  }

  getModelList(ctx: ProductProviderContext, input: { itemId: string }) {
    return this.call(ctx, "v2.product.get_model_list", PRODUCT_PATHS.modelList, { item_id: input.itemId });
  }
}

// --------------------------------------------------------------- fixture

/** Envelopes shaped like Shopee responses (see tests/fixtures/shopee/product). */
export interface ProductFixtureSet {
  /** get_item_list pages in order; page N+1 starts at page N's response.next_offset. */
  itemListPages: unknown[];
  /** One get_item_base_info envelope holding every item; filtered per request. */
  itemBaseInfo: unknown;
  /** get_model_list envelope per item id. */
  modelLists: Record<string, unknown>;
}

export type FixtureCallHook = (call: { apiName: string; input: unknown }) => void | Promise<void>;

function fixtureRequestId(): string {
  return `fixture-${Math.random().toString(16).slice(2, 10)}`;
}

function idOf(entry: unknown, key: string): string | null {
  if (entry && typeof entry === "object" && key in entry) {
    const value = (entry as Record<string, unknown>)[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  }
  return null;
}

export class FixtureShopeeProductProvider implements ShopeeProductProvider {
  readonly mode = "fixture" as const;
  private readonly fixtures: ProductFixtureSet;
  private readonly onCall?: FixtureCallHook;

  constructor(fixtures: ProductFixtureSet, options: { onCall?: FixtureCallHook } = {}) {
    this.fixtures = fixtures;
    this.onCall = options.onCall;
  }

  async listItems(_ctx: ProductProviderContext, input: ListItemsInput): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.product.get_item_list", input });
    let start = 0;
    for (const page of this.fixtures.itemListPages) {
      if (start === input.offset) return { apiName: "v2.product.get_item_list", raw: page, requestId: fixtureRequestId() };
      const next = (page as { response?: { next_offset?: unknown } })?.response?.next_offset;
      if (typeof next !== "number") break;
      start = next;
    }
    return {
      apiName: "v2.product.get_item_list",
      raw: { error: "", message: "", request_id: fixtureRequestId(), response: { item: [], total_count: 0, has_next_page: false, next_offset: input.offset } },
      requestId: null,
    };
  }

  async getItemBaseInfo(_ctx: ProductProviderContext, input: { itemIds: readonly string[] }): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.product.get_item_base_info", input });
    const wanted = new Set(input.itemIds);
    const source = this.fixtures.itemBaseInfo as { response?: { item_list?: unknown[] } } & Record<string, unknown>;
    const itemList = (source.response?.item_list ?? []).filter((entry) => wanted.has(idOf(entry, "item_id") ?? ""));
    return {
      apiName: "v2.product.get_item_base_info",
      raw: { ...source, request_id: fixtureRequestId(), response: { ...(source.response ?? {}), item_list: itemList } },
      requestId: null,
    };
  }

  async getModelList(_ctx: ProductProviderContext, input: { itemId: string }): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.product.get_model_list", input });
    const raw = this.fixtures.modelLists[input.itemId] ?? {
      error: "error_item_not_found",
      message: `fixture: no model list for item ${input.itemId}`,
      request_id: fixtureRequestId(),
    };
    return { apiName: "v2.product.get_model_list", raw, requestId: null };
  }
}

/** Default fixture directory (dev/test only — never bundled for production use). */
export const DEFAULT_PRODUCT_FIXTURE_DIR = path.join("tests", "fixtures", "shopee", "product");

export function loadProductFixtures(dir: string = path.join(process.cwd(), DEFAULT_PRODUCT_FIXTURE_DIR)): ProductFixtureSet {
  const readJson = (file: string): unknown => JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const pages = readdirSync(dir)
    .filter((f) => /^get-item-list\.page-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map(readJson);
  const modelDir = path.join(dir, "get-model-list");
  const modelLists: Record<string, unknown> = {};
  for (const file of readdirSync(modelDir).filter((f) => f.endsWith(".json"))) {
    modelLists[file.replace(/\.json$/, "")] = JSON.parse(readFileSync(path.join(modelDir, file), "utf8"));
  }
  return { itemListPages: pages, itemBaseInfo: readJson("get-item-base-info.json"), modelLists };
}
