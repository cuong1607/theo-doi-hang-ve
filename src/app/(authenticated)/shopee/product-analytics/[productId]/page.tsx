import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Camera, Gauge, History, LineChart, Megaphone, ShieldCheck, ShoppingBag, Sparkles } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { getShopeeFlags } from "@/lib/feature-flags";
import { daysBetween } from "@/lib/analytics/periods";
import { salesCoverageNote } from "@/lib/product-analytics/coverage";
import { PRODUCT_METRIC_META } from "@/lib/product-analytics/data-quality";
import { BROAD_GMV_TOOLTIP, salesAvailability } from "@/lib/product-analytics/display";
import { loadBaselineWindows } from "@/lib/product-analytics/intelligence";
import { loadProductDetail, resolveProductById, timedRead } from "@/lib/product-analytics/read-model";
import { parseProductAnalyticsQuery, productAnalyticsHref } from "@/lib/product-analytics/url-state";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdsProductThumb } from "@/components/ads/ads-product-thumb";
import { AdsSection } from "@/components/ads/ads-section";
import { AdsEmptyState } from "@/components/ads/ads-states";
import { HealthBadge, PriorityPill } from "@/components/product-analytics/pa-badges";
import { PaAdsGrid, PaBaselinePanel, PaDataQualityPanel, PaSignalPanel, PaSnapshotPanel } from "@/components/product-analytics/pa-detail-panels";
import { PaKpiCard } from "@/components/product-analytics/pa-kpi-card";
import { PaNotice } from "@/components/product-analytics/pa-notice";
import { PaPageHeader } from "@/components/product-analytics/pa-page-header";
import { productStatusLabel } from "@/components/product-analytics/pa-product-list";
import { PaTrendChart } from "@/components/product-analytics/pa-trend-chart";

export const dynamic = "force-dynamic";

const PATH = "/shopee/product-analytics";

// PRODUCT-ANALYTICS-3: one product — health + factual signals (with evidence),
// sales (order facts), Ads (single-item campaigns, Ads visual language),
// combined trend, baseline, current Shopee snapshot, data quality.
// DB only (0 Shopee calls); no AI diagnosis, no cause inferred.
export default async function ProductAnalyticsDetailPage({ params, searchParams }: { params: Promise<{ productId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!getShopeeFlags().adsEnabled) notFound();
  await requirePermission("channel:view");
  const { productId } = await params;
  const sp = await searchParams;
  const db = createAdminClient();
  const ref = await resolveProductById(db, productId);
  if (!ref) notFound();
  const state = parseProductAnalyticsQuery(sp);
  const p = state.period;
  const [{ value: detail, ms: queryMs }, { data: shop }] = await Promise.all([
    timedRead(() => loadProductDetail(db, ref, p)),
    db.from("shops").select("shop_name").eq("id", ref.shopId).maybeSingle<{ shop_name: string }>(),
  ]);
  if (!detail) notFound();
  const { summary: s, daily, quality: q, intel } = detail;
  const row = intel.row;
  const i = row.intel;
  const cov = q.sales_coverage;
  const baseline = await loadBaselineWindows(db, ref, p, cov.covered_from);
  const hasAds = s.ads.single_item_campaigns > 0;
  const av = salesAvailability(row);
  const status = productStatusLabel(s.identity.provider_status);
  const backHref = productAnalyticsHref(PATH, { period: p.preset === "7d" ? undefined : p.preset, from: p.preset === "custom" ? p.from : undefined, to: p.preset === "custom" ? p.to : undefined }, {});
  const coverageNote = salesCoverageNote(cov);
  const salesUnavailable =
    av === "no_data" ? "Chưa có dữ liệu đơn hàng" : av === "lower_bound" ? "Chưa đủ dữ liệu — mức tối thiểu" : p.partialToday && !q.same_time_comparison.sales_available ? "Chưa có giờ hoàn tất để so sánh" : "Kỳ so sánh chưa có dữ liệu đầy đủ";
  const adsUnavailable = q.same_time_comparison.ads_available ? undefined : "Chưa có Ads theo giờ của kỳ so sánh";
  const days = daysBetween(p.from, p.to);

  return (
    <div data-ads-root className="space-y-5">
      <Link href={backHref} className="inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
        <ArrowLeft aria-hidden="true" className="size-4" /> Danh sách sản phẩm
      </Link>

      <PaPageHeader
        icon={false}
        title={
          <span className="flex items-start gap-3">
            <AdsProductThumb src={s.identity.image_url} alt={s.identity.name ?? ""} size="lg" className="size-14" />
            <span className="min-w-0">
              <span className="line-clamp-2 text-xl leading-snug sm:text-2xl">{s.identity.name ?? `Sản phẩm #${s.identity.provider_item_id}`}</span>
            </span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <HealthBadge label={i.health.label} size="md" />
            <PriorityPill priority={i.priority} />
            <span>{shop?.shop_name ?? ""}</span>
            <span>· Item {s.identity.provider_item_id}</span>
            {s.identity.sku && <span>· SKU {s.identity.sku}</span>}
            {status && <span className="rounded-full bg-danger-soft px-2 text-xs text-danger-text">{status}</span>}
          </span>
        }
        preset={p.preset}
        rangeLabel={p.from === p.to ? p.from : `${p.from} → ${p.to}`}
        compareLabel={p.prevFrom === p.prevTo ? p.prevFrom : `${p.prevFrom} → ${p.prevTo}`}
        scopeLabel={`${queryMs} ms`}
        salesAgeMinutes={intel.shop.sales_age_minutes}
        salesStale={intel.shop.sales_state !== "no_data" && intel.shop.sales_stale}
        adsAgeMinutes={hasAds ? intel.shop.ads_age_minutes : null}
        partialToday={p.partialToday}
        hourCutoff={p.hourCutoff}
      />

      {coverageNote && (
        <PaNotice tone={cov.state === "covered" ? "info" : "warning"} title={cov.state === "covered" ? "Kỳ so sánh chưa có dữ liệu" : "Doanh số chưa đầy đủ"} icon={History}>
          {coverageNote}
        </PaNotice>
      )}

      <section aria-label="Chỉ số chính" className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-5" data-slot="pa-detail-kpis">
        <PaKpiCard label="Doanh số" look="revenue" metric="sales_gmv" delta={s.sales.gmv} availability={av} comparable={row.sales_comparable} unavailableText={salesUnavailable} tooltip={PRODUCT_METRIC_META.sales_gmv.note} delay={40} className="w-[72%] shrink-0 snap-start sm:w-auto" />
        <PaKpiCard label="Đơn hàng" look="orders" metric="orders" delta={s.sales.orders} availability={av} comparable={row.sales_comparable} unavailableText={salesUnavailable} tooltip={PRODUCT_METRIC_META.orders.note} delay={65} className="w-[72%] shrink-0 snap-start sm:w-auto" />
        <PaKpiCard label="Số lượng bán" look="orders" metric="units" delta={s.sales.units} availability={av} comparable={row.sales_comparable} unavailableText={salesUnavailable} tooltip={PRODUCT_METRIC_META.units.note} delay={90} className="w-[72%] shrink-0 snap-start sm:w-auto" />
        <PaKpiCard label="Chi Ads" look="spend" metric="ads_spend" delta={s.ads.spend} comparable={hasAds && row.ads_comparable} unavailableText={hasAds ? adsUnavailable : "Không có campaign riêng"} tooltip={PRODUCT_METRIC_META.ads_spend.note} delay={115} className="w-[72%] shrink-0 snap-start sm:w-auto" />
        <PaKpiCard label="ROAS Broad" look="roas" metric="ads_broad_roas" delta={s.ads.broad_roas} comparable={hasAds && row.ads_comparable} unavailableText={hasAds ? adsUnavailable : "Không có campaign riêng"} tooltip={`Broad GMV ÷ chi (tổng / tổng). ${BROAD_GMV_TOOLTIP}`} delay={140} className="w-[72%] shrink-0 snap-start sm:w-auto" />
      </section>

      <AdsSection id="pa-signals" title="Tín hiệu đáng chú ý" description="Quan sát so với kỳ trước — không phải nguyên nhân" icon={Sparkles} iconClass="bg-ads-secondary/12 text-ads-secondary-text" delay={120}>
        <PaSignalPanel intel={i} ctx={intel.shop_context} />
      </AdsSection>

      <AdsSection id="pa-trend" title="Xu hướng theo ngày" description="Doanh số (đơn hàng), chi Ads và Broad GMV (attribution) — chọn đường để xem" icon={LineChart} delay={160}>
        <PaTrendChart rows={daily} salesCoveredFrom={cov.covered_from} hasAds={hasAds} />
      </AdsSection>

      <AdsSection id="pa-sales" title="Doanh số so với nền lịch sử" description={`Trung bình mỗi ngày của kỳ này so với 7 / 30 ngày trước đó · ${PRODUCT_METRIC_META.sales_gmv.note}`} icon={ShoppingBag} iconClass="bg-metric-revenue/12 text-metric-revenue-text" delay={190}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="flex flex-col gap-2.5">
            <PaKpiCard label="Đơn đã hủy (không tính)" look="acos" metric="cancelled_orders" delta={s.sales.cancelled_orders} availability={av} comparable={row.sales_comparable} unavailableText={salesUnavailable} tooltip="Đơn đã hủy được giữ lại để đối chiếu nhưng không tính vào doanh số." />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Gauge aria-hidden="true" className="size-3.5" /> {s.sales.fact_lines.toLocaleString("vi-VN")} dòng đơn trong kỳ
            </p>
          </div>
          <PaBaselinePanel windows={baseline} current={{ sales_gmv: av === "complete" ? row.gmv : null, orders: av === "complete" ? row.orders : null, ads_spend: row.spend }} days={days} partial={p.partialToday} />
        </div>
      </AdsSection>

      <AdsSection
        id="pa-ads"
        title="Quảng cáo"
        description={hasAds ? `${s.ads.single_item_campaigns} campaign chỉ quảng cáo sản phẩm này${s.ads.shared_campaigns_excluded ? ` · ${s.ads.shared_campaigns_excluded} campaign nhiều sản phẩm không được tính` : ""} · tỷ lệ = tổng / tổng` : "Không có campaign quảng cáo riêng"}
        icon={Megaphone}
        iconClass="bg-metric-spend/12 text-metric-spend-text"
        delay={230}
      >
        {hasAds ? (
          <PaAdsGrid ads={s.ads} comparable={row.ads_comparable} salesExact={av === "complete"} />
        ) : (
          <AdsEmptyState compact icon={Megaphone} title="Sản phẩm này không có campaign quảng cáo riêng." description={s.ads.shared_campaigns_excluded ? "Sản phẩm nằm trong campaign nhiều sản phẩm — chi phí của campaign đó không chia được cho từng sản phẩm." : "Doanh số ở trên là toàn bộ từ đơn hàng."} />
        )}
      </AdsSection>

      <div className="grid gap-5 xl:grid-cols-2">
        <AdsSection id="pa-snapshot" title="Ảnh chụp hiện tại từ Shopee" description="Ý nghĩa lịch sử của các bộ đếm này chưa được xác minh — không vẽ xu hướng" icon={Camera} iconClass="bg-ads-accent/12 text-ads-accent-text" delay={250}>
          <PaSnapshotPanel snapshot={s.snapshot} />
        </AdsSection>
        <AdsSection id="pa-quality" title="Chất lượng dữ liệu" description="Độ mới, độ phủ để so sánh, ngày chưa hoàn tất" icon={ShieldCheck} iconClass="bg-success-soft text-success-text" delay={270}>
          <PaDataQualityPanel intel={i} detail={intel} partialToday={p.partialToday} hourCutoff={p.hourCutoff} snapshotAt={s.snapshot?.captured_at ?? null} />
        </AdsSection>
      </div>
    </div>
  );
}
