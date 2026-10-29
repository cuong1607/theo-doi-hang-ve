// ============================================================
// SHOPEE-ADS-2 test utility: a multi-shop Ads provider for load / fairness
// tests. Each shop gets N campaigns cloned from the sanitized production
// fixtures (same payload shapes as the real API), a fixed latency per call,
// and the provider records every call + the peak number of calls in flight.
// READ ONLY like every other provider: same read-only policy guard, GET
// endpoints only, get… / list… methods only.
// ============================================================
import { formatAdsDate } from "./mapper.ts";
import { FixtureShopeeAdsProvider, loadAdsFixtures, type AdsDateRange, type AdsFixtureData, type AdsProviderContext, type ShopeeAdsProvider } from "./provider.ts";
import { ADS_READ_ENDPOINTS, assertAdsReadOnlyRequest, type AdsReadEndpoint } from "./read-only-policy.ts";

type Obj = Record<string, unknown>;

export interface SimulatedShop {
  externalShopId: string;
  campaigns: number;
  /** Share of campaigns with provider_status = ongoing (default 0.3). */
  ongoingShare?: number;
}

export interface SimulatedCall {
  shop: string;
  endpoint: string;
  startedAt: number;
  ms: number;
  ids: number;
}

/** N campaigns for one shop: ids 100000…, ongoing ones spend on `date` (DD-MM-YYYY). */
export function simulatedShopData(base: AdsFixtureData, shop: SimulatedShop, date: string): AdsFixtureData {
  const template = base.settings.values().next().value as Obj;
  const metricsTemplate = [...base.campaignDaily.values()].flatMap((m) => [...m.values()]).find((r) => Number(r.expense) > 0)!;
  const hourlyTemplate = ([...base.campaignHourly.values()][0]?.values().next().value ?? []) as Obj[];
  const data: AdsFixtureData = { campaignIds: [], settings: new Map(), campaignDaily: new Map(), shopDaily: new Map(), shopHourly: new Map(), campaignHourly: new Map(), replayHourly: false };
  const ongoing = Math.round(shop.campaigns * (shop.ongoingShare ?? 0.3));
  let spend = 0;
  for (let i = 0; i < shop.campaigns; i++) {
    const id = String(100000 + i);
    const s = structuredClone(template) as Obj & { common_info: Obj };
    s.campaign_id = Number(id);
    s.common_info.campaign_status = i < ongoing ? "ongoing" : i % 2 ? "paused" : "ended";
    s.common_info.ad_name = `Sim ${shop.externalShopId} #${i}`;
    s.common_info.item_id_list = [700000 + i];
    data.campaignIds.push(id);
    data.settings.set(id, s);
    if (i < ongoing) {
      data.campaignDaily.set(id, new Map([[date, { ...metricsTemplate, date }]]));
      data.campaignHourly.set(id, new Map([[date, hourlyTemplate.map((r) => ({ ...r, date }))]]));
      spend += Number(metricsTemplate.expense);
    }
  }
  const shopRow = { ...([...base.shopDaily.values()][0] as Obj), date, expense: spend + 1000 };
  data.shopDaily.set(date, shopRow);
  data.shopHourly.set(date, (([...base.shopHourly.values()][0] ?? []) as Obj[]).map((r) => ({ ...r, date })));
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SimulatedAdsProvider implements ShopeeAdsProvider {
  readonly mode = "fixture" as const;
  readonly calls: SimulatedCall[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private readonly shops = new Map<string, FixtureShopeeAdsProvider>();
  private readonly latencyMs: number;
  /** externalShopId → error thrown on every call (failure isolation tests). */
  readonly failing = new Map<string, Error>();

  constructor(shops: SimulatedShop[], opts: { latencyMs?: number; date: AdsDateRange["from"] }) {
    this.latencyMs = opts.latencyMs ?? 0;
    const base = loadAdsFixtures();
    const date = formatAdsDate(opts.date);
    for (const s of shops) this.shops.set(s.externalShopId, new FixtureShopeeAdsProvider(simulatedShopData(base, s, date)));
  }

  private async run<T>(ctx: AdsProviderContext, endpoint: AdsReadEndpoint, ids: number, fn: (p: FixtureShopeeAdsProvider) => Promise<T>): Promise<T> {
    assertAdsReadOnlyRequest("GET", ADS_READ_ENDPOINTS[endpoint]);
    const p = this.shops.get(ctx.externalShopId);
    if (!p) throw new Error(`simulated provider: unknown shop ${ctx.externalShopId}`);
    const startedAt = Date.now();
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.latencyMs) await sleep(this.latencyMs);
      const failure = this.failing.get(ctx.externalShopId);
      if (failure) throw failure;
      return await fn(p);
    } finally {
      this.inFlight--;
      this.calls.push({ shop: ctx.externalShopId, endpoint, startedAt, ms: Date.now() - startedAt, ids });
    }
  }

  async listProductLevelCampaignIds(ctx: AdsProviderContext, input: { offset: number; limit: number }) {
    return this.run(ctx, "campaign_id_list", 0, (p) => p.listProductLevelCampaignIds(ctx, input));
  }

  async getProductLevelCampaignSettings(ctx: AdsProviderContext, input: { campaignIds: readonly string[] }) {
    return this.run(ctx, "campaign_setting_info", input.campaignIds.length, (p) => p.getProductLevelCampaignSettings(ctx, input));
  }

  async getProductCampaignDailyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; range: AdsDateRange }) {
    return this.run(ctx, "campaign_daily_performance", input.campaignIds.length, (p) => p.getProductCampaignDailyPerformance(ctx, input));
  }

  async getAllCpcAdsDailyPerformance(ctx: AdsProviderContext, input: { range: AdsDateRange }) {
    return this.run(ctx, "shop_daily_performance", 0, (p) => p.getAllCpcAdsDailyPerformance(ctx, input));
  }

  async getAllCpcAdsHourlyPerformance(ctx: AdsProviderContext, input: { date: string }) {
    return this.run(ctx, "shop_hourly_performance", 0, (p) => p.getAllCpcAdsHourlyPerformance(ctx, input));
  }

  async getProductCampaignHourlyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; date: string }) {
    return this.run(ctx, "campaign_hourly_performance", input.campaignIds.length, (p) => p.getProductCampaignHourlyPerformance(ctx, input));
  }
}
