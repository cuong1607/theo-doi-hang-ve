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
import { emptyLatency, recordLatency, type LatencyStats } from "../core/sync-progress.ts";
import { ShopeeApiError } from "./errors.ts";
import type { ListOrdersInput, OrderProviderContext, ShopeeOrderProvider } from "./order-provider.ts";
import type { PaymentProviderContext, ShopeePaymentProvider } from "./payment-provider.ts";
import type { ListItemsInput, ProductProviderContext, ProviderPayload, ShopeeProductProvider } from "./product-provider.ts";
import type { ListReturnsInput, ReturnProviderContext, ShopeeReturnProvider } from "./return-provider.ts";
import type { ReturnLogisticsProviderContext, ShopeeReturnLogisticsProvider } from "./return-logistics-provider.ts";
import type { IncomeProviderContext, ShopeeIncomeProvider, TimeWindowPage } from "./income-provider.ts";
import type { ShopeeTokenSource } from "./token.ts";

export class ApiCallMeter {
  readonly calls: Record<string, number> = {};
  /** SHOPEE-PERF-2: wall-clock latency per api name (region benchmark). */
  readonly latency: Record<string, LatencyStats> = {};
  rateLimitHits = 0;
  private readonly budget: ExecutionBudget | null;
  private readonly clock: () => number;

  constructor(budget: ExecutionBudget | null = null, clock: () => number = Date.now) {
    this.budget = budget;
    this.clock = clock;
  }

  async track<T>(apiName: string, fn: () => Promise<T>): Promise<T> {
    this.calls[apiName] = (this.calls[apiName] ?? 0) + 1;
    this.budget?.spend(1);
    const started = this.clock();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ShopeeApiError && err.category === "rate_limit") this.rateLimitHits++;
      throw err;
    } finally {
      recordLatency((this.latency[apiName] ??= emptyLatency()), this.clock() - started);
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

export function meterPaymentProvider(provider: ShopeePaymentProvider, meter: ApiCallMeter): ShopeePaymentProvider {
  return {
    mode: provider.mode,
    getEscrowDetail: (ctx: PaymentProviderContext, input: { orderSn: string }) => meter.track("get_escrow_detail", () => provider.getEscrowDetail(ctx, input)),
  };
}

export function meterIncomeProvider(provider: ShopeeIncomeProvider, meter: ApiCallMeter): ShopeeIncomeProvider {
  return {
    mode: provider.mode,
    listReleasedEscrows: (ctx: IncomeProviderContext, input: TimeWindowPage) => meter.track("get_escrow_list", () => provider.listReleasedEscrows(ctx, input)),
    getIncomeOverview: (ctx: IncomeProviderContext) => meter.track("get_income_overview", () => provider.getIncomeOverview(ctx)),
    getPayoutDetail: (ctx: IncomeProviderContext, input: TimeWindowPage) => meter.track("get_payout_detail", () => provider.getPayoutDetail(ctx, input)),
    listWalletTransactions: (ctx: IncomeProviderContext, input: TimeWindowPage) => meter.track("get_wallet_transaction_list", () => provider.listWalletTransactions(ctx, input)),
  };
}

export function meterReturnProvider(provider: ShopeeReturnProvider, meter: ApiCallMeter): ShopeeReturnProvider {
  return {
    mode: provider.mode,
    listReturns: (ctx: ReturnProviderContext, input: ListReturnsInput) => meter.track("get_return_list", () => provider.listReturns(ctx, input)),
    getReturnDetail: (ctx: ReturnProviderContext, input: { returnSn: string }) => meter.track("get_return_detail", () => provider.getReturnDetail(ctx, input)),
  };
}

export function meterReturnLogisticsProvider(provider: ShopeeReturnLogisticsProvider, meter: ApiCallMeter): ShopeeReturnLogisticsProvider {
  return {
    mode: provider.mode,
    getReverseTrackingInfo: (ctx: ReturnLogisticsProviderContext, input: { returnSn: string }) => meter.track("get_reverse_tracking_info", () => provider.getReverseTrackingInfo(ctx, input)),
    getTrackingNumber: (ctx: ReturnLogisticsProviderContext, input: { orderSn: string; packageNumber?: string | null }) => meter.track("get_tracking_number", () => provider.getTrackingNumber(ctx, input)),
    getTrackingInfo: (ctx: ReturnLogisticsProviderContext, input: { orderSn: string; packageNumber?: string | null }) => meter.track("get_tracking_info", () => provider.getTrackingInfo(ctx, input)),
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
