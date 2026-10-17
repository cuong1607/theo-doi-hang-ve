import { Suspense } from "react";
import { Store } from "lucide-react";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/session";
import { AnalyticsFilters } from "@/components/analytics/analytics-filters";
import { getAnalyticsContext, periodText, type AnalyticsParams } from "@/components/analytics/context";
import { FreshnessBar, SyncHealthSection } from "@/components/analytics/freshness";
import {
  CashflowSection,
  DataQualitySection,
  KpiSection,
  ReturnsSection,
  RiskSection,
  ShopComparisonSection,
  StatusMixSection,
  TopProductsSection,
  TrendSection,
} from "@/components/analytics/sections";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { CardSkeleton, MetricSkeleton } from "@/components/patterns/skeletons";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function ShopeeDashboardPage({ searchParams }: { searchParams: Promise<AnalyticsParams> }) {
  await requirePermission("channel:view");
  const ctx = await getAnalyticsContext(await searchParams);
  if (!ctx) {
    return (
      <PageContainer>
        <PageHeader title="Dashboard Shopee" />
        <EmptyState icon={Store} title="Chưa kết nối shop Shopee nào." description="Kết nối shop ở trang Đồng bộ Shopee để bắt đầu." />
      </PageContainer>
    );
  }
  const k = `${ctx.period.from}|${ctx.period.to}|${ctx.scope.shopIds.join(",")}`;
  return (
    <PageContainer>
      <PageHeader
        title="Dashboard Shopee"
        description={`${periodText(ctx.period)} · ${ctx.scope.selectedShopId ? ctx.scope.shops.find((s) => s.id === ctx.scope.selectedShopId)?.name : `Tất cả shop (${ctx.scope.shopIds.length})`} · ${ctx.scope.currency}. Bán hàng & lợi nhuận theo ngày tạo đơn; dòng tiền theo ngày giải ngân / payout.`}
        actions={
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/shopee/analytics/products${ctx.qs}`} />}>
            Phân tích chi tiết
          </Button>
        }
      />
      <AnalyticsFilters query={ctx.query} shops={ctx.scope.shops.map((s) => ({ id: s.id, name: s.name }))} />
      {ctx.scope.excludedShops.length > 0 && (
        <Callout tone="warning">
          {ctx.scope.excludedShops.map((s) => s.name).join(", ")} dùng tiền tệ khác ({ctx.scope.excludedShops.map((s) => s.currency ?? "?").join(", ")}) nên không được cộng vào tổng {ctx.scope.currency} — chọn riêng shop đó để xem.
        </Callout>
      )}
      <Suspense key={`f${k}`} fallback={null}>
        <FreshnessBar shopIds={ctx.scope.shopIds} />
      </Suspense>

      <Suspense key={`k${k}`} fallback={<MetricSkeleton count={8} />}>
        <KpiSection ctx={ctx} />
      </Suspense>
      <Suspense key={`t${k}`} fallback={<CardSkeleton lines={8} />}>
        <TrendSection ctx={ctx} />
      </Suspense>
      <div className="grid gap-4 xl:grid-cols-2">
        <Suspense key={`p${k}`} fallback={<CardSkeleton lines={6} />}>
          <TopProductsSection ctx={ctx} />
        </Suspense>
        <Suspense key={`r${k}`} fallback={<CardSkeleton lines={6} />}>
          <RiskSection ctx={ctx} />
        </Suspense>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Suspense key={`re${k}`} fallback={<CardSkeleton lines={5} />}>
          <ReturnsSection ctx={ctx} />
        </Suspense>
        <Suspense key={`c${k}`} fallback={<CardSkeleton lines={5} />}>
          <CashflowSection ctx={ctx} />
        </Suspense>
      </div>
      <Suspense key={`q${k}`} fallback={<CardSkeleton lines={4} />}>
        <DataQualitySection ctx={ctx} />
      </Suspense>
      <Suspense key={`s${k}`} fallback={null}>
        <ShopComparisonSection ctx={ctx} />
      </Suspense>
      <div className="grid gap-4 xl:grid-cols-2">
        <Suspense key={`m${k}`} fallback={<CardSkeleton lines={4} />}>
          <StatusMixSection ctx={ctx} />
        </Suspense>
        <Suspense key={`h${k}`} fallback={<CardSkeleton lines={3} />}>
          <SyncHealthSection shopIds={ctx.scope.shopIds} />
        </Suspense>
      </div>
    </PageContainer>
  );
}
