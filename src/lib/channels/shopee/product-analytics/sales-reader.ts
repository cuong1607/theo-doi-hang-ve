// ============================================================
// PRODUCT-ANALYTICS-2: isolated READ-ONLY reader for the product analytics
// jobs. NOT the legacy order provider: own minimal request fields, own
// allowlist (PRODUCT_SALES_READ_ENDPOINTS), GET only, asserted before every
// call. Transport / signing / retry come from the shared ShopeeClient.
//
// get_order_detail optional fields: item_list + pay_time ONLY. No buyer,
// recipient, note or package field is requested. (The endpoint still returns
// a few base fields such as message_to_seller — the fact projection drops
// them; nothing raw is stored.)
// ============================================================
import type { ShopeeClient } from "../client.ts";
import { ShopeeApiError } from "../errors.ts";
import type { ShopeeTokenSource } from "../token.ts";

import { assertProductSalesReadRequest, PRODUCT_SALES_READ_ENDPOINTS } from "./read-only-policy.ts";

export interface ProductSalesContext {
  shopId: string;
  externalShopId: string;
}

export interface ListOrdersRequest {
  timeRangeField: "create_time" | "update_time";
  timeFrom: number;
  timeTo: number;
  cursor: string;
}

export interface ProductSalesReader {
  readonly mode: "live" | "fixture";
  listOrders(ctx: ProductSalesContext, input: ListOrdersRequest): Promise<unknown>;
  getOrderDetails(ctx: ProductSalesContext, orderSns: readonly string[]): Promise<unknown>;
  getItemExtraInfo(ctx: ProductSalesContext, itemIds: readonly string[]): Promise<unknown>;
}

/** Documented: get_order_list ≤ 15 days per request, page_size ≤ 100; detail ≤ 50 order_sn. */
export const PRODUCT_SALES_MAX_WINDOW_SECONDS = 15 * 24 * 60 * 60;
export const PRODUCT_SALES_PAGE_SIZE = 100;
export const PRODUCT_SALES_DETAIL_BATCH = 50;
export const PRODUCT_EXTRA_INFO_BATCH = 50;
export const PRODUCT_SALES_DETAIL_FIELDS = "item_list,pay_time";

export const PRODUCT_SALES_API = {
  list: "v2.order.get_order_list",
  detail: "v2.order.get_order_detail",
  extraInfo: "v2.product.get_item_extra_info",
} as const;

export class RealProductSalesReader implements ProductSalesReader {
  readonly mode = "live" as const;
  private readonly client: ShopeeClient;
  private readonly connections: ShopeeTokenSource;

  constructor(deps: { client: ShopeeClient; connections: ShopeeTokenSource }) {
    this.client = deps.client;
    this.connections = deps.connections;
  }

  private async get(ctx: ProductSalesContext, path: string, query: Record<string, string | number | ReadonlyArray<string | number>>): Promise<unknown> {
    assertProductSalesReadRequest("GET", path);
    const accessToken = await this.connections.getValidAccessToken(ctx.shopId);
    try {
      const { data } = await this.client.request({ path, method: "GET", shop: { externalShopId: ctx.externalShopId, accessToken }, query, logShopId: ctx.shopId });
      return data;
    } catch (err) {
      if (err instanceof ShopeeApiError) await this.connections.recordApiFailure(ctx.shopId, err);
      throw err;
    }
  }

  listOrders(ctx: ProductSalesContext, input: ListOrdersRequest) {
    return this.get(ctx, PRODUCT_SALES_READ_ENDPOINTS.order_list, {
      time_range_field: input.timeRangeField,
      time_from: input.timeFrom,
      time_to: input.timeTo,
      page_size: PRODUCT_SALES_PAGE_SIZE,
      cursor: input.cursor,
    });
  }

  getOrderDetails(ctx: ProductSalesContext, orderSns: readonly string[]) {
    return this.get(ctx, PRODUCT_SALES_READ_ENDPOINTS.order_detail, {
      order_sn_list: orderSns.slice(0, PRODUCT_SALES_DETAIL_BATCH).join(","),
      response_optional_fields: PRODUCT_SALES_DETAIL_FIELDS,
    });
  }

  getItemExtraInfo(ctx: ProductSalesContext, itemIds: readonly string[]) {
    return this.get(ctx, PRODUCT_SALES_READ_ENDPOINTS.item_extra_info, { item_id_list: itemIds.slice(0, PRODUCT_EXTRA_INFO_BATCH).join(",") });
  }
}

/** Counts provider calls on the slice budget / meter (same contract as the Ads provider wrapper). */
export class MeteredProductSalesReader implements ProductSalesReader {
  readonly mode: "live" | "fixture";
  private readonly inner: ProductSalesReader;
  private readonly meter: { track<T>(apiName: string, fn: () => Promise<T>): Promise<T> };

  constructor(inner: ProductSalesReader, meter: { track<T>(apiName: string, fn: () => Promise<T>): Promise<T> }) {
    this.inner = inner;
    this.meter = meter;
    this.mode = inner.mode;
  }

  listOrders(ctx: ProductSalesContext, input: ListOrdersRequest) {
    return this.meter.track(PRODUCT_SALES_API.list, () => this.inner.listOrders(ctx, input));
  }

  getOrderDetails(ctx: ProductSalesContext, orderSns: readonly string[]) {
    return this.meter.track(PRODUCT_SALES_API.detail, () => this.inner.getOrderDetails(ctx, orderSns));
  }

  getItemExtraInfo(ctx: ProductSalesContext, itemIds: readonly string[]) {
    return this.meter.track(PRODUCT_SALES_API.extraInfo, () => this.inner.getItemExtraInfo(ctx, itemIds));
  }
}

// --------------------------------------------------------------- fixture (tests / local dev)

export interface ProductSalesFixtureData {
  /** Raw order objects (get_order_detail shape), by order_sn. */
  orders: Map<string, Record<string, unknown>>;
  /** Raw extra-info entries by item id. */
  extraInfo?: Map<string, Record<string, unknown>>;
  pageSize?: number;
}

export type ProductSalesFixtureCall = { api: string; input: unknown };

/** Lists orders whose create_time / update_time falls inside the window (cursor = offset), like Shopee. */
export class FixtureProductSalesReader implements ProductSalesReader {
  readonly mode = "fixture" as const;
  readonly calls: ProductSalesFixtureCall[] = [];
  private readonly data: ProductSalesFixtureData;
  private readonly fail?: (call: ProductSalesFixtureCall) => Error | null;

  constructor(data: ProductSalesFixtureData, options: { fail?: (call: ProductSalesFixtureCall) => Error | null } = {}) {
    this.data = data;
    this.fail = options.fail;
  }

  private record(api: string, input: unknown) {
    const call = { api, input };
    this.calls.push(call);
    const err = this.fail?.(call);
    if (err) throw err;
  }

  async listOrders(_ctx: ProductSalesContext, input: ListOrdersRequest): Promise<unknown> {
    this.record(PRODUCT_SALES_API.list, input);
    const size = this.data.pageSize ?? PRODUCT_SALES_PAGE_SIZE;
    const all = [...this.data.orders.values()]
      .filter((o) => {
        const t = Number(o[input.timeRangeField]);
        return t >= input.timeFrom && t <= input.timeTo;
      })
      .sort((a, b) => String(a.order_sn).localeCompare(String(b.order_sn)));
    const offset = Number(input.cursor || 0);
    const page = all.slice(offset, offset + size);
    const more = offset + size < all.length;
    return { error: "", message: "", request_id: "fixture", response: { more, next_cursor: more ? String(offset + size) : "", order_list: page.map((o) => ({ order_sn: o.order_sn })) } };
  }

  async getOrderDetails(_ctx: ProductSalesContext, orderSns: readonly string[]): Promise<unknown> {
    this.record(PRODUCT_SALES_API.detail, orderSns);
    return { error: "", message: "", request_id: "fixture", response: { order_list: orderSns.map((sn) => this.data.orders.get(sn)).filter(Boolean) } };
  }

  async getItemExtraInfo(_ctx: ProductSalesContext, itemIds: readonly string[]): Promise<unknown> {
    this.record(PRODUCT_SALES_API.extraInfo, itemIds);
    return { error: "", message: "", warning: "", request_id: "fixture", response: { item_list: itemIds.map((id) => this.data.extraInfo?.get(id)).filter(Boolean) } };
  }
}
