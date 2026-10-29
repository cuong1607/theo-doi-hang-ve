// ============================================================
// SHOPEE-ADS-1B: RealAdsDashboardSource — the dashboard view model from the
// canonical Ads tables (DB only; the page never calls Shopee).
//
// Non-negotiable rules (docs/shopee-ads-data-model.md):
//   * OVERVIEW, previous period and TREND come from
//     shopee_ads_shop_daily_performance — never from Σ campaigns (the shop
//     "all CPC ads" total is larger than the product campaigns' sum).
//   * The CAMPAIGN TABLE comes from shopee_ads_campaigns +
//     shopee_ads_campaign_daily_performance.
//   * "Ngoài chiến dịch sản phẩm" = shop total − Σ campaigns (same range),
//     shown as such, never labelled as a specific ad type.
//   * Ratios are derived from SUMMED primitives (deriveMetrics); CPC = spend /
//     clicks. Missing data stays missing (—), nothing is filled from fixtures.
//   * Monetary values of shops in different regions are never added up.
//
// NUMERIC values arrive from PostgREST as JSON numbers (VND whole đồng) and
// are only converted to plain numbers here, at the view-model boundary.
// No "server-only" marker so integration tests can drive it with a local DB.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays, daysBetween } from "../../../analytics/periods.ts";
import { mapWithConcurrency } from "../../core/time-windows.ts";
import { adsPreviousRange } from "./filters.ts";
import { adsHourlyReconciliation, buildAdsIntraday, loadAdsHourlyReconciliation, loadAdsShopHourly, unavailableIntraday } from "./hourly.ts";
import { mapAdsCampaignStatus, mapAdsCampaignType } from "./mapper.ts";
import { addTotals, deriveMetrics, subtractTotals, ZERO_TOTALS } from "./metrics.ts";
import { ADS_SYNC_TYPES } from "./read-only-policy.ts";
import { AdsDataUnavailableError, type AdsDashboardSource } from "./source.ts";
import { getAdsSyncConfig, shopHour, shopToday } from "./sync.ts";
import type { AdsCampaignRow, AdsCampaignStatus, AdsDashboardData, AdsFilters, AdsIntradayData, AdsMetricValues, AdsSyncStatus, AdsTotals, AdsTrendPoint } from "./view-models.ts";

type Num = number | string | null;
const n = (v: Num): number => (v === null || v === undefined ? 0 : Number(v));

interface ShopRow {
  id: string;
  shop_name: string;
  region: string | null;
  timezone: string | null;
}

interface ShopDailyRow {
  report_date: string;
  expense: Num;
  impression: Num;
  clicks: Num;
  direct_order: Num;
  broad_order: Num;
  direct_gmv: Num;
  broad_gmv: Num;
}

interface CampaignAggRow extends Omit<ShopDailyRow, "report_date"> {
  campaign_id: string;
  shop_id: string;
  provider_campaign_id: string;
  campaign_name: string | null;
  provider_status: string;
  provider_ad_type: string | null;
  provider_bidding_method: string | null;
  provider_placement: string | null;
  daily_budget: Num;
  roas_target: Num;
  item_ids: string[] | null;
  daily: Array<{ d: string; e: Num; g: Num }> | null;
}

export const ADS_SYNC_LABELS: Record<(typeof ADS_SYNC_TYPES)[number], string> = {
  ads_campaign_read: "Danh mục chiến dịch",
  ads_campaign_performance_read: "Hiệu quả chiến dịch",
  ads_shop_performance_read: "Tổng quảng cáo cấp shop",
  ads_shop_hourly_read: "Tổng shop theo giờ",
  ads_campaign_hourly_read: "Chiến dịch theo giờ",
};

const NO_SHOP = "00000000-0000-0000-0000-000000000000";
/** PostgREST max_rows (supabase/config.toml and the cloud default). */
const RPC_PAGE = 1000;

export interface AdsShopFreshness {
  shopId: string;
  shopTodayAt: string | null;
  campaignTodayAt: string | null;
  metadataAt: string | null;
  /** Any Ads read of the shop (WARM included). */
  lastReadAt: string | null;
  activeJobs: number;
  autoEnabled: boolean;
}

/**
 * SHOPEE-ADS-2 freshness targets: when TODAY's shop total / campaign facts
 * and the campaign catalogue were last read (WARM reads never count — they
 * do not include today).
 */
export const ADS_FRESHNESS = [
  { key: "shop_today", syncType: "ads_shop_performance_read", label: "Tổng shop hôm nay", targetMinutes: 20, staleAfterMinutes: 25, pick: (f: AdsShopFreshness) => f.shopTodayAt },
  { key: "campaign_today", syncType: "ads_campaign_performance_read", label: "Chiến dịch hôm nay", targetMinutes: 25, staleAfterMinutes: 35, pick: (f: AdsShopFreshness) => f.campaignTodayAt },
  { key: "metadata", syncType: "ads_campaign_read", label: "Danh mục chiến dịch", targetMinutes: 360, staleAfterMinutes: 480, pick: (f: AdsShopFreshness) => f.metadataAt },
] as const;

/** One RPC round trip, DB only (also used by the page's background polling). */
export async function loadAdsFreshness(db: SupabaseClient, shopIds: string[]): Promise<AdsShopFreshness[]> {
  if (!shopIds.length) return [];
  const { data, error } = await db.rpc("ads_sync_freshness", { p_shop_ids: shopIds });
  if (error) throw new AdsDataUnavailableError(new Error(`ads_sync_freshness: ${error.message}`));
  return ((data ?? []) as Array<{ shop_id: string; shop_today_at: string | null; campaign_today_at: string | null; metadata_at: string | null; last_read_at: string | null; active_jobs: number; auto_enabled: boolean }>).map((r) => ({
    shopId: r.shop_id,
    shopTodayAt: r.shop_today_at,
    campaignTodayAt: r.campaign_today_at,
    metadataAt: r.metadata_at,
    lastReadAt: r.last_read_at,
    activeJobs: Number(r.active_jobs ?? 0),
    autoEnabled: !!r.auto_enabled,
  }));
}

/** Changes whenever any read of the selected shops lands. */
export function adsFreshnessStamp(rows: AdsShopFreshness[]): string | null {
  const all = rows.flatMap((r) => [r.shopTodayAt, r.campaignTodayAt, r.metadataAt, r.lastReadAt]).filter((v): v is string => !!v);
  return all.length ? all.sort().at(-1)! : null;
}

/** Primitive totals of fact rows (shop or campaign). Broad → revenue / orders. */
export function totalsOf(rows: Array<Omit<ShopDailyRow, "report_date">>): AdsTotals {
  return rows.reduce<AdsTotals>(
    (acc, r) =>
      addTotals(acc, {
        spend: n(r.expense),
        revenue: n(r.broad_gmv),
        orders: n(r.broad_order),
        directRevenue: n(r.direct_gmv),
        directOrders: n(r.direct_order),
        clicks: n(r.clicks),
        impressions: n(r.impression),
      }),
    ZERO_TOTALS,
  );
}

const SPARK_KEYS: Array<keyof AdsMetricValues> = [
  "spend", "revenue", "orders", "directRevenue", "directOrders", "clicks", "impressions",
  "roas", "acos", "ctr", "cpc", "conversionRate", "directRoas", "directAcos", "directConversionRate",
];

const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

export class RealAdsDashboardSource implements AdsDashboardSource {
  readonly kind = "shopee" as const;
  private readonly db: SupabaseClient;
  private readonly now: () => Date;

  constructor(db: SupabaseClient, opts: { now?: () => Date } = {}) {
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * PostgREST returns at most 1000 rows per request (also for set-returning
   * RPCs): five shops have ~2000 campaigns, so the result is read in ordered
   * pages — a silently truncated campaign list hid campaigns and inflated
   * "Ngoài chiến dịch sản phẩm".
   */
  private async rpc<T>(fn: string, args: Record<string, unknown>, orderBy: string): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += RPC_PAGE) {
      const { data, error } = await this.db.rpc(fn, args).order(orderBy).range(from, from + RPC_PAGE - 1);
      if (error) throw new AdsDataUnavailableError(new Error(`${fn}: ${error.message}`));
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < RPC_PAGE) return out;
    }
  }

  async load(input: AdsFilters): Promise<AdsDashboardData> {
    const now = this.now();
    const { data: shopData, error: shopError } = await this.db.from("shops").select("id, shop_name, region, timezone").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true).order("shop_name");
    if (shopError) throw new AdsDataUnavailableError(shopError);
    const shops = (shopData ?? []) as ShopRow[];
    const filters: AdsFilters = { ...input, shop: shops.some((s) => s.id === input.shop) ? input.shop : "all" };
    const selected = filters.shop === "all" ? shops : shops.filter((s) => s.id === filters.shop);
    // money of different regions (currencies) is never added up — no FX logic yet
    const regions = new Set(selected.map((s) => (s.region ?? "VN").toUpperCase()));
    if (regions.size > 1) throw new AdsDataUnavailableError(new Error("mixed_regions: chọn từng shop để xem (các shop khác vùng / tiền tệ)."));
    const shopIds = selected.map((s) => s.id);
    const prevRange = adsPreviousRange(filters);

    // three independent reads, bounded fan-out (repo rule: no Promise.all in Shopee code)
    const [curDaily, prevDaily, campaignAgg] = (await mapWithConcurrency<() => Promise<unknown[]>, unknown[]>(
      [
        () => this.rpc<ShopDailyRow>("ads_dashboard_shop_daily", { p_shop_ids: shopIds, p_from: filters.from, p_to: filters.to }, "report_date"),
        () => this.rpc<ShopDailyRow>("ads_dashboard_shop_daily", { p_shop_ids: shopIds, p_from: prevRange.from, p_to: prevRange.to }, "report_date"),
        () => this.rpc<CampaignAggRow>("ads_dashboard_campaigns", { p_shop_ids: shopIds, p_from: filters.from, p_to: filters.to }, "campaign_id"),
      ],
      3,
      (read) => read(),
    )) as [ShopDailyRow[], ShopDailyRow[], CampaignAggRow[]];

    // ---- overview + trend: SHOP-LEVEL facts only
    const current = deriveMetrics(totalsOf(curDaily));
    // "Hôm nay" vs a FULL yesterday would mislead (today is partial, no hourly data stored) → no comparison.
    const previous = deriveMetrics(filters.preset === "today" ? ZERO_TOTALS : totalsOf(prevDaily));
    const byDate = new Map(curDaily.map((r) => [String(r.report_date).slice(0, 10), r]));
    const days = Array.from({ length: Math.max(1, daysBetween(filters.from, filters.to)) }, (_, i) => addDays(filters.from, i));
    const granularity: AdsDashboardData["granularity"] = days.length > 92 ? "week" : "day";
    const buckets: Array<{ key: string; label: string; totals: AdsTotals }> = [];
    if (granularity === "day") {
      for (const d of days) buckets.push({ key: d, label: dayLabel(d), totals: totalsOf(byDate.has(d) ? [byDate.get(d)!] : []) });
    } else {
      for (let i = 0; i < days.length; i += 7) {
        const chunk = days.slice(i, i + 7);
        buckets.push({ key: chunk[0], label: dayLabel(chunk[0]), totals: totalsOf(chunk.flatMap((d) => (byDate.has(d) ? [byDate.get(d)!] : []))) });
      }
    }
    const trend: AdsTrendPoint[] = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      spend: b.totals.spend,
      revenue: b.totals.revenue,
      orders: b.totals.orders,
      directRevenue: b.totals.directRevenue,
      directOrders: b.totals.directOrders,
      clicks: b.totals.clicks,
      roas: b.totals.spend > 0 ? b.totals.revenue / b.totals.spend : null,
    }));
    const sparkRows = buckets.map((b) => deriveMetrics(b.totals));
    const spark = Object.fromEntries(SPARK_KEYS.map((k) => [k, sparkRows.map((m) => m[k] ?? 0)])) as Record<keyof AdsMetricValues, number[]>;

    // ---- campaign table: CAMPAIGN-LEVEL facts only
    const shopName = new Map(shops.map((s) => [s.id, s.shop_name]));
    const dayKeys = new Set(days);
    const allRows: AdsCampaignRow[] = campaignAgg.map((c) => {
      const metrics = deriveMetrics(totalsOf([c]));
      const daily = (c.daily ?? []).map((d) => ({ d: String(d.d).slice(0, 10), e: n(d.e), g: n(d.g) }));
      const budget = c.daily_budget === null ? null : n(c.daily_budget);
      const dailyBudget = budget !== null && budget > 0 ? budget : null; // 0 = meaning unknown → "—"
      const activeDays = daily.filter((d) => d.e > 0).length;
      const items = c.item_ids ?? [];
      const dailyByDate = new Map(daily.map((d) => [d.d, d]));
      return {
        id: c.campaign_id,
        name: c.campaign_name ?? `Chiến dịch #${c.provider_campaign_id}`,
        shopId: c.shop_id,
        shopName: shopName.get(c.shop_id) ?? c.shop_id,
        type: mapAdsCampaignType(c.provider_bidding_method, c.provider_placement),
        status: mapAdsCampaignStatus(c.provider_status),
        provider: { status: c.provider_status, adType: c.provider_ad_type, biddingMethod: c.provider_bidding_method, placement: c.provider_placement, campaignId: c.provider_campaign_id },
        roasTarget: c.roas_target === null ? null : n(c.roas_target),
        dailyBudget,
        // budget of the days the campaign actually spent (daily cap verified)
        periodBudget: dailyBudget !== null && activeDays > 0 ? dailyBudget * activeDays : null,
        metrics,
        trend: granularity === "day" ? days.filter((d) => dayKeys.has(d)).map((d) => ({ label: dayLabel(d), spend: dailyByDate.get(d)?.e ?? 0, revenue: dailyByDate.get(d)?.g ?? 0 })) : [],
        // Shopee reports metrics per CAMPAIGN, not per item: per-product numbers only when the campaign has exactly one item
        topProducts: items.map((itemId) => ({
          name: `Sản phẩm #${itemId}`,
          itemId,
          spend: items.length === 1 ? metrics.spend : null,
          revenue: items.length === 1 ? metrics.revenue : null,
          orders: items.length === 1 ? metrics.orders : null,
        })),
      } satisfies AdsCampaignRow;
    });
    // same listing rule as the fixture: a campaign with no activity in the period is hidden unless running
    const typed = allRows.filter((r) => (filters.type === "all" || r.type === filters.type) && (r.metrics.spend > 0 || r.metrics.impressions > 0 || r.status === "active"));
    const campaigns = filters.status === "all" ? typed : typed.filter((r) => r.status === filters.status);
    const statusCounts: Record<AdsCampaignStatus | "all", number> = { all: typed.length, active: 0, paused: 0, ended: 0, closed: 0, warning: 0, unknown: 0 };
    for (const r of typed) statusCounts[r.status]++;

    // ---- shop total − Σ ALL product campaigns (whatever the table filters)
    const campaignTotals = totalsOf(campaignAgg);
    const outsideProductCampaigns = curDaily.length > 0 ? deriveMetrics(subtractTotals(totalsOf(curDaily), campaignTotals)) : null;

    return {
      filters,
      previousRange: prevRange,
      granularity,
      shops: shops.map((s) => ({ id: s.id, name: s.shop_name })),
      overview: { current, previous, spark, budget: 0, outsideProductCampaigns },
      trend,
      campaigns,
      statusCounts,
      insights: [],
      sync: await this.syncStatus(shopIds, selected, filters, now),
      intraday: await this.intraday(shopIds, selected, now),
      generatedAt: now.toISOString(),
    };
  }

  /**
   * ADS-3A.1 "Hôm nay theo giờ": shop hourly rows of today (+ yesterday for the
   * same-hour comparison and the completed-day reconciliation). DB only.
   * Never breaks the dashboard: an unreadable hourly layer (e.g. code deployed
   * before migration 00067) shows "unavailable", nothing is synthesized.
   */
  private async intraday(shopIds: string[], selected: ShopRow[], now: Date): Promise<AdsIntradayData> {
    const config = getAdsSyncConfig();
    const tz = selected[0]?.timezone || "Asia/Ho_Chi_Minh";
    const today = shopToday(now, tz);
    const yesterday = addDays(today, -1);
    const currentHour = shopHour(now, tz);
    try {
      const { data: settings, error: settingsError } = await this.db.from("shopee_ads_shop_settings").select("shop_id, ads_hourly_enabled").in("shop_id", shopIds.length ? shopIds : [NO_SHOP]);
      if (settingsError) throw settingsError;
      const enabled = ((settings ?? []) as Array<{ shop_id: string; ads_hourly_enabled: boolean }>).filter((s) => s.ads_hourly_enabled).length;
      const rows = await loadAdsShopHourly(this.db, shopIds, { from: yesterday, to: today });
      // freshness per shop with rows today (≤ 24 rows per shop: one page for any realistic shop count)
      const { data: synced, error: syncedError } = await this.db.from("shopee_ads_shop_hourly_performance").select("shop_id, last_synced_at").in("shop_id", shopIds.length ? shopIds : [NO_SHOP]).eq("report_date", today).order("last_synced_at", { ascending: false }).range(0, RPC_PAGE - 1);
      if (syncedError) throw syncedError;
      const latest = new Map<string, string>();
      for (const r of (synced ?? []) as Array<{ shop_id: string; last_synced_at: string }>) if (!latest.has(r.shop_id)) latest.set(r.shop_id, r.last_synced_at);
      const recon = (await loadAdsHourlyReconciliation(this.db, shopIds, { from: yesterday, to: yesterday })).map((r) => adsHourlyReconciliation(r, today));
      return buildAdsIntraday({
        today,
        yesterday,
        currentHour,
        rows,
        shops: { selected: shopIds.length, enabled },
        lastSyncedByShop: [...latest.values()],
        reconciliation: recon,
        now,
        freshTargetMinutes: config.hourlyFreshTargetMinutes,
        staleMinutes: config.hourlyStaleMinutes,
      });
    } catch (err) {
      console.warn(JSON.stringify({ source: "ads-dashboard", event: "intraday_unavailable", message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) }));
      return unavailableIntraday(today, currentHour, config.hourlyFreshTargetMinutes, config.hourlyStaleMinutes);
    }
  }

  private async syncStatus(shopIds: string[], selected: ShopRow[], filters: AdsFilters, now: Date): Promise<AdsSyncStatus> {
    const fresh = await loadAdsFreshness(this.db, shopIds);
    const { data: states, error } = await this.db.from("channel_sync_states").select("shop_id, sync_type, last_success_at, last_failure_at, last_error_message").in("shop_id", shopIds.length ? shopIds : [NO_SHOP]).in("sync_type", [...ADS_SYNC_TYPES]);
    const { data: latest, error: latestError } = await this.db.from("shopee_ads_shop_daily_performance").select("report_date").in("shop_id", shopIds.length ? shopIds : [NO_SHOP]).order("report_date", { ascending: false }).limit(1);
    if (error || latestError) throw new AdsDataUnavailableError(error ?? latestError);
    const rows = (states ?? []) as Array<{ shop_id: string; sync_type: string; last_success_at: string | null; last_failure_at: string | null; last_error_message: string | null }>;
    // shops that were synced at least once (a never-synced shop does not make the others look stale)
    const synced = fresh.filter((f) => f.shopTodayAt || f.campaignTodayAt || f.metadataAt);
    const stalest = (pick: (f: AdsShopFreshness) => string | null) => {
      const v = synced.map(pick);
      return v.length === 0 || v.some((x) => !x) ? (v.filter(Boolean).sort()[0] ?? null) : (v as string[]).sort()[0];
    };
    const details = ADS_FRESHNESS.map((d) => {
      const at = stalest(d.pick);
      const failed = rows.filter((r) => r.sync_type === d.syncType && r.last_failure_at && (!r.last_success_at || r.last_failure_at > r.last_success_at));
      return {
        key: d.key,
        label: d.label,
        lastSuccessAt: at,
        lastErrorAt: failed.map((r) => r.last_failure_at!).sort().at(-1) ?? null,
        errorMessage: failed[0]?.last_error_message ?? null,
        targetMinutes: d.targetMinutes,
        staleAfterMinutes: d.staleAfterMinutes,
        stale: !at || now.getTime() - Date.parse(at) > d.staleAfterMinutes * 60_000,
      };
    });
    const today = shopToday(now, selected[0]?.timezone || "Asia/Ho_Chi_Minh");
    const anySuccess = synced.length > 0;
    const enabledShops = fresh.filter((f) => f.autoEnabled).length;
    return {
      state: !anySuccess ? "never" : details.some((d) => d.lastErrorAt) ? "error" : details.some((d) => d.stale) ? "stale" : "fresh",
      // headline freshness = today's SHOP total (the overview's source)
      lastSyncedAt: details[0].lastSuccessAt ?? details.map((d) => d.lastSuccessAt).filter(Boolean).sort().at(-1) ?? null,
      source: "shopee",
      details,
      stamp: adsFreshnessStamp(fresh),
      autoSync: { enabled: enabledShops > 0, enabledShops, shops: shopIds.length },
      todayPartial: filters.to >= today,
      reportThrough: ((latest ?? []) as Array<{ report_date: string }>)[0]?.report_date ?? null,
    };
  }
}
