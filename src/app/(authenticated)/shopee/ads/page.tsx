import Link from "next/link";
import { notFound } from "next/navigation";
import { Activity, Gauge, Lightbulb, Link2, ListOrdered, Trophy, Unplug } from "lucide-react";

import { hasPermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { formatAdsRange, parseAdsDemo, parseAdsFilters, parseAdsTableQuery, queryCampaigns } from "@/lib/channels/shopee/ads/filters";
import { adsDeltaPercent } from "@/lib/channels/shopee/ads/metrics";
import { AdsDataUnavailableError, FixtureAdsDashboardSource } from "@/lib/channels/shopee/ads/source";
import type { AdsDashboardData } from "@/lib/channels/shopee/ads/view-models";
import { getShopeeFlags } from "@/lib/feature-flags";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdsCampaignTable } from "@/components/ads/ads-campaign-table";
import { AdsBudgetUsage, AdsEfficiencyCard } from "@/components/ads/ads-efficiency-card";
import { AdsFilterBar } from "@/components/ads/ads-filter-bar";
import { AdsInsightCard } from "@/components/ads/ads-insight-card";
import { AdsHeroMetric, AdsMetricCard } from "@/components/ads/ads-metric-card";
import { AdsPageHeader } from "@/components/ads/ads-page-header";
import { AdsRefreshProvider, AdsSyncStatus } from "@/components/ads/ads-refresh";
import { AdsSection } from "@/components/ads/ads-section";
import { AdsErrorState } from "@/components/ads/ads-error-state";
import { AdsEmptyState } from "@/components/ads/ads-states";
import { AdsTopCampaigns } from "@/components/ads/ads-top-campaigns";
import { AdsTrendChart } from "@/components/ads/ads-trend-chart";

export const dynamic = "force-dynamic";

const PATH = "/shopee/ads";
const QUERY_KEYS = ["period", "from", "to", "shop", "status", "type", "q", "sort", "dir", "demo"] as const;

/** Secondary KPI cards, in display order (ROAS is the hero card). */
const CARDS = ["spend", "revenue", "orders", "clicks", "impressions", "ctr", "cpc", "acos"] as const;

// SHOPEE-ADS-UI-1: the Ads dashboard. Data comes from an AdsDashboardSource —
// FIXTURE ONLY in this phase (no Shopee Ads API call, no Ads tables).
// ?demo=empty|error|unsynced|large|slow switches fixture states for QA.
export default async function ShopeeAdsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!getShopeeFlags().adsEnabled) notFound();
  const auth = await requirePermission("channel:view");
  const sp = await searchParams;
  const filters = parseAdsFilters(sp);
  const table = parseAdsTableQuery(sp);
  const demo = parseAdsDemo(sp);
  const canManage = hasPermission(auth.profile.role, "channel:manage");
  const serverNow = new Date().toISOString();

  let data: AdsDashboardData | null = null;
  try {
    data = await new FixtureAdsDashboardSource({ scenario: demo }).load(filters);
  } catch (e) {
    if (!(e instanceof AdsDataUnavailableError)) throw e;
  }

  // Real connection state (shared OAuth) — the one live fact on this page.
  const { data: conns } = await createAdminClient()
    .from("shops")
    .select("id, shop_connections(connection_status)")
    .eq("channel", "shopee")
    .eq("data_source", "live")
    .eq("is_active", true);
  const liveShops = (conns ?? []) as Array<{ id: string; shop_connections: Array<{ connection_status: string }> | null }>;
  const connectedShops = liveShops.filter((s) => s.shop_connections?.[0]?.connection_status === "connected").length;

  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const query = Object.fromEntries(QUERY_KEYS.map((k) => [k, one(sp[k])]));
  const sync = data?.sync ?? { state: "error" as const, lastSyncedAt: null, source: "fixture" as const };

  return (
    <AdsRefreshProvider>
      <div data-ads-root className="space-y-5">
        <AdsPageHeader preset={filters.preset} rangeLabel={formatAdsRange(filters.from, filters.to)} canManage={canManage} sync={sync} serverNow={serverNow} />

        <div className="animate-ads-rise" style={{ "--ads-delay": "50ms" } as React.CSSProperties}>
          <AdsFilterBar filters={filters} shops={data?.shops ?? []} />
        </div>

        {!data ? (
          <AdsErrorState />
        ) : data.statusCounts.all === 0 && !table.q ? (
          <AdsSection title="Tổng quan" icon={Activity} delay={100}>
            {data.sync.state === "never" ? (
              <AdsEmptyState
                icon={Unplug}
                title="Chưa đồng bộ Ads"
                description="Chưa có dữ liệu quảng cáo nào được đồng bộ. Kiểm tra kết nối shop để sẵn sàng khi đồng bộ Ads được bật."
                action={
                  <Link href="/settings/shopee" className="inline-flex h-8 items-center rounded-full border border-ads-border bg-card px-3 text-sm font-medium hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                    Kiểm tra kết nối
                  </Link>
                }
              />
            ) : (
              <AdsEmptyState
                description="Thử chọn khoảng thời gian dài hơn hoặc bỏ bớt bộ lọc shop / loại chiến dịch."
                action={
                  <Link href={`${PATH}?period=30d${demo ? `&demo=${demo}` : ""}`} scroll={false} className="inline-flex h-8 items-center rounded-full border border-ads-border bg-card px-3 text-sm font-medium hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                    Đổi khoảng thời gian
                  </Link>
                }
              />
            )}
          </AdsSection>
        ) : (
          <Dashboard data={data} table={table} query={query} />
        )}

        <AdsSection
          id="ads-sync"
          title="Nguồn dữ liệu & kết nối"
          icon={Link2}
          iconClass="bg-ads-accent/12 text-ads-accent-text"
          delay={300}
          actions={
            canManage ? (
              <Link href="/settings/shopee" className="text-sm font-medium text-ads-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                Quản lý kết nối
              </Link>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <AdsSyncStatus sync={sync} serverNow={serverNow} />
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">{connectedShops}</span> / {liveShops.length} shop Shopee đang kết nối (OAuth dùng chung, token tự làm mới).
            </p>
          </div>
          <p className="mt-3 rounded-lg border border-dashed border-ads-border bg-ads-surface px-3 py-2 text-xs text-ads-muted">
            Đang hiển thị <strong className="font-medium">dữ liệu mẫu</strong> để hoàn thiện giao diện — chưa gọi Shopee Ads API. Số liệu thật sẽ có khi đồng bộ Ads được bật (SHOPEE-ADS-1).
          </p>
        </AdsSection>
      </div>
    </AdsRefreshProvider>
  );
}

function Dashboard({ data, table, query }: { data: AdsDashboardData; table: ReturnType<typeof parseAdsTableQuery>; query: Record<string, string | undefined> }) {
  const { current: cur, previous: prev, spark, budget } = data.overview;
  const revenueDelta = adsDeltaPercent(cur.revenue, prev.revenue);
  const paged = queryCampaigns(data.campaigns, table);

  return (
    <>
      <section aria-label="Chỉ số chính" data-refresh-dim className="grid gap-3 transition-opacity duration-(--ads-dur-normal) sm:grid-cols-2 lg:grid-cols-4">
        <AdsHeroMetric value={cur.roas} previous={prev.roas} spark={spark.roas} revenue={cur.revenue} spend={cur.spend} className="sm:col-span-2 lg:row-span-2" />
        {/* Mobile: swipeable snap row; tablet: 2-col grid; desktop: joins the parent grid. */}
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:col-span-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:contents">
          {CARDS.map((k, i) => (
            <AdsMetricCard
              key={k}
              metric={k}
              value={cur[k]}
              previous={prev[k]}
              spark={spark[k]}
              revenueDelta={k === "spend" ? revenueDelta : undefined}
              delay={80 + i * 25}
              className="w-[72%] shrink-0 snap-start sm:w-auto"
            />
          ))}
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-3">
        <AdsSection id="ads-trend" title="Xu hướng hiệu quả" description={data.granularity === "hour" ? "Theo giờ" : data.granularity === "week" ? "Theo tuần" : "Theo ngày"} icon={Activity} delay={150} className="xl:col-span-2">
          <AdsTrendChart points={data.trend} granularity={data.granularity} />
        </AdsSection>
        <AdsSection id="ads-insights" title="Gợi ý & cảnh báo" description="Gợi ý mẫu — chưa phải hệ thống khuyến nghị" icon={Lightbulb} iconClass="bg-ads-secondary/12 text-ads-secondary-text" delay={190}>
          {data.insights.length === 0 ? (
            <AdsEmptyState compact title="Không có gì cần chú ý." description="Các chỉ số đang ổn định so với kỳ trước." />
          ) : (
            <ul className="space-y-2.5">
              {data.insights.map((ins, i) => (
                <AdsInsightCard key={ins.id} insight={ins} delay={220 + i * 40} />
              ))}
            </ul>
          )}
        </AdsSection>
      </div>

      <AdsSection id="ads-campaigns" title="Tổng quan chiến dịch" description={`${data.statusCounts.all} chiến dịch có hoạt động trong kỳ`} icon={ListOrdered} delay={220}>
        <AdsCampaignTable
          rows={paged.rows}
          total={paged.total}
          page={paged.page}
          size={table.size}
          sort={table.sort}
          desc={table.desc}
          q={table.q}
          status={data.filters.status}
          statusCounts={data.statusCounts}
          pathname={PATH}
          query={query}
        />
      </AdsSection>

      <div className="grid gap-5 xl:grid-cols-2">
        <AdsSection id="ads-top" title="Chiến dịch nổi bật" icon={Trophy} iconClass="bg-metric-cpc/14 text-metric-cpc-text" delay={250}>
          <AdsTopCampaigns rows={data.campaigns} pathname={PATH} query={query} />
        </AdsSection>
        <AdsSection id="ads-efficiency" title="Hiệu quả" description="So với mục tiêu tham khảo" icon={Gauge} iconClass="bg-metric-roas/12 text-metric-roas-text" delay={280}>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <AdsEfficiencyCard metric="roas" value={cur.roas} delay={300} />
            <AdsEfficiencyCard metric="acos" value={cur.acos} delay={330} />
            <AdsEfficiencyCard metric="ctr" value={cur.ctr} delay={360} />
            <AdsEfficiencyCard metric="cpc" value={cur.cpc} delay={390} />
            <AdsEfficiencyCard metric="conversionRate" value={cur.conversionRate} delay={420} />
            <AdsBudgetUsage spend={cur.spend} budget={budget} />
          </div>
        </AdsSection>
      </div>
    </>
  );
}
