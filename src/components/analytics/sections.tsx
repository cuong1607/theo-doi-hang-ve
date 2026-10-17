// SHOPEE-8 dashboard sections (server components). Each loads its own data
// (one RPC family), renders its own error, and is wrapped in its own
// <Suspense> by the page. Every figure is a database aggregate; this file
// only formats and labels — no financial formula lives here.
import Link from "next/link";
import { ShoppingBag } from "lucide-react";

import {
  ACTUAL_COVERAGE_FOR_RANKING,
  defaultProductSort,
  getAnalyticsSettings,
  getAnalyticsSummary,
  getAnalyticsTrend,
  getCashflowAnalytics,
  getDataQuality,
  getLossOrders,
  getOrderStatusMix,
  getProductAnalytics,
  getReturnsAnalytics,
  getShopComparison,
  type AnalyticsSummary,
} from "@/lib/channels/core/analytics";
import { ORDER_STATUS_LABELS } from "@/lib/channels/shopee/order-status";
import { chartNumber, formatMoney, formatPct, formatSignedMoney, isNegative } from "@/lib/analytics/display";
import { chooseBucket, coverageRatio, coverageText, deltaPercent } from "@/lib/analytics/periods";
import { formatQuantity } from "@/lib/ui/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { BarList } from "./bar-list";
import { ordersHref, type AnalyticsContext } from "./context";
import { KpiCard, KpiGrid } from "./kpi-card";
import { AnalyticsSection, loadSection, SectionFailed } from "./section";
import { TrendChart } from "./trend-chart";

const COLORS = {
  estimated: "var(--info)",
  actual: "var(--success)",
  value: "var(--muted-foreground)",
  revenue: "var(--primary)",
};
const ENOUGH = ACTUAL_COVERAGE_FOR_RANKING;

/** Delta only when both periods have enough coverage for the metric (never compare different samples silently). */
function safeDelta(cur: string | null, prev: string | null, curCov: number | null, prevCov: number | null) {
  if (curCov === null || prevCov === null || curCov < ENOUGH || prevCov < ENOUGH) return undefined;
  return deltaPercent(cur, prev);
}

const cov = (s: AnalyticsSummary, k: "estimated_revenue_orders" | "estimated_profit_orders" | "actual_profit_orders") => coverageRatio(s[k], s.order_count);

// ============================================================ KPI

export async function KpiSection({ ctx }: { ctx: AnalyticsContext }) {
  const db = createAdminClient();
  const res = await loadSection("kpi", () =>
    Promise.all([getAnalyticsSummary(db, ctx.scope, ctx.period), getAnalyticsSummary(db, ctx.scope, ctx.previous), getCashflowAnalytics(db, ctx.scope, ctx.period)]),
  );
  if (!res.ok) return <SectionFailed title="Chỉ số chính" />;
  const [s, p, cash] = res.data;
  const actualCov = cov(s, "actual_profit_orders");
  return (
    <div className="space-y-3">
      {s.order_count === 0 ? (
        <EmptyState icon={ShoppingBag} title="Chưa có đơn hàng trong khoảng thời gian này." description="Các chỉ số bán hàng và lợi nhuận sẽ hiện khi có đơn. Dòng tiền bên dưới tính theo ngày giải ngân / payout." />
      ) : (
        <>
          <KpiGrid>
            <KpiCard
              label="Đơn hàng"
              value={s.order_count.toLocaleString("vi-VN")}
              delta={deltaPercent(String(s.order_count), String(p.order_count))}
              direction="up_good"
              previousLabel={ctx.previousLabel}
              sub={s.cancelled_count ? `${s.cancelled_count} đơn huỷ (không tính)` : `${formatQuantity(s.units)} sản phẩm`}
              hint="Đơn đã thanh toán, không tính đơn huỷ / chưa thanh toán. Theo ngày tạo đơn (giờ VN)."
            />
            <KpiCard
              label="Giá trị đơn hàng"
              value={formatMoney(s.order_value)}
              delta={deltaPercent(s.order_value, p.order_value)}
              direction="up_good"
              previousLabel={ctx.previousLabel}
              hint="Tổng giá trị đơn Shopee (channel_total_amount). KHÔNG phải doanh thu của người bán."
            />
            <KpiCard
              label="DT Shopee ước tính"
              value={formatMoney(s.estimated_revenue)}
              delta={safeDelta(s.estimated_revenue, p.estimated_revenue, cov(s, "estimated_revenue_orders"), cov(p, "estimated_revenue_orders"))}
              direction="up_good"
              previousLabel={ctx.previousLabel}
              sub={`Có dữ liệu: ${coverageText(s.estimated_revenue_orders, s.order_count)}`}
              hint="“Doanh thu đơn hàng ước tính” của Shopee — chỉ cộng các đơn đã có số; đơn chưa có KHÔNG tính là 0."
            />
            <KpiCard
              label="LN dự kiến"
              value={formatSignedMoney(s.estimated_profit)}
              valueTone={isNegative(s.estimated_profit) ? "danger" : undefined}
              delta={safeDelta(s.estimated_profit, p.estimated_profit, cov(s, "estimated_profit_orders"), cov(p, "estimated_profit_orders"))}
              direction="up_good"
              previousLabel={ctx.previousLabel}
              sub={`Margin ${formatPct(s.estimated_margin)} · ${coverageText(s.estimated_profit_orders, s.order_count)}`}
              hint="DT ước tính − giá vốn, trên các đơn có đủ cả hai. Margin = Σ LN / Σ giá trị đơn của chính các đơn đó."
            />
          </KpiGrid>
          <KpiGrid>
            <KpiCard
              label="LN thực tế"
              value={formatSignedMoney(s.actual_profit)}
              valueTone={isNegative(s.actual_profit) ? "danger" : undefined}
              delta={safeDelta(s.actual_profit, p.actual_profit, actualCov, cov(p, "actual_profit_orders"))}
              direction="up_good"
              previousLabel={ctx.previousLabel}
              sub={`${s.actual_profit_orders.toLocaleString("vi-VN")} / ${s.order_count.toLocaleString("vi-VN")} đơn đã final tài chính`}
              hint="Thu nhập Shopee thực tế (quyết toán) − giá vốn ròng (đã trừ hàng trả nhập lại kho). Chỉ đơn đã có quyết toán."
            />
            <KpiCard
              label="Margin thực tế"
              value={formatPct(s.actual_margin)}
              sub={`Giá vốn ròng ${formatMoney(s.net_cogs)} (gốc ${formatMoney(s.original_cogs)} − hoàn ${formatMoney(s.reversed_cogs)})`}
              hint="Σ LN thực tế / Σ giá trị đơn của các đơn đã final × 100 — có trọng số, không phải trung bình % từng đơn."
            />
            <KpiCard
              label="Chờ Shopee giải ngân"
              value={formatMoney(cash.pending_amount)}
              sub={`${cash.pending_orders} đơn hoàn thành${cash.stale_orders ? ` · ${cash.stale_orders} chờ quá lâu` : ""} (hiện tại)`}
              valueTone={cash.stale_orders ? "warning" : undefined}
              href={`/shopee/analytics/cashflow${ctx.qs}`}
              hint="Thu nhập thực tế của các đơn đã hoàn thành mà Shopee chưa báo giải ngân — số tại thời điểm hiện tại, không theo kỳ."
            />
            <KpiCard
              label="Payout lệch đối soát"
              value={cash.open_mismatch_payouts.toLocaleString("vi-VN")}
              valueTone={cash.open_mismatch_payouts ? "danger" : undefined}
              sub={cash.open_mismatch_payouts ? `Tổng lệch ${formatMoney(cash.open_mismatch_value)} · chưa xử lý` : "Không có payout lệch chưa xử lý"}
              href="/shopee/payouts?status=mismatch"
            />
          </KpiGrid>
          {actualCov !== null && actualCov < ENOUGH && (
            <Callout tone="info">
              Dữ liệu lợi nhuận thực tế mới hoàn tất cho {Math.round(actualCov * 100)}% đơn trong kỳ ({s.actual_profit_orders}/{s.order_count}). LN thực tế chưa phải kết quả cả kỳ — đừng so trực tiếp với LN dự kiến (khác tập đơn).
            </Callout>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================ TREND

const bucketLabel = (b: string, bucket: string) => (bucket === "hour" ? b.slice(11, 16) : `${b.slice(8, 10)}/${b.slice(5, 7)}`);

export async function TrendSection({ ctx, withMargin = true }: { ctx: AnalyticsContext; withMargin?: boolean }) {
  const bucket = chooseBucket(ctx.period.from, ctx.period.to);
  const res = await loadSection("trend", () => getAnalyticsTrend(createAdminClient(), ctx.scope, ctx.period, bucket));
  if (!res.ok) return <SectionFailed title="Xu hướng lợi nhuận" />;
  const pts = res.data;
  const profitPoints = pts.map((p) => ({
    label: bucketLabel(p.bucket, bucket),
    values: { est: chartNumber(p.estimated_profit), act: chartNumber(p.actual_profit), value: chartNumber(p.order_value), rev: chartNumber(p.estimated_revenue) },
    display: { est: formatSignedMoney(p.estimated_profit), act: formatSignedMoney(p.actual_profit), value: formatMoney(p.order_value), rev: formatMoney(p.estimated_revenue) },
  }));
  const marginPoints = pts.map((p) => ({
    label: bucketLabel(p.bucket, bucket),
    values: { est: chartNumber(p.estimated_margin), act: chartNumber(p.actual_margin), orders: p.orders },
    display: { est: formatPct(p.estimated_margin), act: formatPct(p.actual_margin), orders: String(p.orders) },
  }));
  const unit = bucket === "hour" ? "giờ" : bucket === "day" ? "ngày" : bucket === "week" ? "tuần" : "tháng";
  return (
    <div className={withMargin ? "grid gap-4 xl:grid-cols-3" : ""}>
      <AnalyticsSection className="xl:col-span-2" title="Xu hướng lợi nhuận" description={`Theo ${unit} tạo đơn (giờ VN). Mặc định: LN dự kiến và LN thực tế — bật thêm giá trị đơn / DT ước tính nếu cần.`}>
        <TrendChart
          title="Lợi nhuận theo thời gian"
          points={profitPoints}
          series={[
            { key: "est", label: "LN dự kiến", color: COLORS.estimated, dash: "6 4" },
            { key: "act", label: "LN thực tế", color: COLORS.actual },
            { key: "value", label: "Giá trị đơn", color: COLORS.value, dash: "2 3" },
            { key: "rev", label: "DT ước tính", color: COLORS.revenue, dash: "10 3 2 3" },
          ]}
          defaultVisible={["est", "act"]}
        />
      </AnalyticsSection>
      {withMargin && (
        <AnalyticsSection title="Margin theo thời gian" description="Σ lợi nhuận / Σ giá trị đơn mỗi mốc (có trọng số).">
          <TrendChart
            title="Margin theo thời gian"
            unit="%"
            points={marginPoints}
            series={[
              { key: "est", label: "Margin dự kiến", color: COLORS.estimated, dash: "6 4" },
              { key: "act", label: "Margin thực tế", color: COLORS.actual },
            ]}
          />
        </AnalyticsSection>
      )}
    </div>
  );
}

/** Orders per bucket (sales trend). */
export async function SalesTrendSection({ ctx }: { ctx: AnalyticsContext }) {
  const bucket = chooseBucket(ctx.period.from, ctx.period.to);
  const res = await loadSection("sales-trend", () => getAnalyticsTrend(createAdminClient(), ctx.scope, ctx.period, bucket));
  if (!res.ok) return <SectionFailed title="Xu hướng bán hàng" />;
  return (
    <AnalyticsSection title="Xu hướng bán hàng" description="Số đơn và giá trị đơn theo thời gian tạo đơn.">
      <TrendChart
        title="Số đơn theo thời gian"
        points={res.data.map((p) => ({ label: bucketLabel(p.bucket, bucket), values: { orders: p.orders }, display: { orders: String(p.orders) } }))}
        series={[{ key: "orders", label: "Số đơn", color: COLORS.revenue }]}
      />
    </AnalyticsSection>
  );
}

// ============================================================ PRODUCTS

export async function TopProductsSection({ ctx, limit = 5 }: { ctx: AnalyticsContext; limit?: number }) {
  const db = createAdminClient();
  const res = await loadSection("top-products", async () => {
    const summary = await getAnalyticsSummary(db, ctx.scope, ctx.period);
    const sort = defaultProductSort(summary);
    const [top, units] = await Promise.all([getProductAnalytics(db, ctx.scope, ctx.period, { sort, limit }), getProductAnalytics(db, ctx.scope, ctx.period, { sort: "units", limit })]);
    return { sort, top, units };
  });
  if (!res.ok) return <SectionFailed title="SKU nổi bật" />;
  const { sort, top, units } = res.data;
  const profitKey = sort === "actual_profit" ? "actual_profit" : "estimated_profit";
  return (
    <AnalyticsSection
      title="SKU nổi bật"
      description={`SKU bán (combo là một SKU riêng). Xếp theo ${sort === "actual_profit" ? "LN thực tế" : "LN dự kiến (dữ liệu thực tế chưa đủ)"}.`}
      actions={
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/shopee/analytics/products${ctx.qs}`} />}>
          Tất cả SKU
        </Button>
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm font-medium">Lợi nhuận cao nhất</p>
          <BarList
            emptyText="Chưa có SKU nào đủ dữ liệu."
            items={top.rows.map((r) => ({
              key: r.product_id,
              href: `/shopee/analytics/products/${r.product_id}${ctx.qs}`,
              label: (
                <>
                  <span className="font-mono text-xs">{r.sku}</span>
                  {r.product_type === "combo" && <span className="ml-1 text-xs text-info-text">Combo</span>}
                </>
              ),
              magnitude: chartNumber(r[profitKey]) ?? 0,
              value: formatSignedMoney(r[profitKey]),
              negative: isNegative(r[profitKey]),
              sub: `${formatQuantity(r.units)} sp · ${r.orders} đơn · margin ${formatPct(sort === "actual_profit" ? r.actual_margin : r.estimated_margin)}`,
            }))}
          />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Bán chạy nhất (số lượng)</p>
          <BarList
            items={units.rows.map((r) => ({
              key: r.product_id,
              href: `/shopee/analytics/products/${r.product_id}${ctx.qs}`,
              label: (
                <>
                  <span className="font-mono text-xs">{r.sku}</span>
                  {r.product_type === "combo" && <span className="ml-1 text-xs text-info-text">Combo</span>}
                </>
              ),
              magnitude: chartNumber(r.units) ?? 0,
              value: `${formatQuantity(r.units)} sp`,
              sub: `Giá trị ${formatMoney(r.order_value)}`,
            }))}
          />
        </div>
      </div>
    </AnalyticsSection>
  );
}

// ============================================================ LOSS / RISK

export async function RiskSection({ ctx }: { ctx: AnalyticsContext }) {
  const db = createAdminClient();
  const res = await loadSection("risk", () => Promise.all([getLossOrders(db, ctx.scope, ctx.period, 5), getProductAnalytics(db, ctx.scope, ctx.period, { attention: true, sort: "estimated_margin", desc: false, limit: 5 }), getAnalyticsSettings(db)]));
  if (!res.ok) return <SectionFailed title="Rủi ro bán lỗ" />;
  const [loss, attention, settings] = res.data;
  return (
    <AnalyticsSection
      title="Rủi ro bán lỗ"
      description={`Đơn có nguy cơ lỗ và SKU cần chú ý (LN âm hoặc margin dưới ${formatPct(settings.lowMarginThresholdPct)}).`}
      actions={
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/shopee/analytics/profitability${ctx.qs}`} />}>
          Phân tích lợi nhuận
        </Button>
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm font-medium">Đơn có nguy cơ bán lỗ ({loss.total})</p>
          {loss.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Không có đơn lỗ trong kỳ.</p>
          ) : (
            <ul className="divide-y text-sm">
              {loss.rows.map((o) => (
                <li key={o.order_id} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="min-w-0">
                    <Link href={`/shopee/orders/${o.order_id}`} className="font-mono text-xs text-primary underline-offset-4 hover:underline">
                      {o.external_order_sn}
                    </Link>
                    <StatusBadge className="ml-2" tone={o.loss_state === "actual_loss" ? "danger" : "warning"} icon={false}>
                      {o.loss_state === "actual_loss" ? "Lỗ thực tế" : "Dự kiến lỗ"}
                    </StatusBadge>
                  </span>
                  <span className="shrink-0 text-danger-text tabular-nums">{formatSignedMoney(o.loss_state === "actual_loss" ? o.actual_profit : o.estimated_profit)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">SKU cần chú ý ({attention.total})</p>
          {attention.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Không có SKU nào lỗ hoặc dưới ngưỡng margin.</p>
          ) : (
            <ul className="divide-y text-sm">
              {attention.rows.map((r) => (
                <li key={r.product_id} className="flex items-baseline justify-between gap-3 py-1.5">
                  <Link href={`/shopee/analytics/products/${r.product_id}${ctx.qs}`} className="min-w-0 truncate font-mono text-xs underline-offset-4 hover:underline">
                    {r.sku}
                  </Link>
                  <span className="shrink-0 text-xs tabular-nums">
                    {formatSignedMoney(r.actual_profit ?? r.estimated_profit)} · {formatPct(r.actual_margin ?? r.estimated_margin)} {r.actual_margin ? "(thực tế)" : "(dự kiến)"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AnalyticsSection>
  );
}

// ============================================================ RETURNS

export async function ReturnsSection({ ctx }: { ctx: AnalyticsContext }) {
  const res = await loadSection("returns", () => getReturnsAnalytics(createAdminClient(), ctx.scope, ctx.period));
  if (!res.ok) return <SectionFailed title="Trả hàng" />;
  const r = res.data;
  return (
    <AnalyticsSection
      title="Trả hàng"
      description="Yêu cầu trả hàng theo ngày tạo yêu cầu; tỷ lệ trả theo các đơn tạo trong kỳ."
      actions={
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/shopee/analytics/returns${ctx.qs}`} />}>
          Chi tiết
        </Button>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Stat label="Yêu cầu trả hàng" value={`${r.return_count}`} sub={`${formatQuantity(r.returned_units)} sp`} />
        <Stat label="Tỷ lệ trả (theo sản phẩm)" value={formatPct(r.unit_return_rate)} sub={`${formatQuantity(r.cohort_returned_units)} / ${formatQuantity(r.cohort_units)} sp đã bán`} />
        <Stat label="Nhập lại kho / hỏng · mất" value={`${formatQuantity(r.restocked_units)} / ${formatQuantity(String(Number(r.damaged_units) + Number(r.lost_units) + Number(r.disposed_units)))}`} sub={Number(r.pending_units) ? `${formatQuantity(r.pending_units)} sp chờ xử lý` : undefined} />
        <Stat label="Giá vốn không thu hồi" value={formatMoney(r.cogs_not_recovered)} sub={`Đã hoàn ${formatMoney(r.cogs_reversed)} / liên quan ${formatMoney(r.cogs_involved)}`} danger={Number(r.cogs_not_recovered) > 0} />
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">Hoàn tiền tham khảo {formatMoney(r.refund_amount_reference)} — đã nằm trong thu nhập thực tế (quyết toán), không trừ thêm lần nữa.</p>
    </AnalyticsSection>
  );
}

function Stat({ label, value, sub, danger }: { label: string; value: React.ReactNode; sub?: React.ReactNode; danger?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`text-base font-semibold tabular-nums ${danger ? "text-danger-text" : ""}`}>{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}

// ============================================================ CASHFLOW

export const agingLabel = (lo: number, hi: number | null) => (hi === null ? `> ${lo} ngày` : lo === 0 ? `0–${hi} ngày` : `${lo + 1}–${hi} ngày`);

export async function CashflowSection({ ctx }: { ctx: AnalyticsContext }) {
  const res = await loadSection("cashflow", () => getCashflowAnalytics(createAdminClient(), ctx.scope, ctx.period));
  if (!res.ok) return <SectionFailed title="Dòng tiền" />;
  const c = res.data;
  const st = c.payouts_by_status;
  return (
    <AnalyticsSection
      title="Dòng tiền Shopee"
      description="Theo ngày giải ngân / ngày payout — không theo ngày tạo đơn. Chờ giải ngân là số hiện tại."
      actions={
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/shopee/analytics/cashflow${ctx.qs}`} />}>
          Chi tiết
        </Button>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Stat label="Đã giải ngân trong kỳ" value={formatMoney(c.released_amount)} sub={`${c.released_orders} đơn`} />
        <Stat label="Payout trong kỳ" value={formatMoney(c.payout_amount)} sub={`${c.payout_count} lần chuyển`} />
        <Stat label="Payout khớp / thiếu dữ liệu / lệch" value={`${st.matched ?? 0} / ${st.incomplete ?? 0} / ${st.mismatch ?? 0}`} sub="payout trong kỳ" />
        <Stat label="Lệch chưa xử lý" value={formatMoney(c.open_mismatch_value)} sub={`${c.open_mismatch_payouts} payout`} danger={c.open_mismatch_payouts > 0} />
      </dl>
      <p className="mt-4 mb-2 text-sm font-medium">Đơn chờ giải ngân theo số ngày từ khi hoàn thành</p>
      <BarList
        emptyText="Không có đơn chờ giải ngân."
        items={c.aging.map((a) => ({
          key: String(a.bucket),
          href: `/shopee/analytics/cashflow${ctx.qs}${ctx.qs ? "&" : "?"}aging=${a.bucket}`,
          label: agingLabel(a.lower_days, a.upper_days),
          magnitude: a.orders,
          value: `${a.orders} đơn · ${formatMoney(a.amount)}`,
          sub: a.without_amount ? `${a.without_amount} đơn chưa có quyết toán` : undefined,
        }))}
      />
    </AnalyticsSection>
  );
}

// ============================================================ DATA QUALITY

export async function DataQualitySection({ ctx }: { ctx: AnalyticsContext }) {
  const res = await loadSection("quality", () => getDataQuality(createAdminClient(), ctx.scope, ctx.period));
  if (!res.ok) return <SectionFailed title="Chất lượng dữ liệu" />;
  const q = res.data;
  const fs = q.financial_status;
  const cards: Array<{ label: string; value: number; href: string; hint?: string }> = [
    { label: "Đơn thiếu ghép SKU", value: q.unmapped_orders, href: ordersHref(ctx, { mapping: "unmapped" }), hint: `${q.unmapped_models_in_orders} mẫu chưa ghép có trong đơn` },
    { label: "Đơn thiếu giá vốn", value: q.missing_cogs_orders, href: ordersHref(ctx, { fin: "no_cogs" }) },
    { label: "Đơn thiếu DT ước tính", value: q.missing_estimated_orders, href: ordersHref(ctx, { est: "insufficient" }) },
    { label: "Đơn chờ quyết toán", value: q.awaiting_actual_orders, href: ordersHref(ctx, { status: "COMPLETED", fin: "settlement_missing" }), hint: "đã hoàn thành, chưa có thu nhập thực tế" },
    { label: "Đơn lệch đối soát tài chính", value: q.mismatch_orders, href: ordersHref(ctx, { fin: "mismatch" }) },
    { label: "Trả hàng chờ xử lý", value: q.returns_pending_disposition, href: "/shopee/returns?disposition=pending", hint: "toàn bộ, không theo kỳ" },
    { label: "Payout thiếu dữ liệu", value: q.payouts_incomplete, href: "/shopee/payouts?status=incomplete" },
    { label: "Payout lệch", value: q.payouts_mismatch, href: "/shopee/payouts?status=mismatch" },
  ];
  return (
    <AnalyticsSection title="Chất lượng dữ liệu" description="Các con số trên chỉ đúng khi dữ liệu đủ. Bấm vào từng ô để xử lý.">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <KpiCard key={c.label} label={c.label} value={c.value.toLocaleString("vi-VN")} valueTone={c.value > 0 ? "warning" : undefined} href={c.href} sub={c.hint} />
        ))}
      </div>
      <div className="mt-4 grid gap-4 text-sm md:grid-cols-3">
        <div>
          <p className="font-medium">Ghép SKU</p>
          <p className="text-muted-foreground">
            {q.models_mapped}/{q.models_active} mẫu đang bán đã ghép ·{" "}
            <Link href="/shopee/products?mapping=unmapped" className="underline underline-offset-4">
              {q.models_unmapped} chưa ghép
            </Link>
          </p>
        </div>
        <div>
          <p className="font-medium">Giá vốn</p>
          <p className="text-muted-foreground">
            {q.sold_products_no_cost} SP bán ra chưa có giá vốn ·{" "}
            <Link href="/inventory/costs?warning=negative" className="underline underline-offset-4">
              {q.products_negative_stock} tồn âm
            </Link>{" "}
            ·{" "}
            <Link href="/inventory/costs?warning=provisional" className="underline underline-offset-4">
              {q.products_provisional} tạm tính VAT
            </Link>
            {q.products_needs_rebuild ? ` · ${q.products_needs_rebuild} cần dựng lại` : ""}
          </p>
        </div>
        <div>
          <p className="font-medium">Trạng thái tài chính (đơn trong kỳ)</p>
          <p className="text-muted-foreground">
            {Object.keys(fs).length === 0
              ? "—"
              : Object.entries(fs)
                  .map(([k, n]) => `${FIN_LABEL[k] ?? k}: ${n}`)
                  .join(" · ")}
          </p>
        </div>
      </div>
    </AnalyticsSection>
  );
}

const FIN_LABEL: Record<string, string> = {
  pending: "chờ dữ liệu",
  estimated: "đã ước tính",
  settlement_available: "có quyết toán",
  released: "đã giải ngân",
  mismatch: "lệch",
  return_adjusted: "điều chỉnh trả hàng",
};

// ============================================================ SHOPS

export async function ShopComparisonSection({ ctx }: { ctx: AnalyticsContext }) {
  if (ctx.scope.selectedShopId || ctx.scope.shopIds.length < 2) return null;
  const res = await loadSection("shops", () => getShopComparison(createAdminClient(), ctx.scope, ctx.period));
  if (!res.ok) return <SectionFailed title="So sánh shop" />;
  return (
    <AnalyticsSection title="So sánh shop" description="Xếp theo LN thực tế. Shop chưa đủ dữ liệu thực tế: xem LN dự kiến (ghi rõ).">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Shop</TableHead>
            <TableHead className="text-right">Đơn</TableHead>
            <TableHead className="text-right">Giá trị đơn</TableHead>
            <TableHead className="text-right">DT ước tính</TableHead>
            <TableHead className="text-right">LN dự kiến</TableHead>
            <TableHead className="text-right">LN thực tế</TableHead>
            <TableHead className="text-right">Margin TT</TableHead>
            <TableHead className="text-right">Tỷ lệ trả</TableHead>
            <TableHead className="text-right">Chờ giải ngân</TableHead>
            <TableHead className="text-right">Payout lệch</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {res.data.map((s) => (
            <TableRow key={s.shop_id}>
              <TableCell className="max-w-40 truncate">{s.shop_name}</TableCell>
              <TableCell className="text-right">{s.orders}</TableCell>
              <TableCell className="text-right">{formatMoney(s.order_value)}</TableCell>
              <TableCell className="text-right">{formatMoney(s.estimated_revenue)}</TableCell>
              <TableCell className="text-right">{formatSignedMoney(s.estimated_profit)}</TableCell>
              <TableCell className="text-right">
                {formatSignedMoney(s.actual_profit)}
                <span className="block text-xs text-muted-foreground">
                  {s.actual_profit_orders}/{s.orders} đơn
                </span>
              </TableCell>
              <TableCell className="text-right">{formatPct(s.actual_margin)}</TableCell>
              <TableCell className="text-right">{formatPct(s.unit_return_rate)}</TableCell>
              <TableCell className="text-right">{formatMoney(s.pending_release_amount)}</TableCell>
              <TableCell className="text-right">{s.payout_mismatch}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </AnalyticsSection>
  );
}

// ============================================================ STATUS MIX

export async function StatusMixSection({ ctx }: { ctx: AnalyticsContext }) {
  const res = await loadSection("status-mix", () => getOrderStatusMix(createAdminClient(), ctx.scope, ctx.period));
  if (!res.ok) return <SectionFailed title="Trạng thái đơn" />;
  const total = res.data.reduce((s, r) => s + r.orders, 0);
  const cancelled = res.data.find((r) => r.order_status === "CANCELLED")?.orders ?? 0;
  return (
    <AnalyticsSection title="Trạng thái đơn" description={`Mọi đơn tạo trong kỳ. Tỷ lệ huỷ = đơn huỷ / mọi đơn tạo: ${total ? formatPct(((cancelled / total) * 100).toFixed(1)) : "—"} (${cancelled}/${total}).`}>
      <BarList
        emptyText="Chưa có đơn."
        items={res.data.map((r) => ({
          key: r.order_status,
          label: `${ORDER_STATUS_LABELS[r.order_status] ?? r.order_status}${r.is_sales ? "" : " (không tính doanh số)"}`,
          magnitude: r.orders,
          value: `${r.orders} đơn`,
          sub: formatMoney(r.order_value),
        }))}
      />
    </AnalyticsSection>
  );
}
