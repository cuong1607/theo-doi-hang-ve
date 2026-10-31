import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/session";
import { formatAdsPercent, formatInt, formatRoas, formatVndFull } from "@/lib/channels/shopee/ads/metrics";
import { getShopeeFlags } from "@/lib/feature-flags";
import { salesComparable, salesCoverageNote, salesExact, type SalesCoverage } from "@/lib/product-analytics/coverage";
import { PRODUCT_METRIC_META } from "@/lib/product-analytics/data-quality";
import { PRODUCT_PERIOD_LABELS, PRODUCT_PERIOD_PRESETS } from "@/lib/product-analytics/periods";
import { loadProductDetail, resolveProductById, timedRead } from "@/lib/product-analytics/read-model";
import type { PaDelta } from "@/lib/product-analytics/types";
import { parseProductAnalyticsQuery, productAnalyticsHref } from "@/lib/product-analytics/url-state";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/ui/format";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader, SectionHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent } from "@/components/ui/card";

import { DeltaText, ProductThumb } from "../product-bits";
import { ProductTrendChart } from "./product-trend-chart";

export const dynamic = "force-dynamic";

const PATH = "/shopee/product-analytics";

function MetricTile({ label, delta, fmt, neutral = false, hint, coverage }: { label: string; delta: PaDelta; fmt: (v: number | null) => string; neutral?: boolean; hint?: string; coverage?: SalesCoverage }) {
  // sales tiles: missing data is never shown as 0 — "—" / lower bound "≥", no % without both periods
  const noData = coverage?.state === "no_data";
  const lowerBound = coverage !== undefined && !noData && !salesExact(coverage);
  const comparable = coverage === undefined || salesComparable(coverage);
  return (
    <div className="rounded-lg border bg-card p-3" title={hint}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${noData || lowerBound ? "text-muted-foreground" : ""}`}>
        {noData ? "—" : lowerBound ? `≥ ${fmt(delta.current)}` : fmt(delta.current)}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
        {comparable ? (
          <>
            <DeltaText pct={delta.pct} neutral={neutral} />
            <span>kỳ trước {fmt(delta.previous)}</span>
          </>
        ) : (
          <span>{noData ? "chưa có dữ liệu" : lowerBound ? "chưa đủ dữ liệu" : "kỳ trước chưa có dữ liệu"}</span>
        )}
      </div>
    </div>
  );
}

// PRODUCT-ANALYTICS-2: one product — sales (order facts), Ads (single-item
// campaigns), current provider snapshot, daily trend, data quality. DB only;
// no AI diagnosis, no cause inferred.
export default async function ProductAnalyticsDetailPage({ params, searchParams }: { params: Promise<{ productId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!getShopeeFlags().adsEnabled) notFound();
  await requirePermission("channel:view");
  const { productId } = await params;
  const sp = await searchParams;
  const db = createAdminClient();
  const ref = await resolveProductById(db, productId);
  if (!ref) notFound();
  const state = parseProductAnalyticsQuery(sp);
  const { value: detail, ms: queryMs } = await timedRead(() => loadProductDetail(db, ref, state.period));
  if (!detail) notFound();
  const { summary: s, daily, quality: q, signals } = detail;
  const { data: shop } = await db.from("shops").select("shop_name").eq("id", ref.shopId).maybeSingle<{ shop_name: string }>();
  const p = state.period;
  const hasAds = s.ads.single_item_campaigns > 0;
  const cov = q.sales_coverage;
  const coverageNote = salesCoverageNote(cov);
  const vnd = (v: number | null) => formatVndFull(v);
  const int = (v: number | null) => formatInt(v);
  const pct = (v: number | null) => formatAdsPercent(v);
  const roas = (v: number | null) => formatRoas(v);
  const link = (patch: Record<string, string | undefined>) => productAnalyticsHref(`${PATH}/${productId}`, {}, patch);

  return (
    <PageContainer>
      <Link href={productAnalyticsHref(PATH, { period: p.preset === "custom" ? "custom" : p.preset, from: p.preset === "custom" ? p.from : undefined, to: p.preset === "custom" ? p.to : undefined }, {})} className="text-sm text-muted-foreground hover:underline">← Danh sách sản phẩm</Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <ProductThumb url={s.identity.image_url} size="lg" alt={s.identity.name ?? ""} />
            <span>{s.identity.name ?? `Sản phẩm #${s.identity.provider_item_id}`}</span>
          </span>
        }
        description={`${shop?.shop_name ?? ""} · Item ${s.identity.provider_item_id}${s.identity.sku ? ` · SKU ${s.identity.sku}` : ""}${s.identity.provider_status ? ` · ${s.identity.provider_status}` : ""}`}
        meta={<span className="text-xs text-muted-foreground">Kỳ {p.from} → {p.to} · so với {p.prevFrom} → {p.prevTo}{p.hourCutoff !== null ? ` · cùng đến ${p.hourCutoff}:00` : ""} · {queryMs} ms</span>}
      />

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Kỳ">
        {PRODUCT_PERIOD_PRESETS.filter((k) => k !== "custom").map((k) => (
          <Link key={k} href={link({ period: k })} className={`rounded-full border px-3 py-1 ${p.preset === k ? "bg-primary text-primary-foreground" : ""}`}>{PRODUCT_PERIOD_LABELS[k]}</Link>
        ))}
        <form method="get" className="flex items-center gap-1">
          <input type="hidden" name="period" value="custom" />
          <input type="date" name="from" defaultValue={p.preset === "custom" ? p.from : ""} className="h-8 rounded-md border bg-background px-2 text-xs" aria-label="Từ ngày" />
          <input type="date" name="to" defaultValue={p.preset === "custom" ? p.to : ""} className="h-8 rounded-md border bg-background px-2 text-xs" aria-label="Đến ngày" />
          <button type="submit" className="h-8 rounded-md border px-2 text-xs">Áp dụng</button>
        </form>
      </nav>

      {p.partialToday && (
        <Callout tone="info" title="Hôm nay chưa hết ngày">
          {q.same_time_comparison.sales_available ? `Số liệu hôm nay và kỳ so sánh cùng được cắt đến ${p.hourCutoff}:00 (giờ đã hoàn tất).` : "Chưa có giờ hoàn tất để so sánh (hoặc kỳ có chứa hôm nay) — % thay đổi chưa có ý nghĩa."}
          {!q.same_time_comparison.ads_available && " Ads: chưa có dữ liệu theo giờ của kỳ so sánh — không so sánh Ads cùng giờ."}
        </Callout>
      )}

      {coverageNote && (
        <Callout tone="warning" title={cov.state === "covered" ? "Kỳ so sánh chưa có dữ liệu" : "Doanh số chưa đầy đủ"}>
          {coverageNote}
        </Callout>
      )}

      {signals.length > 0 && (
        <section className="space-y-2">
          <SectionHeader title="Tín hiệu (sự kiện, không phải nguyên nhân)" />
          <div className="flex flex-wrap gap-2">
            {signals.map((x) => (
              <StatusBadge key={x.type} tone={x.type === "DATA_STALE" ? "warning" : x.type.endsWith("_DOWN") ? "danger" : "info"} icon={false}>
                {x.type}{x.pct !== null ? ` ${x.pct > 0 ? "+" : ""}${x.pct.toLocaleString("vi-VN", { maximumFractionDigits: 1 })} %` : ""}
              </StatusBadge>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <SectionHeader title="A. Doanh số (đơn hàng)" description={PRODUCT_METRIC_META.sales_gmv.note} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile label="Doanh số" delta={s.sales.gmv} fmt={vnd} coverage={cov} />
          <MetricTile label="Đơn hàng" delta={s.sales.orders} fmt={int} coverage={cov} />
          <MetricTile label="Số lượng bán" delta={s.sales.units} fmt={int} coverage={cov} />
          <MetricTile label="Đơn đã hủy (không tính)" delta={s.sales.cancelled_orders} fmt={int} neutral coverage={cov} />
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="B. Quảng cáo"
          description={hasAds ? `${s.ads.single_item_campaigns} campaign chỉ quảng cáo sản phẩm này${s.ads.shared_campaigns_excluded ? ` · ${s.ads.shared_campaigns_excluded} campaign nhiều sản phẩm KHÔNG được tính` : ""}. Tỷ lệ = tổng / tổng.` : "Sản phẩm không có campaign quảng cáo riêng."}
        />
        {hasAds ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile label="Chi tiêu" delta={s.ads.spend} fmt={vnd} neutral />
              <MetricTile label="Broad GMV (attribution)" delta={s.ads.broad_gmv} fmt={vnd} hint={PRODUCT_METRIC_META.ads_broad_gmv.note} />
              <MetricTile label="ROAS Broad" delta={s.ads.broad_roas} fmt={roas} />
              <MetricTile label="ROAS Direct" delta={s.ads.direct_roas} fmt={roas} />
              <MetricTile label="Hiển thị" delta={s.ads.impressions} fmt={int} />
              <MetricTile label="Click" delta={s.ads.clicks} fmt={int} />
              <MetricTile label="CTR" delta={s.ads.ctr} fmt={pct} />
              <MetricTile label="CPC thực" delta={s.ads.cpc} fmt={vnd} neutral />
              <MetricTile label="Đơn Broad" delta={s.ads.broad_order} fmt={int} />
              <MetricTile label="Đơn Direct" delta={s.ads.direct_order} fmt={int} />
              <MetricTile label="CVR Broad" delta={s.ads.broad_cvr} fmt={pct} />
              <MetricTile
                label="Ads attribution / tổng doanh số"
                delta={s.ads.broad_gmv_to_sales_indicator}
                fmt={pct}
                neutral
                hint={PRODUCT_METRIC_META.broad_gmv_to_sales_indicator.note}
                // the denominator is sales: a lower bound would inflate the indicator
                coverage={salesExact(cov) ? cov : { ...cov, state: "no_data" }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              &quot;Ads attribution / tổng doanh số&quot; chỉ là chỉ báo: Broad GMV dùng cửa sổ quy đổi của Shopee Ads, doanh số dùng ngày tạo đơn — đây KHÔNG phải tỷ trọng doanh số do quảng cáo tạo ra, và doanh số
              trừ Broad GMV KHÔNG phải doanh số tự nhiên.
            </p>
          </>
        ) : null}
      </section>

      <section className="space-y-3">
        <SectionHeader title="C. Snapshot hiện tại từ Shopee" description="get_item_extra_info — giá trị tại thời điểm đọc. Ý nghĩa của views / sale CHƯA được xác minh nên không so sánh theo kỳ." />
        {s.snapshot ? (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ["Lượt xem (snapshot)", formatInt(s.snapshot.views)],
              ["Đã bán (bộ đếm Shopee)", formatInt(s.snapshot.sale)],
              ["Lượt thích", formatInt(s.snapshot.likes)],
              ["Đánh giá", s.snapshot.rating_star === null ? "—" : s.snapshot.rating_star.toLocaleString("vi-VN", { maximumFractionDigits: 2 })],
              ["Bình luận", formatInt(s.snapshot.comment_count)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground sm:col-span-3 lg:col-span-5">Đọc lúc {formatDateTime(s.snapshot.captured_at)}.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có snapshot (PRODUCT_EXTRA_INFO_SYNC_ENABLED đang tắt hoặc shop chưa bật).</p>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="D. Xu hướng theo ngày" />
        <Card>
          <CardContent className="p-4">
            <ProductTrendChart rows={daily} salesCoveredFrom={cov.covered_from} />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeader title="E. Chất lượng dữ liệu" />
        <Card>
          <CardContent className="grid gap-2 p-4 text-sm sm:grid-cols-3">
            <div>
              <div className="text-xs text-muted-foreground">Đơn hàng</div>
              <div>{q.sales_freshness.last_success_at ? `${formatDateTime(q.sales_freshness.last_success_at)} (${q.sales_freshness.age_minutes} phút trước)` : "Chưa đồng bộ"}</div>
              <div className="mt-1 flex gap-1">
                {q.sales_freshness.stale && <StatusBadge tone="warning">Cũ</StatusBadge>}
                {!q.sales_freshness.backfill_done && <StatusBadge tone="info">Backfill chưa xong</StatusBadge>}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Quảng cáo (hôm nay)</div>
              <div>{q.ads_freshness.last_today_read_at ? `${formatDateTime(q.ads_freshness.last_today_read_at)} (${q.ads_freshness.age_minutes} phút trước)` : "—"}</div>
              {q.ads_freshness.stale && <StatusBadge tone="warning">Cũ</StatusBadge>}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Snapshot sản phẩm</div>
              <div>{q.extra_info_freshness.last_captured_at ? `${formatDateTime(q.extra_info_freshness.last_captured_at)}` : "—"}</div>
            </div>
            {q.missing_sources.length > 0 && <div className="sm:col-span-3 text-xs">Thiếu nguồn: {q.missing_sources.join(", ")}</div>}
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground sm:col-span-3">
              {q.semantic_warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>
    </PageContainer>
  );
}
