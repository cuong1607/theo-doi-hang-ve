// SHOPEE-7 §44: finance operational metrics (cash — release / payout),
// deliberately a separate row from the revenue / profit KPIs above it.
// Streams in (Suspense) like ShopeeKpis.
import Link from "next/link";
import { Banknote, Clock, Landmark, TriangleAlert, Wallet } from "lucide-react";

import { getCashflowSummary } from "@/lib/channels/core/payouts";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency } from "@/lib/ui/format";
import { MetricCard, MetricGrid } from "@/components/patterns/metric-card";
import { SectionHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";

export async function ShopeeCashflow({ fromDate, toDate }: { fromDate: string; toDate: string }) {
  const m = await getCashflowSummary(createAdminClient(), { from: fromDate, to: toDate });
  return (
    <section className="space-y-3">
      <SectionHeader
        title="Dòng tiền Shopee"
        description="Tiền Shopee đã / chưa giải ngân và các lần chuyển tiền (payout) — không phải doanh thu hay lãi. Payout tính theo ngày chuyển trong khoảng lọc."
        actions={
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/shopee/payouts?from=${fromDate}&to=${toDate}`} />}>
            Xem payout
          </Button>
        }
      />
      <MetricGrid>
        <MetricCard label="Chờ giải ngân" icon={Clock} value={formatCurrency(m.pendingAmount)} hint={`${m.pendingOrders} đơn${m.staleOrders ? ` · ${m.staleOrders} chờ quá lâu` : ""}`} tone={m.staleOrders ? "warning" : "neutral"} />
        <MetricCard label="Đã giải ngân hôm nay" icon={Banknote} value={formatCurrency(m.releasedTodayAmount)} hint={`${m.releasedTodayOrders} đơn`} />
        <MetricCard label="Tổng payout trong kỳ" icon={Landmark} value={formatCurrency(m.payoutPeriodAmount)} hint={`${m.payoutPeriodCount} lần chuyển`} />
        <MetricCard label="Payout chưa đối soát" icon={Wallet} value={m.payoutsUnreconciled} tone={m.payoutsUnreconciled ? "warning" : "neutral"} hint="chờ hoàn tất / thiếu dữ liệu" />
        <MetricCard label="Payout lệch" icon={TriangleAlert} value={m.payoutsMismatch} tone={m.payoutsMismatch ? "danger" : "neutral"} hint={m.releaseMismatchOrders ? `${m.releaseMismatchOrders} đơn lệch giải ngân` : "chưa xử lý"} />
      </MetricGrid>
    </section>
  );
}
