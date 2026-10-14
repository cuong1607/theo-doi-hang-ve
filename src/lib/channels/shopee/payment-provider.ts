// ============================================================
// PHASE SHOPEE-5: payment API port + implementations (same pattern as
// order-provider.ts). Financial business logic depends only on
// ShopeePaymentProvider; providers return RAW provider JSON, parsing is
// escrow-adapter.ts's job.
//
// Phase scope: v2.payment.get_escrow_detail (order-level settlement).
// get_income_detail / get_income_overview / get_payout_detail are only a
// boundary here (paths reserved) — release/payout reconciliation is later.
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ShopeeClient } from "./client.ts";
import { ShopeeApiError } from "./errors.ts";
import type { ProductProviderContext, ProviderMode, ProviderPayload } from "./product-provider.ts";
import type { ShopeeTokenSource } from "./token.ts";

export type PaymentProviderContext = ProductProviderContext;

export interface ShopeePaymentProvider {
  readonly mode: ProviderMode;
  getEscrowDetail(ctx: PaymentProviderContext, input: { orderSn: string }): Promise<ProviderPayload>;
}

export const PAYMENT_PATHS = {
  escrowDetail: "/api/v2/payment/get_escrow_detail",
  // Boundary only (later phases):
  incomeDetail: "/api/v2/payment/get_income_detail",
  incomeOverview: "/api/v2/payment/get_income_overview",
  payoutDetail: "/api/v2/payment/get_payout_detail",
} as const;

export class RealShopeePaymentProvider implements ShopeePaymentProvider {
  readonly mode = "live" as const;
  private readonly client: ShopeeClient;
  private readonly connections: ShopeeTokenSource;

  constructor(deps: { client: ShopeeClient; connections: ShopeeTokenSource }) {
    this.client = deps.client;
    this.connections = deps.connections;
  }

  async getEscrowDetail(ctx: PaymentProviderContext, input: { orderSn: string }): Promise<ProviderPayload> {
    const accessToken = await this.connections.getValidAccessToken(ctx.shopId);
    try {
      const { data, requestId } = await this.client.request({
        path: PAYMENT_PATHS.escrowDetail,
        method: "GET",
        shop: { externalShopId: ctx.externalShopId, accessToken },
        query: { order_sn: input.orderSn },
        logShopId: ctx.shopId,
      });
      return { apiName: "v2.payment.get_escrow_detail", raw: data, requestId };
    } catch (err) {
      if (err instanceof ShopeeApiError) await this.connections.recordApiFailure(ctx.shopId, err);
      throw err;
    }
  }
}

// --------------------------------------------------------------- fixture

export type FixturePaymentCallHook = (call: { apiName: string; input: unknown }) => void | Promise<void>;

/** Fixture escrow payloads by order_sn (whole get_escrow_detail envelopes). */
export class FixtureShopeePaymentProvider implements ShopeePaymentProvider {
  readonly mode = "fixture" as const;
  private readonly bySn: Map<string, unknown>;
  private readonly onCall?: FixturePaymentCallHook;

  constructor(bySn: Map<string, unknown>, options: { onCall?: FixturePaymentCallHook } = {}) {
    this.bySn = bySn;
    this.onCall = options.onCall;
  }

  async getEscrowDetail(_ctx: PaymentProviderContext, input: { orderSn: string }): Promise<ProviderPayload> {
    await this.onCall?.({ apiName: "v2.payment.get_escrow_detail", input });
    const raw = this.bySn.get(input.orderSn);
    if (raw === undefined) {
      // Same shape a real "escrow not ready / not found" answer is handled as.
      throw new ShopeeApiError({ apiPath: PAYMENT_PATHS.escrowDetail, errorCode: "error_not_found", message: `fixture: no escrow for ${input.orderSn}` });
    }
    return { apiName: "v2.payment.get_escrow_detail", raw, requestId: null };
  }
}

export const DEFAULT_ESCROW_FIXTURE_DIR = path.join("tests", "fixtures", "shopee", "escrow");

/** tests/fixtures/shopee/escrow/*.json — each file one get_escrow_detail envelope. */
export function loadEscrowFixtures(dir: string = path.join(process.cwd(), DEFAULT_ESCROW_FIXTURE_DIR)): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { response?: { order_sn?: string } };
    const sn = raw.response?.order_sn;
    if (sn) out.set(String(sn), raw);
  }
  return out;
}
