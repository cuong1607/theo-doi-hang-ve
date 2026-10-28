// ============================================================
// PHASE SHOPEE-7: income / payout API port + implementations (same pattern
// as payment-provider.ts). Providers return RAW provider JSON; parsing is
// income-adapter.ts's job.
//
//   get_escrow_list             released escrows in a release_time window
//                               (local + CB) → order release
//   get_income_overview         shop totals (monitoring only)
//   get_payout_detail           payout batches — CROSS-BORDER shops only
//                               (sandbox: "only applicable for cross boarder shop")
//   get_wallet_transaction_list wallet ledger — LOCAL shops' payouts are the
//                               withdrawals in it
// get_income_detail is NOT used: on the sandbox the released mode rejected
// every release_time_from/to form (docs/archive/shopee-legacy/shopee-payouts.md).
// ============================================================
import type { ShopeeClient } from "./client.ts";
import { ShopeeApiError } from "./errors.ts";
import type { ProductProviderContext, ProviderMode, ProviderPayload } from "./product-provider.ts";
import type { ShopeeTokenSource } from "./token.ts";

export type IncomeProviderContext = ProductProviderContext;

export interface TimeWindowPage {
  from: number;
  to: number;
  pageNo: number;
  pageSize: number;
}

export interface ShopeeIncomeProvider {
  readonly mode: ProviderMode;
  listReleasedEscrows(ctx: IncomeProviderContext, input: TimeWindowPage): Promise<ProviderPayload>;
  getIncomeOverview(ctx: IncomeProviderContext): Promise<ProviderPayload>;
  getPayoutDetail(ctx: IncomeProviderContext, input: TimeWindowPage): Promise<ProviderPayload>;
  listWalletTransactions(ctx: IncomeProviderContext, input: TimeWindowPage): Promise<ProviderPayload>;
}

export const INCOME_PATHS = {
  escrowList: "/api/v2/payment/get_escrow_list",
  incomeOverview: "/api/v2/payment/get_income_overview",
  payoutDetail: "/api/v2/payment/get_payout_detail",
  walletTransactions: "/api/v2/payment/get_wallet_transaction_list",
} as const;

/** Window limits: Shopee payment list APIs accept ≤ 14–15 days; 14 is safe for all. */
export const MAX_INCOME_WINDOW_SECONDS = 14 * 24 * 60 * 60;
export const INCOME_PAGE_SIZE = 100;
/** get_escrow_list / get_payout_detail page_no starts at 1; get_wallet_transaction_list at 0. */
export const FIRST_PAGE = { escrowList: 1, payoutDetail: 1, wallet: 0 } as const;

/** The provider's way of saying "this shop has no payout_detail (local shop)". */
export function isCrossBorderOnlyError(err: unknown): boolean {
  return err instanceof ShopeeApiError && /cross\s*bo(a)?rder/i.test(err.message);
}

export class RealShopeeIncomeProvider implements ShopeeIncomeProvider {
  readonly mode = "live" as const;
  private readonly client: ShopeeClient;
  private readonly connections: ShopeeTokenSource;

  constructor(deps: { client: ShopeeClient; connections: ShopeeTokenSource }) {
    this.client = deps.client;
    this.connections = deps.connections;
  }

  private async get(ctx: IncomeProviderContext, path: string, apiName: string, query: Record<string, string | number>): Promise<ProviderPayload> {
    const accessToken = await this.connections.getValidAccessToken(ctx.shopId);
    try {
      const { data, requestId } = await this.client.request({
        path,
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

  listReleasedEscrows(ctx: IncomeProviderContext, input: TimeWindowPage) {
    return this.get(ctx, INCOME_PATHS.escrowList, "v2.payment.get_escrow_list", {
      release_time_from: input.from,
      release_time_to: input.to,
      page_no: input.pageNo,
      page_size: input.pageSize,
    });
  }

  getIncomeOverview(ctx: IncomeProviderContext) {
    return this.get(ctx, INCOME_PATHS.incomeOverview, "v2.payment.get_income_overview", {});
  }

  getPayoutDetail(ctx: IncomeProviderContext, input: TimeWindowPage) {
    return this.get(ctx, INCOME_PATHS.payoutDetail, "v2.payment.get_payout_detail", {
      payout_time_from: input.from,
      payout_time_to: input.to,
      page_no: input.pageNo,
      page_size: input.pageSize,
    });
  }

  listWalletTransactions(ctx: IncomeProviderContext, input: TimeWindowPage) {
    return this.get(ctx, INCOME_PATHS.walletTransactions, "v2.payment.get_wallet_transaction_list", {
      create_time_from: input.from,
      create_time_to: input.to,
      page_no: input.pageNo,
      page_size: input.pageSize,
    });
  }
}

// --------------------------------------------------------------- fixture

/** Raw provider entries (same field names as the real API); the fixture filters + pages them. */
export interface IncomeFixtureData {
  /** get_escrow_list entries: { order_sn, payout_amount, escrow_release_time } */
  releasedEscrows?: unknown[];
  /** whole get_income_overview `response` */
  overview?: unknown;
  /** get_payout_detail payout_list entries (payout_info.payout_time drives the window); undefined = local shop */
  payouts?: unknown[];
  /** get_wallet_transaction_list entries (create_time drives the window) */
  walletTransactions?: unknown[];
}

export type FixtureIncomeCallHook = (call: { apiName: string; input: unknown }) => void | Promise<void>;

const timeOf = (e: unknown, pick: (x: Record<string, unknown>) => unknown): number => {
  const v = e && typeof e === "object" ? pick(e as Record<string, unknown>) : undefined;
  return typeof v === "number" ? v : Number(v ?? NaN);
};

export class FixtureShopeeIncomeProvider implements ShopeeIncomeProvider {
  readonly mode = "fixture" as const;
  private readonly data: IncomeFixtureData;
  private readonly onCall?: FixtureIncomeCallHook;

  constructor(data: IncomeFixtureData, options: { onCall?: FixtureIncomeCallHook } = {}) {
    this.data = data;
    this.onCall = options.onCall;
  }

  private page(entries: unknown[], input: TimeWindowPage, first: number, time: (x: Record<string, unknown>) => unknown) {
    const inWindow = entries.filter((e) => {
      const t = timeOf(e, time);
      return t >= input.from && t <= input.to;
    });
    const start = (input.pageNo - first) * input.pageSize;
    return { slice: inWindow.slice(start, start + input.pageSize), more: start + input.pageSize < inWindow.length };
  }

  async listReleasedEscrows(_ctx: IncomeProviderContext, input: TimeWindowPage): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.payment.get_escrow_list", input });
    const { slice, more } = this.page(this.data.releasedEscrows ?? [], input, FIRST_PAGE.escrowList, (x) => x.escrow_release_time);
    return { apiName: "v2.payment.get_escrow_list", raw: { error: "", message: "", response: { escrow_list: slice, more } }, requestId: null };
  }

  async getIncomeOverview(): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.payment.get_income_overview", input: {} });
    const response = this.data.overview ?? { total_income: { pending_amount: 0, released_amount: 0 } };
    return { apiName: "v2.payment.get_income_overview", raw: { error: "", message: "", response }, requestId: null };
  }

  async getPayoutDetail(_ctx: IncomeProviderContext, input: TimeWindowPage): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.payment.get_payout_detail", input });
    if (this.data.payouts === undefined) {
      throw new ShopeeApiError({ apiPath: INCOME_PATHS.payoutDetail, errorCode: "error_param", message: "This payment API is only applicable for cross boarder shop" });
    }
    const { slice, more } = this.page(this.data.payouts, input, FIRST_PAGE.payoutDetail, (x) => (x.payout_info as Record<string, unknown> | undefined)?.payout_time);
    return { apiName: "v2.payment.get_payout_detail", raw: { error: "", message: "", response: { payout_list: slice, more } }, requestId: null };
  }

  async listWalletTransactions(_ctx: IncomeProviderContext, input: TimeWindowPage): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.payment.get_wallet_transaction_list", input });
    const { slice, more } = this.page(this.data.walletTransactions ?? [], input, FIRST_PAGE.wallet, (x) => x.create_time);
    return { apiName: "v2.payment.get_wallet_transaction_list", raw: { error: "", message: "", response: { transaction_list: slice, more } }, requestId: null };
  }
}
