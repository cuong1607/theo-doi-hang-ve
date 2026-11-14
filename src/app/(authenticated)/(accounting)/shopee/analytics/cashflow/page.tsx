import { Landmark } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { getCashflowAnalytics, getCashflowTrend, getPendingReleaseOrders } from "@/lib/channels/core/analytics";
import { chartNumber, formatMoney } from "@/lib/analytics/display";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/ui/format";
import { parsePage } from "@/lib/ui/list-query";
import { AnalyticsFilters } from "@/components/analytics/analytics-filters";
import { BarList } from "@/components/analytics/bar-list";
import { getAnalyticsContext, periodText, type AnalyticsContext, type AnalyticsParams } from "@/components/analytics/context";
import { KpiCard, KpiGrid } from "@/components/analytics/kpi-card";
import { AnalyticsSection, loadSection, SectionFailed } from "@/components/analytics/section";
import { agingLabel } from "@/components/analytics/sections";
import { TrendChart } from "@/components/analytics/trend-chart";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageHeader } from "@/components/patterns/page-header";
import { CardSkeleton } from "@/components/patterns/skeletons";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";
const PATH = "/shopee/analytics/cashflow";
const PAGE = 25;

async function Overview({ ctx, aging, page }: { ctx: AnalyticsContext; aging: number | null; page: number }) {
  const db = createAdminClient();
  const res = await loadSection("cash", () => Promise.all([getCashflowAnalytics(db, ctx.scope, ctx.period), getCashflowTrend(db, ctx.scope, ctx.period)]));
  if (!res.ok) return <SectionFailed title="Dòng tiền" />;
  const [c, trend] = res.data;
  const st = c.payouts_by_status;
  const bucket = aging !== null ? c.aging.find((a) => a.bucket === aging) ?? null : null;
  const pending = bucket
    ? await loadSection("pending-orders", () => getPendingReleaseOrders(db, ctx.scope, { lower: bucket.bucket === 1 ? null : bucket.lower_days, upper: bucket.upper_days }, PAGE, (page - 1) * PAGE))
    : null;
  const withAging = (n: number) => `${PATH}?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(ctx.query).filter(([, v]) => v)) as Record<string, string>), aging: String(n) })}`;
  return (
    <>
      <KpiGrid>
        <KpiCard label="Chờ Shopee giải ngân (hiện tại)" value={formatMoney(c.pending_amount)} sub={`${c.pending_orders} đơn${c.pending_without_amount ? ` · ${c.pending_without_amount} chưa có quyết toán` : ""}${c.stale_orders ? ` · ${c.stale_orders} chờ quá lâu` : ""}`} valueTone={c.stale_orders ? "warning" : undefined} />
        <KpiCard label="Đã giải ngân trong kỳ" value={formatMoney(c.released_amount)} sub={`${c.released_orders} đơn · theo ngày giải ngân`} />
        <KpiCard label="Payout trong kỳ" value={formatMoney(c.payout_amount)} sub={`${c.payout_count} lần chuyển · khớp ${st.matched ?? 0} / thiếu dữ liệu ${st.incomplete ?? 0} / lệch ${st.mismatch ?? 0}`} href={`/shopee/payouts?from=${ctx.period.from}&to=${ctx.period.to}`} />
        <KpiCard
          label="Lệch đối soát chưa xử lý"
          value={formatMoney(c.open_mismatch_value)}
          valueTone={c.open_mismatch_payouts ? "danger" : undefined}
          sub={`${c.open_mismatch_payouts} payout lệch · ${c.open_incomplete_payouts} thiếu dữ liệu · ${c.release_mismatch_orders} đơn lệch giải ngân`}
          href="/shopee/payouts?status=mismatch"
        />
      </KpiGrid>
      <AnalyticsSection title="Tiền giải ngân và payout theo ngày" description="Theo ngày Shopee giải ngân / ngày chuyển payout (giờ VN) — không phải ngày tạo đơn. Hệ thống không xác nhận tiền đã về ngân hàng.">
        <TrendChart
          title="Dòng tiền theo ngày"
          points={trend.map((p) => ({
            label: `${p.bucket.slice(8, 10)}/${p.bucket.slice(5, 7)}`,
            values: { rel: chartNumber(p.released_amount), pay: chartNumber(p.payout_amount) },
            display: { rel: `${formatMoney(p.released_amount)} (${p.released_orders} đơn)`, pay: `${formatMoney(p.payout_amount)} (${p.payouts} lần)` },
          }))}
          series={[
            { key: "rel", label: "Đã giải ngân", color: "var(--info)", dash: "6 4" },
            { key: "pay", label: "Payout", color: "var(--success)" },
          ]}
        />
      </AnalyticsSection>
      <AnalyticsSection title="Đơn chờ giải ngân theo số ngày từ khi hoàn thành" description="Bấm một nhóm để xem danh sách đơn. Ngưỡng nhóm cấu hình trong analytics_settings.">
        <BarList
          emptyText="Không có đơn chờ giải ngân."
          items={c.aging.map((a) => ({
            key: String(a.bucket),
            href: withAging(a.bucket),
            label: (
              <>
                {agingLabel(a.lower_days, a.upper_days)}
                {aging === a.bucket && <span className="ml-1 text-xs text-primary">(đang xem)</span>}
              </>
            ),
            magnitude: a.orders,
            value: `${a.orders} đơn · ${formatMoney(a.amount)}`,
          }))}
        />
        {bucket && pending && (
          <div className="mt-4">
            {!pending.ok ? (
              <SectionFailed title="Đơn chờ giải ngân" />
            ) : pending.data.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Không có đơn trong nhóm này.</p>
            ) : (
              <>
                <p className="mb-2 text-sm font-medium">
                  {agingLabel(bucket.lower_days, bucket.upper_days)} — {pending.data.total} đơn
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Đơn</TableHead>
                        <TableHead>Hoàn thành (≈)</TableHead>
                        <TableHead className="text-right">Số ngày</TableHead>
                        <TableHead className="text-right">Thu nhập kỳ vọng</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pending.data.rows.map((o) => (
                        <TableRow key={o.order_id}>
                          <TableCell>
                            <Link href={`/shopee/orders/${o.order_id}`} className="font-mono text-xs text-primary underline-offset-4 hover:underline">
                              {o.external_order_sn}
                            </Link>
                            {o.release_stale && (
                              <StatusBadge className="ml-2" tone="warning" icon={false}>
                                Chờ quá lâu
                              </StatusBadge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{formatDateTime(o.completed_at_channel)}</TableCell>
                          <TableCell className="text-right">{String(o.age_days).replace(".", ",")}</TableCell>
                          <TableCell className="text-right">{o.expected_amount ? formatMoney(o.expected_amount) : <span className="text-muted-foreground">chưa có quyết toán</span>}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <DataTablePagination pathname={PATH} query={{ ...ctx.query, aging: String(aging) }} page={page} pageSize={PAGE} total={pending.data.total} />
              </>
            )}
          </div>
        )}
      </AnalyticsSection>
    </>
  );
}

export default async function CashflowAnalyticsPage({ searchParams }: { searchParams: Promise<AnalyticsParams & { aging?: string; page?: string }> }) {
  const params = await searchParams;
  const ctx = await getAnalyticsContext(params, "30d");
  if (!ctx) return <EmptyState icon={Landmark} title="Chưa kết nối shop Shopee nào." />;
  const aging = params.aging && /^\d{1,2}$/.test(params.aging) ? Number(params.aging) : null;
  const page = parsePage(params.page);
  const k = `${ctx.period.from}|${ctx.period.to}|${ctx.scope.shopIds.join(",")}|${aging}|${page}`;
  return (
    <>
      <PageHeader
        title="Phân tích dòng tiền"
        description={`${periodText(ctx.period)} · theo ngày giải ngân / payout. Dòng tiền khác lợi nhuận: đơn có lãi có thể chưa được trả tiền, payout có thể gồm điều chỉnh của kỳ khác.`}
        actions={
          <Button size="sm" variant="outline" nativeButton={false} render={<a href={`/api/shopee/analytics/export?${new URLSearchParams(Object.entries({ kind: "payouts", ...ctx.query }).filter(([, v]) => v) as Array<[string, string]>)}`} />}>
            Xuất đối soát payout
          </Button>
        }
      />
      <AnalyticsFilters query={ctx.query} shops={ctx.scope.shops.map((s) => ({ id: s.id, name: s.name }))} extraKeys={["aging"]} />
      <Suspense key={k} fallback={<CardSkeleton lines={8} />}>
        <Overview ctx={ctx} aging={aging} page={page} />
      </Suspense>
    </>
  );
}
