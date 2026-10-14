// ============================================================
// PHASE SHOPEE-3: order API port + implementations (same pattern as
// product-provider.ts). The sync service depends only on ShopeeOrderProvider.
// Providers return RAW provider JSON; parsing is order-adapter.ts's job.
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ShopeeClient } from "./client.ts";
import { ShopeeApiError } from "./errors.ts";
import type { ProductProviderContext, ProviderMode, ProviderPayload } from "./product-provider.ts";
import type { ShopeeTokenSource } from "./token.ts";

export type OrderProviderContext = ProductProviderContext;

export interface ListOrdersInput {
  timeRangeField: "create_time" | "update_time";
  /** Unix seconds; to − from must be ≤ MAX_ORDER_WINDOW_SECONDS. */
  timeFrom: number;
  timeTo: number;
  pageSize: number;
  cursor: string;
}

export interface ShopeeOrderProvider {
  readonly mode: ProviderMode;
  listOrders(ctx: OrderProviderContext, input: ListOrdersInput): Promise<ProviderPayload>;
  getOrderDetails(ctx: OrderProviderContext, input: { orderSns: readonly string[] }): Promise<ProviderPayload>;
}

export const ORDER_PATHS = {
  list: "/api/v2/order/get_order_list",
  detail: "/api/v2/order/get_order_detail",
} as const;

/** Documented: get_order_list range ≤ 15 days, page_size ≤ 100. */
export const MAX_ORDER_WINDOW_SECONDS = 15 * 24 * 60 * 60;
export const ORDER_LIST_PAGE_SIZE = 100;
/** get_order_detail order_sn_list limit — documented as 50; UNVERIFIED (docs checklist). */
export const ORDER_DETAIL_BATCH_SIZE = 50;

/**
 * Detail fields requested. Deliberately EXCLUDES recipient_address, buyer
 * identity, phone, notes: not needed for Financial Core → never fetched,
 * never stored (also absent from raw snapshots).
 */
export const ORDER_DETAIL_OPTIONAL_FIELDS = [
  "item_list",
  "pay_time",
  "pickup_done_time",
  "package_list",
  "shipping_carrier",
  "payment_method",
  "total_amount",
  "estimated_shipping_fee",
  "reverse_shipping_fee",
  "fulfillment_flag",
] as const;

export class RealShopeeOrderProvider implements ShopeeOrderProvider {
  readonly mode = "live" as const;
  private readonly client: ShopeeClient;
  private readonly connections: ShopeeTokenSource;

  constructor(deps: { client: ShopeeClient; connections: ShopeeTokenSource }) {
    this.client = deps.client;
    this.connections = deps.connections;
  }

  private async call(ctx: OrderProviderContext, apiName: string, apiPath: string, query: Record<string, string | number>): Promise<ProviderPayload> {
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

  listOrders(ctx: OrderProviderContext, input: ListOrdersInput) {
    return this.call(ctx, "v2.order.get_order_list", ORDER_PATHS.list, {
      time_range_field: input.timeRangeField,
      time_from: input.timeFrom,
      time_to: input.timeTo,
      page_size: Math.min(input.pageSize, ORDER_LIST_PAGE_SIZE),
      cursor: input.cursor,
      response_optional_fields: "order_status",
    });
  }

  getOrderDetails(ctx: OrderProviderContext, input: { orderSns: readonly string[] }) {
    return this.call(ctx, "v2.order.get_order_detail", ORDER_PATHS.detail, {
      order_sn_list: input.orderSns.slice(0, ORDER_DETAIL_BATCH_SIZE).join(","),
      response_optional_fields: ORDER_DETAIL_OPTIONAL_FIELDS.join(","),
    });
  }
}

// --------------------------------------------------------------- fixture

export interface OrderFixtureSet {
  /** get_order_list pages; page 1 answers cursor "", page N+1 answers page N's next_cursor. */
  listPages: unknown[];
  /** Raw order objects (as inside get_order_detail response.order_list), by order_sn. */
  ordersBySn: Map<string, unknown>;
}

export type FixtureOrderCallHook = (call: { apiName: string; input: unknown }) => void | Promise<void>;

function fixtureRequestId() {
  return `fixture-${Math.random().toString(16).slice(2, 10)}`;
}

function field(entry: unknown, key: string): unknown {
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>)[key] : undefined;
}

export class FixtureShopeeOrderProvider implements ShopeeOrderProvider {
  readonly mode = "fixture" as const;
  private readonly fixtures: OrderFixtureSet;
  private readonly onCall?: FixtureOrderCallHook;
  private readonly filterByTime: boolean;

  /**
   * filterByTime=false (default, local dev): every window returns the fixture
   * pages, so fixtures work whatever "now" is — the sync dedupes order_sn.
   * filterByTime=true (tests): only orders whose update_time/create_time lies
   * in the requested window are listed, to exercise multi-window behaviour.
   */
  constructor(fixtures: OrderFixtureSet, options: { onCall?: FixtureOrderCallHook; filterByTime?: boolean } = {}) {
    this.fixtures = fixtures;
    this.onCall = options.onCall;
    this.filterByTime = options.filterByTime ?? false;
  }

  async listOrders(_ctx: OrderProviderContext, input: ListOrdersInput): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.order.get_order_list", input });
    let cursor = "";
    for (const page of this.fixtures.listPages) {
      if (cursor === input.cursor) {
        const response = (field(page, "response") ?? {}) as Record<string, unknown>;
        let list = (response.order_list as unknown[] | undefined) ?? [];
        if (this.filterByTime) {
          list = list.filter((entry) => {
            const order = this.fixtures.ordersBySn.get(String(field(entry, "order_sn")));
            const t = Number(field(order, input.timeRangeField));
            return Number.isFinite(t) && t >= input.timeFrom && t <= input.timeTo;
          });
        }
        return { apiName: "v2.order.get_order_list", raw: { ...(page as object), request_id: fixtureRequestId(), response: { ...response, order_list: list } }, requestId: null };
      }
      const next = field(field(page, "response"), "next_cursor");
      if (typeof next !== "string" || !next) break;
      cursor = next;
    }
    return {
      apiName: "v2.order.get_order_list",
      raw: { error: "", message: "", request_id: fixtureRequestId(), response: { more: false, next_cursor: "", order_list: [] } },
      requestId: null,
    };
  }

  async getOrderDetails(_ctx: OrderProviderContext, input: { orderSns: readonly string[] }): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.order.get_order_detail", input });
    const orderList = input.orderSns.map((sn) => this.fixtures.ordersBySn.get(sn)).filter((o) => o !== undefined);
    return {
      apiName: "v2.order.get_order_detail",
      raw: { error: "", message: "", request_id: fixtureRequestId(), response: { order_list: orderList } },
      requestId: null,
    };
  }
}

export const DEFAULT_ORDER_FIXTURE_DIR = path.join("tests", "fixtures", "shopee", "order");

export function loadOrderFixtures(dir: string = path.join(process.cwd(), DEFAULT_ORDER_FIXTURE_DIR)): OrderFixtureSet {
  const read = (f: string): unknown => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const files = readdirSync(dir);
  const listPages = files
    .filter((f) => /^get-order-list-page-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map(read);
  const ordersBySn = new Map<string, unknown>();
  for (const f of files.filter((name) => /^get-order-detail-.+\.json$/.test(name))) {
    const list = (field(field(read(f), "response"), "order_list") as unknown[] | undefined) ?? [];
    for (const order of list) ordersBySn.set(String(field(order, "order_sn")), order);
  }
  return { listPages, ordersBySn };
}
