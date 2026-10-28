// ============================================================
// SHOPEE-ADS-0: Ads API boundary — CONTRACT ONLY.
//
// Same pattern as the other Shopee providers (product / order / return):
// the sync job depends on this port, a Real implementation signs requests
// through the shared ShopeeClient + token source (OAuth, refresh, rate-limit
// classification, API-call metering all reused), a Fixture implementation
// serves tests. Providers return RAW provider JSON; parsing belongs to a
// future ads adapter (the only place that will know Shopee Ads field names).
//
// TODO(SHOPEE-ADS-1): real endpoint paths / parameters / response shapes
// come from the official Shopee Ads API docs the user will provide — none
// are guessed here. Until then the only implementation refuses to run.
// ============================================================
//
// READ-ONLY POLICY (./read-only-policy.ts): this contract exposes READ
// methods only (get… / list…). No create / update / pause / resume / delete
// campaign, no budget / bid / status / settings method may ever be added;
// every real implementation must pass each request through
// assertAdsReadOnlyRequest() (GET + allowlisted read path). Pinned by
// read-only-guard.test.ts.
import type { ProductProviderContext, ProviderMode, ProviderPayload } from "../product-provider.ts";

export type AdsProviderContext = ProductProviderContext;

/** A reporting window (business dates, shop timezone), inclusive. */
export interface AdsDateRange {
  from: string;
  to: string;
}

export interface ShopeeAdsProvider {
  readonly mode: ProviderMode;
  /** Campaigns of the shop (paged). TODO(SHOPEE-ADS-1): endpoint + paging model. */
  listCampaigns(ctx: AdsProviderContext, input: { page: number; pageSize: number }): Promise<ProviderPayload>;
  /** Per-campaign performance for a date range. TODO(SHOPEE-ADS-1). */
  getCampaignPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; range: AdsDateRange }): Promise<ProviderPayload>;
  /** Shop-level ads performance for a date range. TODO(SHOPEE-ADS-1). */
  getAdsPerformance(ctx: AdsProviderContext, input: { range: AdsDateRange }): Promise<ProviderPayload>;
  /** Budget / balance information. TODO(SHOPEE-ADS-1). */
  getBudgetInfo(ctx: AdsProviderContext): Promise<ProviderPayload>;
}

export class AdsNotImplementedError extends Error {
  constructor(method: string) {
    super(`Shopee Ads API chưa được triển khai (${method}) — chờ tài liệu API chính thức (SHOPEE-ADS-1).`);
    this.name = "AdsNotImplementedError";
  }
}

/** The only implementation until SHOPEE-ADS-1: never calls Shopee. */
export class NotImplementedShopeeAdsProvider implements ShopeeAdsProvider {
  readonly mode: ProviderMode;

  constructor(mode: ProviderMode = "live") {
    this.mode = mode;
  }

  listCampaigns(): Promise<ProviderPayload> {
    return Promise.reject(new AdsNotImplementedError("listCampaigns"));
  }

  getCampaignPerformance(): Promise<ProviderPayload> {
    return Promise.reject(new AdsNotImplementedError("getCampaignPerformance"));
  }

  getAdsPerformance(): Promise<ProviderPayload> {
    return Promise.reject(new AdsNotImplementedError("getAdsPerformance"));
  }

  getBudgetInfo(): Promise<ProviderPayload> {
    return Promise.reject(new AdsNotImplementedError("getBudgetInfo"));
  }
}
