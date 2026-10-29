import Link from "next/link";
import { notFound } from "next/navigation";
import { Activity, Gauge, Lightbulb, Link2, ListOrdered, Trophy, Unplug } from "lucide-react";

import { hasPermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { formatAdsRange, parseAdsDemo, parseAdsFilters, parseAdsTableQuery, queryCampaigns } from "@/lib/channels/shopee/ads/filters";
import { adsDeltaPercent } from "@/lib/channels/shopee/ads/metrics";
import { AdsDataUnavailableError, FixtureAdsDashboardSource } from "@/lib/channels/shopee/ads/source";
import { RealAdsDashboardSource } from "@/lib/channels/shopee/ads/real-source";
import { loadAdsSyncOverview, type AdsShopSyncOverview } from "@/lib/channels/shopee/ads/schedule";
import { getAdsSyncConfig } from "@/lib/channels/shopee/ads/sync";
import { AdsAutoSyncPanel } from "@/components/ads/ads-auto-sync-panel";
import { formatDateTime } from "@/lib/ui/format";
import { AdsAttributionPanel } from "@/components/ads/ads-attribution-panel";
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

// SHOPEE-ADS-UI-1 / 1B: the Ads dashboard. Data comes from an AdsDashboardSource:
//   SHOPEE_ADS_DATA_SOURCE=fixture (default)  FixtureAdsDashboardSource
//     (?demo=empty|error|unsynced|large|slow switches fixture states for QA)
//   SHOPEE_ADS_DATA_SOURCE=real               RealAdsDashboardSource — canonical
//     Ads tables only (DB); "Làm mới dữ liệu" enqueues read-only sync jobs.
// The page never calls Shopee and the Ads module never writes to Shopee.
export default async function ShopeeAdsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const flags = getShopeeFlags();
  if (!flags.adsEnabled) notFound();
  const auth = await requirePermission("channel:view");
  const sp = await searchParams;
  const filters = parseAdsFilters(sp);
  const table = parseAdsTableQuery(sp);
  const real = flags.adsDataSource === "real";
  const demo = real ? null : parseAdsDemo(sp);
  const canManage = hasPermission(auth.profile.role, "channel:manage");
  const serverNow = new Date().toISOString();

  let data: AdsDashboardData | null = null;
  try {
    data = await (real ? new RealAdsDashboardSource(createAdminClient()) : new FixtureAdsDashboardSource({ scenario: demo })).load(filters);
  } catch (e) {
    if (!(e instanceof AdsDataUnavailableError)) throw e;
    console.warn(JSON.stringify({ source: "ads-dashboard", event: "load_failed", message: e.cause instanceof Error ? e.cause.message.slice(0, 200) : null }));
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
  const sync = data?.sync ?? { state: "error" as const, lastSyncedAt: null, source: real ? ("shopee" as const) : ("fixture" as const) };
  // SHOPEE-ADS-2: background sync per shop (admins) — DB only
  let autoSync: AdsShopSyncOverview[] | null = null;
  if (real && canManage) {
    try {
      autoSync = await loadAdsSyncOverview(createAdminClient());
    } catch (e) {
      console.warn(JSON.stringify({ source: "ads-dashboard", event: "auto_sync_overview_failed", message: e instanceof Error ? e.message.slice(0, 200) : null }));
    }
  }

  return (
    <AdsRefreshProvider mode={real ? "real" : "fixture"} shop={data?.filters.shop ?? filters.shop} stamp={data?.sync.stamp ?? null}>
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
                description={real ? "Chưa có dữ liệu quảng cáo nào trong hệ thống. Bấm “Làm mới dữ liệu” để đồng bộ (chỉ đọc) từ Shopee Ads." : "Chưa có dữ liệu quảng cáo nào được đồng bộ. Kiểm tra kết nối shop để sẵn sàng khi đồng bộ Ads được bật."}
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
          <Dashboard data={data} table={table} query={query} real={real} />
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
          {real ? (
            <div className="mt-3 space-y-2" data-slot="ads-freshness">
              <ul className="grid gap-2 text-xs sm:grid-cols-3">
                {(sync.details ?? []).map((d) => (
                  <li key={d.key} data-freshness={d.key} data-stale={d.stale ? "true" : "false"} className="rounded-lg border border-ads-border bg-ads-surface px-3 py-2">
                    <p className="font-medium">
                      {d.label}
                      {d.stale && d.lastSuccessAt ? <span className="ml-1.5 text-warning-text">· chưa mới</span> : null}
                    </p>
                    <p className="text-muted-foreground tabular-nums">{d.lastSuccessAt ? `Đọc lúc ${formatDateTime(d.lastSuccessAt)}` : "Chưa đồng bộ"}</p>
                    {d.targetMinutes ? <p className="text-ads-muted">Mục tiêu ≤ {d.targetMinutes >= 60 ? `${d.targetMinutes / 60} giờ` : `${d.targetMinutes} phút`}</p> : null}
                    {d.lastErrorAt && <p className="text-danger-text">Lỗi lúc {formatDateTime(d.lastErrorAt)}{d.errorMessage ? ` — ${d.errorMessage.slice(0, 120)}` : ""}</p>}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ads-muted">
                Dữ liệu thật từ Shopee Ads (chỉ đọc){sync.reportThrough ? ` · có số liệu đến ngày ${formatAdsRange(sync.reportThrough, sync.reportThrough)}` : ""}.{" "}
                {sync.autoSync?.enabled ? "Đồng bộ nền tự động ~15 phút/lần, không cần mở trang." : "Chưa bật đồng bộ nền cho shop này — dữ liệu chỉ cập nhật khi bấm “Làm mới dữ liệu”."} Tổng quan lấy từ tổng quảng cáo cấp shop; bảng chiến dịch lấy từ từng chiến dịch sản phẩm.
              </p>
              {autoSync ? <AdsAutoSyncPanel rows={autoSync} globalEnabled={getAdsSyncConfig().autoSyncEnabled} serverNow={serverNow} /> : null}
            </div>
          ) : (
            <p className="mt-3 rounded-lg border border-dashed border-ads-border bg-ads-surface px-3 py-2 text-xs text-ads-muted">
              Đang hiển thị <strong className="font-medium">dữ liệu mẫu</strong> để hoàn thiện giao diện. Đồng bộ Ads thật được bật bằng cấu hình SHOPEE_ADS_DATA_SOURCE=real.
            </p>
          )}
        </AdsSection>
      </div>
    </AdsRefreshProvider>
  );
}

function Dashboard({ data, table, query, real }: { data: AdsDashboardData; table: ReturnType<typeof parseAdsTableQuery>; query: Record<string, string | undefined>; real: boolean }) {
  const { current: cur, previous: prev, spark, budget } = data.overview;
  const revenueDelta = adsDeltaPercent(cur.revenue, prev.revenue);
  const paged = queryCampaigns(data.campaigns, table);

  return (
    <>
      {data.sync.todayPartial && (
        <p role="status" data-slot="ads-today-partial" className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning-text">
          Hôm nay — dữ liệu có thể chưa hoàn tất{real && data.filters.preset === "today" ? " (không so sánh với cả ngày hôm qua)" : ""}.
        </p>
      )}
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
        {real ? (
          // real data: no demo insights — Broad vs Direct + the shop-vs-campaigns remainder instead
          <AdsSection id="ads-attribution" title="Broad & Direct" description="Cách Shopee quy doanh số cho quảng cáo" icon={Lightbulb} iconClass="bg-ads-secondary/12 text-ads-secondary-text" delay={190}>
            <AdsAttributionPanel current={cur} outside={data.overview.outsideProductCampaigns} />
          </AdsSection>
        ) : (
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
        )}
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
