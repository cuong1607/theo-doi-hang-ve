// UIUX-1 dashboard: Shopee KPIs for the selected date range (database
// only — the same summary RPC as /shopee/orders). Rendered inside
// <Suspense> so the receipt/invoice dashboard never waits for it.
import Link from "next/link";
import { Coins, PackageCheck, ReceiptText, Scale, TrendingUp, Wallet } from "lucide-react";

import { getOrderFinancialSummary } from "@/lib/channels/core/order-queries";
import { formatCurrency, numericSign } from "@/lib/ui/format";
import { profitTone } from "@/lib/ui/status";
import { MetricCard, MetricGrid } from "@/components/patterns/metric-card";
import { SectionHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";

export async function ShopeeKpis({ fromDate, toDate }: { fromDate: string; toDate: string }) {
  const s = await getOrderFinancialSummary({ dateFrom: fromDate, dateTo: toDate });
  const ordersHref = `/shopee/orders?from=${fromDate}&to=${toDate}`;
  return (
    <section className="space-y-3">
      <SectionHeader
        title="Shopee"
        description="Đơn Shopee theo ngày đặt trong khoảng lọc. Lợi nhuận chỉ tính trên đơn có đủ thu nhập + giá vốn."
        actions={
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={ordersHref} />}>
            Xem đơn hàng
          </Button>
        }
      />
      <MetricGrid>
        <MetricCard label="Đơn hàng" icon={ReceiptText} value={s.orderCount.toLocaleString("vi-VN")} />
        <MetricCard label="Thu nhập Shopee" icon={Wallet} value={formatCurrency(s.incomeSum)} hint={`${s.withIncome} đơn có settlement`} />
        <MetricCard label="Giá vốn (COGS)" icon={Coins} value={formatCurrency(s.cogsSum)} hint={`${s.withCogs} đơn đã tính`} />
        <MetricCard label="Lợi nhuận sau giá vốn" icon={TrendingUp} value={formatCurrency(s.profitSum)} tone={profitTone(numericSign(s.profitSum))} hint={`${s.withProfit} đơn đủ số liệu`} />
        <MetricCard
          label="Thiếu tài chính"
          icon={PackageCheck}
          value={`${s.missingSettlement} / ${s.missingCogs}`}
          tone={s.missingSettlement + s.missingCogs > 0 ? "warning" : "neutral"}
          hint="thiếu settlement / thiếu giá vốn"
        />
        <MetricCard label="Lệch đối soát" icon={Scale} value={s.mismatchCount} tone={s.mismatchCount > 0 ? "danger" : "neutral"} />
      </MetricGrid>
    </section>
  );
}
