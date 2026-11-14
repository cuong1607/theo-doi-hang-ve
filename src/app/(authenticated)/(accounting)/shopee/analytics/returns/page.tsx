import { Undo2 } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { getProductAnalytics, getReturnsAnalytics } from "@/lib/channels/core/analytics";
import { formatMoney, formatPct } from "@/lib/analytics/display";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatQuantity } from "@/lib/ui/format";
import { AnalyticsFilters } from "@/components/analytics/analytics-filters";
import { getAnalyticsContext, periodText, type AnalyticsContext, type AnalyticsParams } from "@/components/analytics/context";
import { KpiCard, KpiGrid } from "@/components/analytics/kpi-card";
import { AnalyticsSection, loadSection, SectionFailed } from "@/components/analytics/section";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageHeader } from "@/components/patterns/page-header";
import { CardSkeleton } from "@/components/patterns/skeletons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

async function Kpis({ ctx }: { ctx: AnalyticsContext }) {
  const res = await loadSection("returns-kpi", () => getReturnsAnalytics(createAdminClient(), ctx.scope, ctx.period));
  if (!res.ok) return <SectionFailed title="Trả hàng" />;
  const r = res.data;
  return (
    <>
      <KpiGrid>
        <KpiCard label="Yêu cầu trả hàng" value={String(r.return_count)} sub={`${formatQuantity(r.returned_units)} sp khớp đơn${Number(r.unmatched_units) ? ` · ${formatQuantity(r.unmatched_units)} sp không khớp` : ""}`} hint="Theo ngày tạo yêu cầu trả hàng (giờ VN); không tính yêu cầu đã huỷ." />
        <KpiCard
          label="Tỷ lệ trả (theo sản phẩm)"
          value={formatPct(r.unit_return_rate)}
          sub={`${formatQuantity(r.cohort_returned_units)} / ${formatQuantity(r.cohort_units)} sp bán trong kỳ`}
          hint="Số sản phẩm bị trả / số sản phẩm đã bán, trên các đơn TẠO trong kỳ (combo tính theo đơn vị combo)."
        />
        <KpiCard label="Tỷ lệ đơn có trả hàng" value={formatPct(r.order_return_rate)} sub={`${r.cohort_orders_with_returns} / ${r.cohort_orders} đơn`} hint="Đơn có ít nhất một yêu cầu trả hàng / đơn tạo trong kỳ — chỉ số riêng, không trộn với tỷ lệ theo sản phẩm." />
        <KpiCard label="Hoàn tiền (tham khảo)" value={formatMoney(r.refund_amount_reference)} hint="Số Shopee báo trên yêu cầu trả hàng. Đã nằm trong thu nhập thực tế (quyết toán sau điều chỉnh) — không trừ lần nữa." />
      </KpiGrid>
      <AnalyticsSection title="Ảnh hưởng giá vốn" description="Giá vốn gốc của hàng bị trả (theo snapshot của dòng đơn) và phần đã thu hồi.">
        <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Giá vốn liên quan</dt>
            <dd className="text-base font-semibold tabular-nums">{formatMoney(r.cogs_involved)}</dd>
            {r.cogs_involved_missing > 0 && <dd className="text-xs text-warning-text">{r.cogs_involved_missing} dòng chưa có giá vốn</dd>}
          </div>
          <div>
            <dt className="text-muted-foreground">Đã hoàn (nhập lại kho)</dt>
            <dd className="text-base font-semibold text-success-text tabular-nums">{formatMoney(r.cogs_reversed)}</dd>
            <dd className="text-xs text-muted-foreground">{formatQuantity(r.restocked_units)} sp</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Không thu hồi (hỏng / mất / huỷ)</dt>
            <dd className="text-base font-semibold text-danger-text tabular-nums">{formatMoney(r.cogs_not_recovered)}</dd>
            <dd className="text-xs text-muted-foreground">
              {formatQuantity(r.damaged_units)} hỏng · {formatQuantity(r.lost_units)} mất · {formatQuantity(r.disposed_units)} huỷ
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Chờ xử lý</dt>
            <dd className="text-base font-semibold text-warning-text tabular-nums">{formatMoney(r.cogs_pending)}</dd>
            <dd className="text-xs">
              <Link href="/shopee/returns?disposition=pending" className="underline underline-offset-4">
                {formatQuantity(r.pending_units)} sp chờ quyết định
              </Link>
            </dd>
          </div>
        </dl>
      </AnalyticsSection>
    </>
  );
}

async function ByProduct({ ctx }: { ctx: AnalyticsContext }) {
  const res = await loadSection("returns-products", () => getProductAnalytics(createAdminClient(), ctx.scope, ctx.period, { sort: "return_rate", limit: 30 }));
  if (!res.ok) return <SectionFailed title="SKU theo tỷ lệ trả" />;
  const rows = res.data.rows.filter((r) => Number(r.returned_units) > 0);
  return (
    <AnalyticsSection title="SKU theo tỷ lệ trả hàng" description="Luôn kèm số lượng gốc — tỷ lệ của SKU bán ít (mẫu nhỏ) chưa đủ để kết luận.">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Không có SKU nào bị trả trong các đơn của kỳ.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Tỷ lệ trả</TableHead>
                <TableHead className="text-right">Trả / bán</TableHead>
                <TableHead className="text-right">Đơn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.product_id}>
                  <TableCell>
                    <Link href={`/shopee/analytics/products/${r.product_id}${ctx.qs}`} className="font-mono text-xs text-primary underline-offset-4 hover:underline">
                      {r.sku}
                    </Link>
                    {r.product_type === "combo" && <span className="ml-1 text-xs text-info-text">Combo</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPct(r.return_rate)}
                    {r.small_sample && <span className="block text-xs text-muted-foreground">mẫu nhỏ</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQuantity(r.returned_units)} / {formatQuantity(r.units)} sp
                  </TableCell>
                  <TableCell className="text-right">{r.orders}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </AnalyticsSection>
  );
}

export default async function ReturnsAnalyticsPage({ searchParams }: { searchParams: Promise<AnalyticsParams> }) {
  const ctx = await getAnalyticsContext(await searchParams, "30d");
  if (!ctx) return <EmptyState icon={Undo2} title="Chưa kết nối shop Shopee nào." />;
  const k = `${ctx.period.from}|${ctx.period.to}|${ctx.scope.shopIds.join(",")}`;
  return (
    <>
      <PageHeader title="Phân tích trả hàng" description={`${periodText(ctx.period)}. Trả hàng là điều chỉnh của đơn gốc — đơn vẫn nằm trong doanh số; lợi nhuận thực tế dùng giá vốn ròng (SHOPEE-6).`} />
      <AnalyticsFilters query={ctx.query} shops={ctx.scope.shops.map((s) => ({ id: s.id, name: s.name }))} />
      <Callout tone="info">Số lượng / giá vốn theo ngày tạo yêu cầu trả hàng; tỷ lệ trả theo các đơn tạo trong kỳ (một yêu cầu có thể đến sau kỳ của đơn).</Callout>
      <Suspense key={`k${k}`} fallback={<CardSkeleton lines={6} />}>
        <Kpis ctx={ctx} />
      </Suspense>
      <Suspense key={`p${k}`} fallback={<CardSkeleton lines={6} />}>
        <ByProduct ctx={ctx} />
      </Suspense>
    </>
  );
}
