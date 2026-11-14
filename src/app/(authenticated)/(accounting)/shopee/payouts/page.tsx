import { Banknote, Clock, Landmark, TriangleAlert, Wallet } from "lucide-react";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/session";
import { INCOMPLETE_REASON_LABEL, PAYOUT_RECON_INFO, PAYOUT_SOURCE_LABEL, PAYOUT_STATUS_LABEL } from "@/lib/channels/core/payout-display";
import { getCashflowSummary, getLatestIncomeOverviews, isPayoutReconciliationStatus, listPayouts, type PayoutListFilters } from "@/lib/channels/core/payouts";
import { listShops } from "@/lib/channels/core/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency, formatDateTime, formatSignedCurrency } from "@/lib/ui/format";
import { activeFilterCount, parsePage, parsePageSize } from "@/lib/ui/list-query";
import { AutoRefresh } from "@/components/patterns/auto-refresh";
import { Callout } from "@/components/patterns/callout";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { MetricCard } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { PayoutFilters } from "./payout-filters";

export const dynamic = "force-dynamic";

type Params = { shop?: string; status?: string; from?: string; to?: string; q?: string; page?: string; size?: string };
const FILTER_KEYS = ["shop", "status", "from", "to", "q"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ShopeePayoutsPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requirePermission("channel:view");
  const params = await searchParams;
  const pageSize = parsePageSize(params.size);
  const page = parsePage(params.page);
  const filters: PayoutListFilters = {
    shopId: params.shop || undefined,
    status: isPayoutReconciliationStatus(params.status) ? params.status : undefined,
    dateFrom: params.from && DATE.test(params.from) ? params.from : undefined,
    dateTo: params.to && DATE.test(params.to) ? params.to : undefined,
    search: params.q?.trim() || undefined,
  };
  const db = createAdminClient();
  const allShops = (await listShops()).filter((s) => s.channel === "shopee");
  const [{ rows, total }, metrics, overviews, active, mismatch] = await Promise.all([
    listPayouts(db, filters, page, pageSize),
    getCashflowSummary(db, { shopId: filters.shopId ?? null, from: filters.dateFrom ?? null, to: filters.dateTo ?? null }),
    getLatestIncomeOverviews(db, allShops.map((s) => s.id)),
    db.from("channel_sync_jobs").select("id", { count: "exact", head: true }).in("sync_type", ["income", "payout"]).in("status", ["pending", "running", "retry"]),
    (() => {
      let q = db.from("v_order_income_status").select("order_id, external_order_sn, difference_amount").eq("income_status", "mismatch");
      if (filters.shopId) q = q.eq("shop_id", filters.shopId);
      return q.order("actual_payout_time", { ascending: false }).limit(10);
    })(),
  ]);
  const mismatchOrders = (mismatch.data ?? []) as Array<{ order_id: string; external_order_sn: string; difference_amount: string | null }>;
  const query: Record<string, string | undefined> = { shop: params.shop, status: params.status, from: params.from, to: params.to, q: params.q, size: params.size };
  const filtered = activeFilterCount(query, FILTER_KEYS) > 0;
  const periodLabel = filters.dateFrom || filters.dateTo ? "trong kỳ lọc" : "toàn bộ";

  return (
    <PageContainer>
      <PageHeader
        title="Giải ngân & payout Shopee"
        description="Dòng tiền Shopee: đơn nào đã được giải ngân, các lần Shopee chuyển tiền (payout / rút tiền từ Ví Shopee) và đối soát số tiền. Đây là dòng tiền, không phải lãi — lãi của đơn vẫn tính theo quyết toán (escrow) + giá vốn. Hệ thống chỉ biết Shopee đã chuyển, không xác nhận tiền đã về tài khoản ngân hàng."
        meta={<AutoRefresh active={(active.count ?? 0) > 0} />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricCard icon={Clock} label="Chờ giải ngân" value={formatCurrency(metrics.pendingAmount)} hint={`${metrics.pendingOrders} đơn${metrics.pendingWithoutAmount ? ` · ${metrics.pendingWithoutAmount} đơn chưa có quyết toán` : ""}`} />
        <MetricCard icon={Banknote} label="Đã giải ngân hôm nay" value={formatCurrency(metrics.releasedTodayAmount)} hint={`${metrics.releasedTodayOrders} đơn`} tone="success" />
        <MetricCard icon={Landmark} label={`Tổng payout (${periodLabel})`} value={formatCurrency(metrics.payoutPeriodAmount)} hint={`${metrics.payoutPeriodCount} lần chuyển`} />
        <MetricCard icon={Wallet} label="Payout chưa đối soát" value={String(metrics.payoutsUnreconciled)} hint="chờ hoàn tất / thiếu dữ liệu" tone={metrics.payoutsUnreconciled ? "warning" : "neutral"} />
        <MetricCard icon={TriangleAlert} label="Payout lệch" value={String(metrics.payoutsMismatch)} hint="chưa xử lý" tone={metrics.payoutsMismatch ? "danger" : "neutral"} />
      </div>

      {(metrics.payoutsMismatch > 0 || metrics.releaseMismatchOrders > 0 || metrics.staleOrders > 0) && (
        <Callout tone={metrics.payoutsMismatch || metrics.releaseMismatchOrders ? "danger" : "warning"} title="Cần kiểm tra">
          <ul className="list-disc space-y-0.5 pl-5">
            {metrics.payoutsMismatch > 0 && <li>{metrics.payoutsMismatch} payout lệch số tiền chưa được xử lý.</li>}
            {metrics.releaseMismatchOrders > 0 && (
              <li>
                {metrics.releaseMismatchOrders} đơn có số giải ngân khác thu nhập thực tế:{" "}
                {mismatchOrders.map((o, i) => (
                  <span key={o.order_id}>
                    {i > 0 && ", "}
                    <Link href={`/shopee/orders/${o.order_id}`} className="font-mono underline underline-offset-4">
                      {o.external_order_sn}
                    </Link>{" "}
                    ({formatSignedCurrency(o.difference_amount)})
                  </span>
                ))}
                {metrics.releaseMismatchOrders > mismatchOrders.length && " …"}
              </li>
            )}
            {metrics.staleOrders > 0 && <li>{metrics.staleOrders} đơn đã hoàn thành quá lâu mà Shopee vẫn chưa giải ngân.</li>}
          </ul>
        </Callout>
      )}

      {overviews.size > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Tổng quan thu nhập Shopee (tham khảo)</CardTitle>
            <CardDescription>
              Số tổng Shopee báo (get_income_overview) so với số tổng của các đơn trong hệ thống. Chênh lệch thường do đơn trước mốc đồng bộ hoặc kỳ tính của Shopee — chỉ để theo dõi, không tự sửa dữ liệu đơn.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  {allShops.length > 1 && <TableHead>Shop</TableHead>}
                  <TableHead className="text-right">Chờ giải ngân (Shopee)</TableHead>
                  <TableHead className="text-right">Chờ giải ngân (hệ thống)</TableHead>
                  <TableHead className="text-right">Đã giải ngân (Shopee)</TableHead>
                  <TableHead className="text-right">Đã giải ngân (hệ thống)</TableHead>
                  <TableHead>Cập nhật</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allShops
                  .filter((s) => overviews.has(s.id))
                  .map((s) => {
                    const o = overviews.get(s.id)!;
                    return (
                      <TableRow key={s.id}>
                        {allShops.length > 1 && <TableCell className="text-xs">{s.shopName}</TableCell>}
                        <TableCell className="text-right">{o.pendingAmount === null ? "—" : formatCurrency(o.pendingAmount)}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(o.localPendingAmount)}
                          <span className="block text-xs text-muted-foreground">{o.localPendingOrders} đơn{o.pendingDifference && o.pendingDifference !== "0.00" ? ` · lệch ${formatSignedCurrency(o.pendingDifference)}` : ""}</span>
                        </TableCell>
                        <TableCell className="text-right">{o.releasedAmount === null ? "—" : formatCurrency(o.releasedAmount)}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(o.localReleasedAmount)}
                          {o.releasedDifference && o.releasedDifference !== "0.00" && <span className="block text-xs text-muted-foreground">lệch {formatSignedCurrency(o.releasedDifference)}</span>}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{formatDateTime(o.fetchedAt)}</TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-4 pt-6">
          <PayoutFilters query={query} shops={allShops.map((s) => ({ id: s.id, name: s.shopName }))} />
          {rows.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title={filtered ? "Không có payout phù hợp." : "Chưa có payout nào."}
              description={filtered ? undefined : "Payout được đồng bộ tự động mỗi giờ (shop Việt Nam: mỗi lần rút tiền từ Ví Shopee là một payout)."}
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Thời gian</TableHead>
                    <TableHead>Mã payout</TableHead>
                    {allShops.length > 1 && <TableHead>Shop</TableHead>}
                    <TableHead className="text-right">Số tiền</TableHead>
                    <TableHead className="text-right">Đơn</TableHead>
                    <TableHead className="text-right">Điều chỉnh</TableHead>
                    <TableHead className="text-right">Kỳ vọng</TableHead>
                    <TableHead className="text-right">Chênh lệch</TableHead>
                    <TableHead>Đối soát</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => {
                    const info = PAYOUT_RECON_INFO[p.reconciliationStatus];
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="text-xs whitespace-nowrap">
                          {formatDateTime(p.payoutTime)}
                          <span className="block text-muted-foreground">{PAYOUT_STATUS_LABEL[p.payoutStatus]}</span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          <Link href={`/shopee/payouts/${p.id}`} className="text-primary underline-offset-4 hover:underline">
                            {p.providerPayoutId}
                          </Link>
                          <span className="block font-sans text-muted-foreground">{PAYOUT_SOURCE_LABEL[p.payoutSource ?? ""] ?? p.payoutSource}</span>
                        </TableCell>
                        {allShops.length > 1 && <TableCell className="max-w-32 truncate text-xs">{p.shopName}</TableCell>}
                        <TableCell className="text-right font-medium">{formatCurrency(p.payoutAmount)}</TableCell>
                        <TableCell className="text-right">
                          {p.orderCount}
                          {p.missingOrderCount > 0 && <span className="block text-xs text-warning-text">{p.missingOrderCount} chưa có</span>}
                        </TableCell>
                        <TableCell className="text-right">{p.adjustmentCount ? <>{formatSignedCurrency(p.adjustmentsTotal)}</> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-right">{p.expectedAmount === null ? "—" : formatCurrency(p.expectedAmount)}</TableCell>
                        <TableCell className={`text-right ${p.reconciliationStatus === "mismatch" ? "text-danger-text font-medium" : ""}`}>{p.differenceAmount === null ? "—" : formatSignedCurrency(p.differenceAmount)}</TableCell>
                        <TableCell>
                          <StatusBadge tone={info.tone} icon={false}>
                            {info.label}
                          </StatusBadge>
                          {p.reconciliationStatus === "incomplete" && p.incompleteReason && <span className="block text-xs text-muted-foreground">{INCOMPLETE_REASON_LABEL[p.incompleteReason] ?? p.incompleteReason}</span>}
                          {p.resolutionStatus !== "open" && <span className="block text-xs text-muted-foreground">{p.resolutionStatus === "accepted" ? "đã chấp nhận" : p.resolutionStatus === "resolved" ? "đã giải quyết" : "đang kiểm tra"}</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <DataTablePagination pathname="/shopee/payouts" query={query} page={page} pageSize={pageSize} total={total} />
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
