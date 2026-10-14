// ============================================================
// PHASE SHOPEE-PERF-1: per-job provider instrumentation.
//
//   ApiCallMeter      counts every provider call by api name (+ rate-limit
//                     hits) and charges the job slice's ExecutionBudget —
//                     the numbers land in channel_sync_jobs.metadata.apiCalls
//   meter*Provider    decorators: the sync code is unchanged, the provider
//                     it talks to counts
//   JobTokenCache     one access token per shop for the whole job slice
//                     (no DB read + decrypt before every call). The
//                     concurrency-safe refresh of SHOPEE-1 stays in
//                     ShopeeConnectionService; an auth error drops the
//                     cached token so the next call goes through it again.
//
// Metadata only — never tokens, signatures or payloads.
// ============================================================
import type { ExecutionBudget } from "../core/retry-policy.ts";
import { ShopeeApiError } from "./errors.ts";
import type { ListOrdersInput, OrderProviderContext, ShopeeOrderProvider } from "./order-provider.ts";
import type { ListItemsInput, ProductProviderContext, ProviderPayload, ShopeeProductProvider } from "./product-provider.ts";
import type { ShopeeTokenSource } from "./token.ts";

export class ApiCallMeter {
  readonly calls: Record<string, number> = {};
  rateLimitHits = 0;
  private readonly budget: ExecutionBudget | null;

  constructor(budget: ExecutionBudget | null = null) {
    this.budget = budget;
  }

  async track<T>(apiName: string, fn: () => Promise<T>): Promise<T> {
    this.calls[apiName] = (this.calls[apiName] ?? 0) + 1;
    this.budget?.spend(1);
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ShopeeApiError && err.category === "rate_limit") this.rateLimitHits++;
      throw err;
    }
  }

  get total(): number {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
}

export function meterOrderProvider(provider: ShopeeOrderProvider, meter: ApiCallMeter): ShopeeOrderProvider {
  return {
    mode: provider.mode,
    listOrders: (ctx: OrderProviderContext, input: ListOrdersInput) => meter.track("get_order_list", () => provider.listOrders(ctx, input)),
    getOrderDetails: (ctx: OrderProviderContext, input: { orderSns: readonly string[] }) => meter.track("get_order_detail", () => provider.getOrderDetails(ctx, input)),
  };
}

export function meterProductProvider(provider: ShopeeProductProvider, meter: ApiCallMeter): ShopeeProductProvider {
  return {
    mode: provider.mode,
    listItems: (ctx: ProductProviderContext, input: ListItemsInput): Promise<ProviderPayload> => meter.track("get_item_list", () => provider.listItems(ctx, input)),
    getItemBaseInfo: (ctx: ProductProviderContext, input: { itemIds: readonly string[] }) => meter.track("get_item_base_info", () => provider.getItemBaseInfo(ctx, input)),
    getModelList: (ctx: ProductProviderContext, input: { itemId: string }) => meter.track("get_model_list", () => provider.getModelList(ctx, input)),
  };
}

/** Caches a valid token per shop for the lifetime of this object (one worker run ≤ a few minutes; tokens live ~4h and are refreshed 10 min early). */
export class JobTokenCache implements ShopeeTokenSource {
  private readonly source: ShopeeTokenSource;
  private readonly tokens = new Map<string, Promise<string>>();

  constructor(source: ShopeeTokenSource) {
    this.source = source;
  }

  getValidAccessToken(shopId: string): Promise<string> {
    let token = this.tokens.get(shopId);
    if (!token) {
      token = this.source.getValidAccessToken(shopId);
      this.tokens.set(shopId, token);
      token.catch(() => this.tokens.delete(shopId));
    }
    return token;
  }

  async recordApiFailure(shopId: string, error: ShopeeApiError): Promise<void> {
    if (error.category === "auth") this.tokens.delete(shopId);
    await this.source.recordApiFailure(shopId, error);
  }
}
