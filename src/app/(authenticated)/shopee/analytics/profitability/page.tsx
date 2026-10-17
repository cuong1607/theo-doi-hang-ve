import { Download, TrendingDown } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { getAnalyticsSettings, getAnalyticsSummary, getLossOrders, getMarginBands, getProductAnalytics } from "@/lib/channels/core/analytics";
import { formatMoney, formatPct, formatSignedMoney, isNegative } from "@/lib/analytics/display";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime, formatQuantity } from "@/lib/ui/format";
import { parsePage } from "@/lib/ui/list-query";
import { AnalyticsFilters } from "@/components/analytics/analytics-filters";
import { BarList } from "@/components/analytics/bar-list";
import { getAnalyticsContext, periodText, type AnalyticsContext, type AnalyticsParams } from "@/components/analytics/context";
import { KpiCard, KpiGrid } from "@/components/analytics/kpi-card";
import { bandLabel } from "@/components/analytics/labels";
import { AnalyticsSection, loadSection, SectionFailed } from "@/components/analytics/section";
import { SalesTrendSection, ShopComparisonSection, TrendSection } from "@/components/analytics/sections";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageHeader } from "@/components/patterns/page-header";
import { CardSkeleton } from "@/components/patterns/skeletons";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";
const PATH = "/shopee/analytics/profitability";
const LOSS_PAGE = 25;

async function Overview({ ctx }: { ctx: AnalyticsContext }) {
  const res = await loadSection("profit-overview", () => getAnalyticsSummary(createAdminClient(), ctx.scope, ctx.period));
  if (!res.ok) return <SectionFailed title="Tổng quan lợi nhuận" />;
  const s = res.data;
  return (
    <KpiGrid>
      <KpiCard label="LN dự kiến" value={formatSignedMoney(s.estimated_profit)} sub={`Margin ${formatPct(s.estimated_margin)} · ${s.estimated_profit_orders}/${s.order_count} đơn`} />
      <KpiCard label="LN thực tế" value={formatSignedMoney(s.actual_profit)} sub={`Margin ${formatPct(s.actual_margin)} · ${s.actual_profit_orders}/${s.order_count} đơn final`} />
      <KpiCard
        label="Giá vốn ròng"
        value={formatMoney(s.net_cogs)}
        sub={`Gốc ${formatMoney(s.original_cogs)} − hoàn từ trả hàng ${formatMoney(s.reversed_cogs)} · ${s.cogs_orders}/${s.order_count} đơn`}
        hint="Giá vốn theo snapshot của từng đơn (đã gồm VAT theo cost engine, combo theo thành phần lúc bán). Không tính lại ở đây."
      />
      <KpiCard label="Đơn lỗ" value={`${s.loss_actual_orders + s.loss_estimated_orders}`} valueTone={s.loss_actual_orders + s.loss_estimated_orders ? "danger" : undefined} sub={`${s.loss_actual_orders} lỗ thực tế · ${s.loss_estimated_orders} dự kiến lỗ`} />
    </KpiGrid>
  );
}

async function LossOrders({ ctx, page }: { ctx: AnalyticsContext; page: number }) {
  const res = await loadSection("loss-orders", () => getLossOrders(createAdminClient(), ctx.scope, ctx.period, LOSS_PAGE, (page - 1) * LOSS_PAGE));
  if (!res.ok) return <SectionFailed title="Đơn bán lỗ" />;
  const { rows, total } = res.data;
  return (
    <AnalyticsSection title={`Đơn có nguy cơ bán lỗ (${total})`} description="Dùng LN thực tế khi đơn đã final; nếu chưa, dùng LN dự kiến và ghi rõ “Dự kiến lỗ”.">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Không có đơn lỗ trong kỳ.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Đơn</TableHead>
                  <TableHead>Ngày tạo</TableHead>
                  <TableHead>Tình trạng</TableHead>
                  <TableHead className="text-right">Giá trị đơn</TableHead>
                  <TableHead className="text-right">LN dự kiến</TableHead>
                  <TableHead className="text-right">LN thực tế</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o.order_id}>
                    <TableCell>
                      <Link href={`/shopee/orders/${o.order_id}`} className="font-mono text-xs text-primary underline-offset-4 hover:underline">
                        {o.external_order_sn}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDateTime(o.created_at_channel)}</TableCell>
                    <TableCell>
                      <StatusBadge tone={o.loss_state === "actual_loss" ? "danger" : "warning"} icon={false}>
                        {o.loss_state === "actual_loss" ? "Lỗ thực tế" : "Dự kiến lỗ"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(o.order_value)}</TableCell>
                    <TableCell className={`text-right ${isNegative(o.estimated_profit) ? "text-danger-text" : ""}`}>{formatSignedMoney(o.estimated_profit)}</TableCell>
                    <TableCell className={`text-right ${isNegative(o.actual_profit) ? "text-danger-text" : ""}`}>{formatSignedMoney(o.actual_profit)}</TableCell>
                    <TableCell className="text-right">{formatPct(o.margin)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DataTablePagination pathname={PATH} query={ctx.query} page={page} pageSize={LOSS_PAGE} total={total} />
        </>
      )}
    </AnalyticsSection>
  );
}

async function LowMargin({ ctx, threshold }: { ctx: AnalyticsContext; threshold: string | null }) {
  const db = createAdminClient();
  const res = await loadSection("low-margin", () => Promise.all([getProductAnalytics(db, ctx.scope, ctx.period, { attention: true, marginThreshold: threshold, sort: "estimated_margin", desc: false, limit: 50 }), getAnalyticsSettings(db)]));
  if (!res.ok) return <SectionFailed title="SKU margin thấp" />;
  const [list, settings] = res.data;
  const t = threshold ?? settings.lowMarginThresholdPct;
  return (
    <AnalyticsSection
      title={`SKU cần chú ý — LN âm hoặc margin < ${formatPct(t)} (${list.total})`}
      description={
        <>
          Ngưỡng mặc định lấy từ cấu hình ({formatPct(settings.lowMarginThresholdPct)}). Đổi tạm:{" "}
          {["0", "5", "10", "15", "20"].map((x) => (
            <Link key={x} href={`${PATH}?${new URLSearchParams({ ...Object.fromEntries(Object.entries(ctx.query).filter(([, v]) => v) as Array<[string, string]>), margin: x })}`} className="mr-2 underline underline-offset-4">
              &lt; {x}%
            </Link>
          ))}
        </>
      }
    >
      {list.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Không có SKU nào.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Đơn</TableHead>
                <TableHead className="text-right">Giá trị đơn</TableHead>
                <TableHead className="text-right">Giá vốn</TableHead>
                <TableHead className="text-right">LN dự kiến</TableHead>
                <TableHead className="text-right">LN thực tế</TableHead>
                <TableHead className="text-right">Margin DK / TT</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((r) => (
                <TableRow key={r.product_id}>
                  <TableCell>
                    <Link href={`/shopee/analytics/products/${r.product_id}${ctx.qs}`} className="font-mono text-xs text-primary underline-offset-4 hover:underline">
                      {r.sku}
                    </Link>
                    {r.product_type === "combo" && <span className="ml-1 text-xs text-info-text">Combo</span>}
                  </TableCell>
                  <TableCell className="text-right">{r.orders}</TableCell>
                  <TableCell className="text-right">{formatMoney(r.order_value)}</TableCell>
                  <TableCell className="text-right">{formatMoney(r.cogs)}</TableCell>
                  <TableCell className={`text-right ${isNegative(r.estimated_profit) ? "text-danger-text" : ""}`}>{formatSignedMoney(r.estimated_profit)}</TableCell>
                  <TableCell className={`text-right ${isNegative(r.actual_profit) ? "text-danger-text" : ""}`}>{formatSignedMoney(r.actual_profit)}</TableCell>
                  <TableCell className="text-right">
                    {formatPct(r.estimated_margin)} / {formatPct(r.actual_margin)}
                    {r.small_sample && <span className="block text-xs text-muted-foreground">mẫu nhỏ ({formatQuantity(r.units)} sp)</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </AnalyticsSection>
  );
}

async function Bands({ ctx }: { ctx: AnalyticsContext }) {
  const db = createAdminClient();
  const res = await loadSection("bands", () => Promise.all([getMarginBands(db, ctx.scope, ctx.period, "estimated"), getMarginBands(db, ctx.scope, ctx.period, "actual")]));
  if (!res.ok) return <SectionFailed title="Phân bố margin" />;
  const [est, act] = res.data;
  const render = (bands: typeof est) => (
    <BarList
      emptyText="Chưa có đơn đủ dữ liệu."
      items={bands.map((b) => ({
        key: String(b.band_index),
        label: bandLabel(b.lower_pct, b.upper_pct),
        magnitude: b.orders,
        value: `${b.orders} đơn`,
        negative: b.upper_pct !== null && Number(b.upper_pct) <= 0,
        sub: `Giá trị ${formatMoney(b.order_value)} · LN ${formatSignedMoney(b.profit)}`,
      }))}
    />
  );
  return (
    <AnalyticsSection title="Phân bố margin theo đơn" description="Mỗi đơn rơi vào đúng một khoảng (khoảng cấu hình trong analytics_settings).">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm font-medium">Theo LN dự kiến</p>
          {render(est)}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Theo LN thực tế</p>
          {render(act)}
        </div>
      </div>
    </AnalyticsSection>
  );
}

async function Quadrants({ ctx }: { ctx: AnalyticsContext }) {
  const db = createAdminClient();
  const res = await loadSection("quadrants", () => Promise.all([getProductAnalytics(db, ctx.scope, ctx.period, { sort: "order_value", limit: 200 }), getAnalyticsSettings(db)]));
  if (!res.ok) return <SectionFailed title="Doanh thu vs lợi nhuận" />;
  const [list, settings] = res.data;
  const rows = list.rows.filter((r) => r.order_value !== null);
  if (rows.length === 0) return null;
  // high revenue = top half of SKUs by order value (median split, display classification only)
  const sorted = [...rows].sort((a, b) => Number(b.order_value) - Number(a.order_value));
  const highCut = Number(sorted[Math.floor((sorted.length - 1) / 2)].order_value);
  const threshold = Number(settings.lowMarginThresholdPct);
  const group = (r: (typeof rows)[number]) => {
    const profit = r.actual_profit ?? r.estimated_profit;
    const margin = r.actual_margin ?? r.estimated_margin;
    if (profit === null || margin === null) return "unknown";
    if (isNegative(profit)) return "loss";
    const high = Number(r.order_value) >= highCut;
    const good = Number(margin) >= threshold;
    return high ? (good ? "hh" : "hl") : good ? "lh" : "ll";
  };
  const GROUPS: Array<[string, string]> = [
    ["hl", "Doanh thu cao · margin thấp — kiểm tra giá bán"],
    ["loss", "Bán lỗ"],
    ["hh", "Doanh thu cao · margin tốt"],
    ["lh", "Doanh thu thấp · margin tốt"],
    ["ll", "Doanh thu thấp · margin thấp"],
  ];
  return (
    <AnalyticsSection title="Doanh thu vs lợi nhuận" description={`Phân nhóm SKU: doanh thu cao = nửa trên theo giá trị đơn trong kỳ; margin tốt = ≥ ${formatPct(settings.lowMarginThresholdPct)} (thực tế nếu có, không thì dự kiến).`}>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {GROUPS.map(([g, label]) => {
          const items = rows.filter((r) => group(r) === g).slice(0, 8);
          return (
            <div key={g} className="rounded-lg border p-3">
              <p className="mb-2 text-sm font-medium">
                {label} ({rows.filter((r) => group(r) === g).length})
              </p>
              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground">—</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {items.map((r) => (
                    <li key={r.product_id} className="flex justify-between gap-2">
                      <Link href={`/shopee/analytics/products/${r.product_id}${ctx.qs}`} className="truncate font-mono underline-offset-4 hover:underline">
                        {r.sku}
                      </Link>
                      <span className="shrink-0 tabular-nums">
                        {formatMoney(r.order_value)} · {formatPct(r.actual_margin ?? r.estimated_margin)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </AnalyticsSection>
  );
}

export default async function ProfitabilityPage({ searchParams }: { searchParams: Promise<AnalyticsParams & { page?: string; margin?: string }> }) {
  const params = await searchParams;
  const ctx = await getAnalyticsContext(params, "30d");
  if (!ctx) return <EmptyState icon={TrendingDown} title="Chưa kết nối shop Shopee nào." />;
  const page = parsePage(params.page);
  const threshold = params.margin && /^-?\d{1,3}(\.\d+)?$/.test(params.margin) ? params.margin : null;
  const k = `${ctx.period.from}|${ctx.period.to}|${ctx.scope.shopIds.join(",")}`;
  const exportQs = new URLSearchParams(Object.entries({ kind: "profitability", ...ctx.query }).filter(([, v]) => v) as Array<[string, string]>);
  return (
    <>
      <PageHeader
        title="Phân tích lợi nhuận"
        description={`${periodText(ctx.period)} · theo ngày tạo đơn. LN dự kiến và LN thực tế luôn tách riêng; margin = Σ LN / Σ giá trị đơn (có trọng số).`}
        actions={
          <Button size="sm" variant="outline" nativeButton={false} render={<a href={`/api/shopee/analytics/export?${exportQs}`} />}>
            <Download /> Xuất đơn lỗ
          </Button>
        }
      />
      <AnalyticsFilters query={ctx.query} shops={ctx.scope.shops.map((s) => ({ id: s.id, name: s.name }))} />
      <Suspense key={`o${k}`} fallback={<CardSkeleton lines={3} />}>
        <Overview ctx={ctx} />
      </Suspense>
      <Suspense key={`t${k}`} fallback={<CardSkeleton lines={8} />}>
        <TrendSection ctx={ctx} />
      </Suspense>
      <Suspense key={`st${k}`} fallback={<CardSkeleton lines={6} />}>
        <SalesTrendSection ctx={ctx} />
      </Suspense>
      <Suspense key={`l${k}${page}`} fallback={<CardSkeleton lines={6} />}>
        <LossOrders ctx={ctx} page={page} />
      </Suspense>
      <Suspense key={`m${k}${threshold}`} fallback={<CardSkeleton lines={6} />}>
        <LowMargin ctx={ctx} threshold={threshold} />
      </Suspense>
      <Suspense key={`q${k}`} fallback={<CardSkeleton lines={6} />}>
        <Quadrants ctx={ctx} />
      </Suspense>
      <Suspense key={`b${k}`} fallback={<CardSkeleton lines={6} />}>
        <Bands ctx={ctx} />
      </Suspense>
      <Suspense key={`s${k}`} fallback={null}>
        <ShopComparisonSection ctx={ctx} />
      </Suspense>
    </>
  );
}
