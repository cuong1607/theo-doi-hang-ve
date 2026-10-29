// ============================================================
// SHOPEE-ADS-1B: the Shopee Ads provider — READ-ONLY.
//
//   ShopeeAdsProvider (port) ← the Ads read jobs depend only on this
//     ├─ RealShopeeAdsProvider     shared ShopeeClient + token source (OAuth,
//     │                            refresh, rate-limit classification reused)
//     └─ FixtureShopeeAdsProvider  replays the sanitized PRODUCTION payloads in
//                                  __fixtures__/provider (local dev / tests —
//                                  the Shopee sandbox has no Ads backend)
//
// Providers return the RAW envelope (+ request id); parsing is mapper.ts.
//
// READ-ONLY POLICY (./read-only-policy.ts): this contract exposes READ
// methods only (get… / list…). No create / update / pause / resume / delete
// campaign, no budget / bid / status / settings method may ever be added;
// every request passes assertAdsReadOnlyRequest() (GET + read path) AND the
// explicit ADS_READ_ENDPOINTS allowlist. Pinned by read-only-guard.test.ts.
//
// Verified limits (docs/shopee-ads-api.md §3.5) are enforced here so a
// caller can never send an unverified request shape.
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ShopeeClient } from "../client.ts";
import { ShopeeApiError } from "../errors.ts";
import type { ProductProviderContext, ProviderMode, ProviderPayload } from "../product-provider.ts";
import type { ShopeeTokenSource } from "../token.ts";
import { formatAdsDate } from "./mapper.ts";
import { ADS_READ_ENDPOINTS, assertAdsReadOnlyRequest, AdsWriteForbiddenError, type AdsReadEndpoint } from "./read-only-policy.ts";

export type AdsProviderContext = ProductProviderContext;

/** Verified request limits. */
export const ADS_CAMPAIGN_PAGE_SIZE = 100;
export const ADS_ID_BATCH = 50;
export const ADS_CAMPAIGN_RANGE_DAYS = 7;
export const ADS_SHOP_RANGE_DAYS = 30;

/** A reporting window, inclusive, as YYYY-MM-DD (shop-local report dates). */
export interface AdsDateRange {
  from: string;
  to: string;
}

export interface ShopeeAdsProvider {
  readonly mode: ProviderMode;
  /** get_product_level_campaign_id_list — offset / limit (≤ 100) / has_next_page. */
  listProductLevelCampaignIds(ctx: AdsProviderContext, input: { offset: number; limit: number }): Promise<ProviderPayload>;
  /** get_product_level_campaign_setting_info — ≤ 50 ids. */
  getProductLevelCampaignSettings(ctx: AdsProviderContext, input: { campaignIds: readonly string[] }): Promise<ProviderPayload>;
  /** get_product_campaign_daily_performance — ≤ 50 ids, ≤ 7 days. */
  getProductCampaignDailyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; range: AdsDateRange }): Promise<ProviderPayload>;
  /** get_all_cpc_ads_daily_performance — shop-level total, ≤ 30 days. */
  getAllCpcAdsDailyPerformance(ctx: AdsProviderContext, input: { range: AdsDateRange }): Promise<ProviderPayload>;
  /** get_all_cpc_ads_hourly_performance — shop-level total, ONE date (performance_date), rows per hour 0–23. */
  getAllCpcAdsHourlyPerformance(ctx: AdsProviderContext, input: { date: string }): Promise<ProviderPayload>;
  /** get_product_campaign_hourly_performance — ≤ 50 ids, ONE date (performance_date), rows per campaign × hour. */
  getProductCampaignHourlyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; date: string }): Promise<ProviderPayload>;
}

const DAY_MS = 86_400_000;
function rangeDays(range: AdsDateRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new AdsWriteForbiddenError(`khoảng ngày không hợp lệ ${range.from} → ${range.to}`);
  return Math.round((to - from) / DAY_MS) + 1;
}

/** Refuses any request shape outside the verified limits (fail closed, before any call). */
export function assertVerifiedAdsRequest(kind: "list" | "ids" | "campaign_range" | "shop_range" | "shop_hourly" | "campaign_hourly", value: { limit?: number; ids?: readonly string[]; range?: AdsDateRange; date?: string }) {
  if (kind === "list" && (!value.limit || value.limit < 1 || value.limit > ADS_CAMPAIGN_PAGE_SIZE)) throw new Error(`limit phải trong 1…${ADS_CAMPAIGN_PAGE_SIZE}.`);
  // hourly: one performance_date per call (verified shape) — a single valid day, never a range
  if (kind === "shop_hourly" || kind === "campaign_hourly") rangeDays({ from: value.date ?? "", to: value.date ?? "" });
  if ((kind === "ids" || kind === "campaign_range" || kind === "campaign_hourly") && (!value.ids?.length || value.ids.length > ADS_ID_BATCH)) throw new Error(`Cần 1…${ADS_ID_BATCH} campaign id mỗi lần gọi.`);
  if (value.ids?.some((id) => !/^\d{1,20}$/.test(id))) throw new Error("campaign id không hợp lệ.");
  if (kind === "campaign_range" && rangeDays(value.range!) > ADS_CAMPAIGN_RANGE_DAYS) throw new Error(`Hiệu quả chiến dịch: tối đa ${ADS_CAMPAIGN_RANGE_DAYS} ngày mỗi lần gọi.`);
  if (kind === "shop_range" && rangeDays(value.range!) > ADS_SHOP_RANGE_DAYS) throw new Error(`Hiệu quả shop: tối đa ${ADS_SHOP_RANGE_DAYS} ngày mỗi lần gọi.`);
}

// ------------------------------------------------------------------ live

export class RealShopeeAdsProvider implements ShopeeAdsProvider {
  readonly mode = "live" as const;
  private readonly client: ShopeeClient;
  private readonly connections: ShopeeTokenSource;

  constructor(deps: { client: ShopeeClient; connections: ShopeeTokenSource }) {
    this.client = deps.client;
    this.connections = deps.connections;
  }

  private async get(ctx: AdsProviderContext, endpoint: AdsReadEndpoint, query: Record<string, string | number>): Promise<ProviderPayload> {
    const apiPath = ADS_READ_ENDPOINTS[endpoint];
    assertAdsReadOnlyRequest("GET", apiPath); // read-only policy: GET + allowlisted read path, always
    const accessToken = await this.connections.getValidAccessToken(ctx.shopId);
    try {
      const { data, requestId } = await this.client.request({ path: apiPath, method: "GET", shop: { externalShopId: ctx.externalShopId, accessToken }, query, logShopId: ctx.shopId });
      return { apiName: apiPath, raw: data, requestId };
    } catch (err) {
      if (err instanceof ShopeeApiError) await this.connections.recordApiFailure(ctx.shopId, err);
      throw err;
    }
  }

  async listProductLevelCampaignIds(ctx: AdsProviderContext, input: { offset: number; limit: number }) {
    assertVerifiedAdsRequest("list", { limit: input.limit });
    return this.get(ctx, "campaign_id_list", { ad_type: "all", offset: Math.max(0, input.offset), limit: input.limit });
  }

  async getProductLevelCampaignSettings(ctx: AdsProviderContext, input: { campaignIds: readonly string[] }) {
    assertVerifiedAdsRequest("ids", { ids: input.campaignIds });
    return this.get(ctx, "campaign_setting_info", { info_type_list: "1,2,3,4", campaign_id_list: input.campaignIds.join(",") });
  }

  async getProductCampaignDailyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; range: AdsDateRange }) {
    assertVerifiedAdsRequest("campaign_range", { ids: input.campaignIds, range: input.range });
    return this.get(ctx, "campaign_daily_performance", { start_date: formatAdsDate(input.range.from), end_date: formatAdsDate(input.range.to), campaign_id_list: input.campaignIds.join(",") });
  }

  async getAllCpcAdsDailyPerformance(ctx: AdsProviderContext, input: { range: AdsDateRange }) {
    assertVerifiedAdsRequest("shop_range", { range: input.range });
    return this.get(ctx, "shop_daily_performance", { start_date: formatAdsDate(input.range.from), end_date: formatAdsDate(input.range.to) });
  }

  async getAllCpcAdsHourlyPerformance(ctx: AdsProviderContext, input: { date: string }) {
    assertVerifiedAdsRequest("shop_hourly", { date: input.date });
    return this.get(ctx, "shop_hourly_performance", { performance_date: formatAdsDate(input.date) });
  }

  async getProductCampaignHourlyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; date: string }) {
    assertVerifiedAdsRequest("campaign_hourly", { ids: input.campaignIds, date: input.date });
    return this.get(ctx, "campaign_hourly_performance", { performance_date: formatAdsDate(input.date), campaign_id_list: input.campaignIds.join(",") });
  }
}

// ------------------------------------------------------------------ fixture (sanitized production payloads)

export const ADS_FIXTURE_DIR = path.join(process.cwd(), "src/lib/channels/shopee/ads/__fixtures__/provider");

type Obj = Record<string, unknown>;

export interface AdsFixtureData {
  campaignIds: string[];
  settings: Map<string, Obj>;
  /** campaign id → report date (DD-MM-YYYY) → metrics row */
  campaignDaily: Map<string, Map<string, Obj>>;
  /** report date (DD-MM-YYYY) → shop row */
  shopDaily: Map<string, Obj>;
  /** report date (DD-MM-YYYY) → 24 shop hourly rows (ADS-3A.1) */
  shopHourly: Map<string, Obj[]>;
  /** campaign id → report date (DD-MM-YYYY) → hourly rows */
  campaignHourly: Map<string, Map<string, Obj[]>>;
  /**
   * Dev / E2E only: a date without a captured hourly payload replays the
   * captured day's hourly profile re-dated (no capture exists for "today").
   * Tests that need exact data turn it off.
   */
  replayHourly: boolean;
}

/** Loads the production fixtures captured by ADS-1A / 1A.1 (masked ids, real metrics). */
export function loadAdsFixtures(dir: string = ADS_FIXTURE_DIR): AdsFixtureData {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { response?: { response?: unknown } };
  const body = (f: string) => read(f).response?.response;
  const data: AdsFixtureData = { campaignIds: [], settings: new Map(), campaignDaily: new Map(), shopDaily: new Map(), shopHourly: new Map(), campaignHourly: new Map(), replayHourly: true };
  // the expansion run (exp-*) holds the complete, consistently masked campaign set
  for (const f of files.filter((n) => /^exp-campaign-id-list/.test(n)).sort()) {
    for (const c of ((body(f) as Obj)?.campaign_list as Obj[]) ?? []) data.campaignIds.push(String(c.campaign_id));
  }
  for (const f of files.filter((n) => /^exp-campaign-setting-info/.test(n))) {
    for (const c of ((body(f) as Obj)?.campaign_list as Obj[]) ?? []) data.settings.set(String(c.campaign_id), c);
  }
  for (const f of files.filter((n) => /^exp-campaign-daily-performance/.test(n))) {
    for (const c of ((body(f) as Obj)?.campaign_list as Obj[]) ?? []) {
      const byDate = data.campaignDaily.get(String(c.campaign_id)) ?? new Map<string, Obj>();
      for (const m of (c.metrics_list as Obj[]) ?? []) byDate.set(String(m.date), m);
      data.campaignDaily.set(String(c.campaign_id), byDate);
    }
  }
  // shop totals: the 30-day expansion window + the baseline "today" (partial) row
  for (const f of files.filter((n) => /^(exp-)?shop-daily-performance/.test(n))) {
    for (const r of (body(f) as Obj[]) ?? []) data.shopDaily.set(String(r.date), r);
  }
  // hourly (ADS-3A.1): shop total of the baseline run; campaigns of the expansion run (same masks as the exp-* settings)
  for (const f of files.filter((n) => /^shop-hourly-performance/.test(n))) {
    for (const r of (body(f) as Obj[]) ?? []) data.shopHourly.set(String(r.date), [...(data.shopHourly.get(String(r.date)) ?? []), r]);
  }
  for (const f of files.filter((n) => /^exp-campaign-hourly-performance/.test(n))) {
    for (const c of ((body(f) as Obj)?.campaign_list as Obj[]) ?? []) {
      const byDate = data.campaignHourly.get(String(c.campaign_id)) ?? new Map<string, Obj[]>();
      for (const m of (c.metrics_list as Obj[]) ?? []) byDate.set(String(m.date), [...(byDate.get(String(m.date)) ?? []), m]);
      data.campaignHourly.set(String(c.campaign_id), byDate);
    }
  }
  return data;
}

const ZERO_CAMPAIGN_METRICS = {
  impression: 0, clicks: 0, ctr: 0, expense: 0, broad_gmv: 0, broad_order: 0, broad_order_amount: 0, broad_roi: 0, broad_cir: 0, cr: 0, cpc: 0,
  direct_order: 0, direct_order_amount: 0, direct_gmv: 0, direct_roi: 0, direct_cir: 0, direct_cr: 0, cpdc: 0,
};

function datesOf(range: AdsDateRange): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += DAY_MS) {
    out.push(formatAdsDate(new Date(t).toISOString().slice(0, 10)));
  }
  return out;
}

/** Captured rows for `date`, else (replay on) the first captured day re-dated, else null. */
function hourlyRowsFor(byDate: Map<string, Obj[]> | undefined, date: string, replay: boolean): Obj[] | null {
  const exact = byDate?.get(date);
  if (exact) return exact;
  const first = replay ? byDate?.values().next().value : undefined;
  return first ? first.map((r) => ({ ...r, date })) : null;
}

const envelope = (response: unknown) => ({ request_id: "fixture", error: "", message: "", warning: "", response });

export class FixtureShopeeAdsProvider implements ShopeeAdsProvider {
  readonly mode = "fixture" as const;
  private readonly data: AdsFixtureData;
  /** Test hook: per-call overrides (e.g. a changed metric for the restatement test). */
  readonly overrides: {
    campaignDaily?: (id: string, date: string, row: Obj) => Obj;
    shopDaily?: (date: string, row: Obj) => Obj;
    shopHourly?: (date: string, row: Obj) => Obj;
    campaignHourly?: (id: string, date: string, row: Obj) => Obj;
  };

  constructor(data: AdsFixtureData = loadAdsFixtures(), overrides: FixtureShopeeAdsProvider["overrides"] = {}) {
    this.data = data;
    this.overrides = overrides;
  }

  private guard(endpoint: AdsReadEndpoint) {
    assertAdsReadOnlyRequest("GET", ADS_READ_ENDPOINTS[endpoint]);
    return ADS_READ_ENDPOINTS[endpoint];
  }

  async listProductLevelCampaignIds(_ctx: AdsProviderContext, input: { offset: number; limit: number }) {
    assertVerifiedAdsRequest("list", { limit: input.limit });
    const apiName = this.guard("campaign_id_list");
    const page = this.data.campaignIds.slice(input.offset, input.offset + input.limit);
    return { apiName, requestId: "fixture", raw: envelope({ region: "VN", has_next_page: input.offset + input.limit < this.data.campaignIds.length, campaign_list: page.map((id) => ({ ad_type: "manual", campaign_id: Number(id) })) }) };
  }

  async getProductLevelCampaignSettings(_ctx: AdsProviderContext, input: { campaignIds: readonly string[] }) {
    assertVerifiedAdsRequest("ids", { ids: input.campaignIds });
    const apiName = this.guard("campaign_setting_info");
    return { apiName, requestId: "fixture", raw: envelope({ region: "VN", campaign_list: input.campaignIds.map((id) => this.data.settings.get(id)).filter(Boolean) }) };
  }

  async getProductCampaignDailyPerformance(_ctx: AdsProviderContext, input: { campaignIds: readonly string[]; range: AdsDateRange }) {
    assertVerifiedAdsRequest("campaign_range", { ids: input.campaignIds, range: input.range });
    const apiName = this.guard("campaign_daily_performance");
    const dates = datesOf(input.range);
    const campaign_list = input.campaignIds.map((id) => {
      const s = this.data.settings.get(id);
      const common = (s?.common_info ?? {}) as Obj;
      return {
        campaign_id: Number(id),
        ad_type: common.ad_type ?? "manual",
        campaign_placement: common.campaign_placement ?? "all",
        ad_name: common.ad_name ?? null,
        // like the real API: one row per requested date, zeros when there was no activity
        metrics_list: dates.map((date) => {
          const row = { date, ...ZERO_CAMPAIGN_METRICS, ...(this.data.campaignDaily.get(id)?.get(date) ?? {}) };
          return this.overrides.campaignDaily ? this.overrides.campaignDaily(id, date, row) : row;
        }),
      };
    });
    return { apiName, requestId: "fixture", raw: envelope({ region: "VN", campaign_list }) };
  }

  async getAllCpcAdsDailyPerformance(_ctx: AdsProviderContext, input: { range: AdsDateRange }) {
    assertVerifiedAdsRequest("shop_range", { range: input.range });
    const apiName = this.guard("shop_daily_performance");
    const rows = datesOf(input.range)
      .filter((d) => this.data.shopDaily.has(d))
      .map((d) => (this.overrides.shopDaily ? this.overrides.shopDaily(d, { ...this.data.shopDaily.get(d)! }) : this.data.shopDaily.get(d)!));
    return { apiName, requestId: "fixture", raw: envelope(rows) };
  }

  async getAllCpcAdsHourlyPerformance(_ctx: AdsProviderContext, input: { date: string }) {
    assertVerifiedAdsRequest("shop_hourly", { date: input.date });
    const apiName = this.guard("shop_hourly_performance");
    const date = formatAdsDate(input.date);
    const rows = (hourlyRowsFor(this.data.shopHourly, date, this.data.replayHourly) ?? []).map((r) => (this.overrides.shopHourly ? this.overrides.shopHourly(date, { ...r }) : r));
    return { apiName, requestId: "fixture", raw: envelope(rows) };
  }

  async getProductCampaignHourlyPerformance(_ctx: AdsProviderContext, input: { campaignIds: readonly string[]; date: string }) {
    assertVerifiedAdsRequest("campaign_hourly", { ids: input.campaignIds, date: input.date });
    const apiName = this.guard("campaign_hourly_performance");
    const date = formatAdsDate(input.date);
    const campaign_list = input.campaignIds.map((id) => {
      const common = (this.data.settings.get(id)?.common_info ?? {}) as Obj;
      // like the real API (ADS-1A capture): 24 rows per campaign, zeros for the hours without activity —
      // but only where the captured DAY was zero too; a non-zero day without an hourly capture stays unknown (no rows)
      const daily = this.data.campaignDaily.get(id)?.get(date);
      const dayWasZero = !daily || (Number(daily.expense ?? 0) === 0 && Number(daily.impression ?? 0) === 0);
      const rows = hourlyRowsFor(this.data.campaignHourly.get(id), date, this.data.replayHourly) ?? (dayWasZero ? Array.from({ length: 24 }, (_, hour) => ({ date, ...ZERO_CAMPAIGN_METRICS, hour })) : []);
      return {
        campaign_id: Number(id),
        ad_type: common.ad_type ?? "manual",
        campaign_placement: common.campaign_placement ?? "all",
        ad_name: common.ad_name ?? null,
        metrics_list: rows.map((r) => (this.overrides.campaignHourly ? this.overrides.campaignHourly(id, date, { ...r }) : r)),
      };
    });
    return { apiName, requestId: "fixture", raw: envelope({ region: "VN", campaign_list }) };
  }
}

// ------------------------------------------------------------------ metering (slice API budget + per-endpoint counts)

/** Same read-only surface; every call is counted against the slice budget (ApiCallMeter). */
export class MeteredShopeeAdsProvider implements ShopeeAdsProvider {
  readonly mode: ProviderMode;
  private readonly inner: ShopeeAdsProvider;
  private readonly meter: { track<T>(apiName: string, fn: () => Promise<T>): Promise<T> };

  constructor(inner: ShopeeAdsProvider, meter: { track<T>(apiName: string, fn: () => Promise<T>): Promise<T> }) {
    this.inner = inner;
    this.meter = meter;
    this.mode = inner.mode;
  }

  async listProductLevelCampaignIds(ctx: AdsProviderContext, input: { offset: number; limit: number }) {
    return this.meter.track(ADS_READ_ENDPOINTS.campaign_id_list, () => this.inner.listProductLevelCampaignIds(ctx, input));
  }

  async getProductLevelCampaignSettings(ctx: AdsProviderContext, input: { campaignIds: readonly string[] }) {
    return this.meter.track(ADS_READ_ENDPOINTS.campaign_setting_info, () => this.inner.getProductLevelCampaignSettings(ctx, input));
  }

  async getProductCampaignDailyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; range: AdsDateRange }) {
    return this.meter.track(ADS_READ_ENDPOINTS.campaign_daily_performance, () => this.inner.getProductCampaignDailyPerformance(ctx, input));
  }

  async getAllCpcAdsDailyPerformance(ctx: AdsProviderContext, input: { range: AdsDateRange }) {
    return this.meter.track(ADS_READ_ENDPOINTS.shop_daily_performance, () => this.inner.getAllCpcAdsDailyPerformance(ctx, input));
  }

  async getAllCpcAdsHourlyPerformance(ctx: AdsProviderContext, input: { date: string }) {
    return this.meter.track(ADS_READ_ENDPOINTS.shop_hourly_performance, () => this.inner.getAllCpcAdsHourlyPerformance(ctx, input));
  }

  async getProductCampaignHourlyPerformance(ctx: AdsProviderContext, input: { campaignIds: readonly string[]; date: string }) {
    return this.meter.track(ADS_READ_ENDPOINTS.campaign_hourly_performance, () => this.inner.getProductCampaignHourlyPerformance(ctx, input));
  }
}
