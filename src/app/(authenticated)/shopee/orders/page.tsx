import Link from "next/link";
import { AlertTriangle, CircleHelp, Coins, FlaskConical, PackageCheck, ReceiptText, Scale, TrendingUp, Undo2, Wallet } from "lucide-react";
import { getOrdersWithReturns } from "@/lib/channels/core/returns";
import { getOrdersIncomeStatus, type IncomeStatus } from "@/lib/channels/core/payouts";

/** SHOPEE-7: one short word per release state; details live on the order page. */
const RELEASE_BADGE: Partial<Record<IncomeStatus, { label: string; className: string }>> = {
  pending: { label: "Chờ giải ngân", className: "text-muted-foreground" },
  released: { label: "Đã giải ngân", className: "text-info-text" },
  reconciled: { label: "Đã giải ngân", className: "text-success-text" },
  mismatch: { label: "Lệch đối soát", className: "text-danger-text" },
};

function ReleaseBadge({ release }: { release: { incomeStatus: IncomeStatus; releaseStale: boolean } | undefined }) {
  const b = release ? RELEASE_BADGE[release.incomeStatus] : undefined;
  if (!b || !release) return null;
  return (
    <span className={`ml-1.5 text-[11px] ${release.releaseStale ? "text-warning-text" : b.className}`} title={release.releaseStale ? "Hoàn thành quá lâu mà chưa giải ngân" : undefined}>
      · {b.label}
      {release.releaseStale ? " (quá lâu)" : ""}
    </span>
  );
}
import { createAdminClient } from "@/lib/supabase/admin";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getChannelOrders, getOrderFinancialSummary, type ChannelOrderFilters, type EstimatedProfitState, type MappingReadiness } from "@/lib/channels/core/order-queries";
import { listShops } from "@/lib/channels/core/queries";
import { getSyncHealth, getSyncStatuses } from "@/lib/channels/core/sync-status-queries";
import { getShopeeConfig } from "@/lib/channels/shopee/config";
import { ORDER_STATUS_LABELS } from "@/lib/channels/shopee/order-status";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { formatCurrency, formatDateTime, formatPercentString, formatQuantity, formatSignedCurrency, numericSign } from "@/lib/ui/format";
import { activeFilterCount, parsePage, parsePageSize } from "@/lib/ui/list-query";
import { FINANCIAL_STATUS_TONE, ORDER_STATUS_TONE, profitTone, READINESS_TONE, RECONCILIATION_TONE, TONE_TEXT_CLASS, toneOf } from "@/lib/ui/status";
import { AutoRefresh } from "@/components/patterns/auto-refresh";
import { Callout } from "@/components/patterns/callout";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { MetricCard, MetricGrid } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { BackfillButton, SyncNowButton } from "../sync/sync-buttons";
import { FreshnessSummary, hasActiveSync, SchedulerWarning, SyncStatusCell } from "../sync/sync-status";
import { FINANCIAL_STATUS_LABELS, ORDER_FILTER_KEYS, READINESS_LABELS, RECONCILIATION_LABELS } from "./labels";
import { OrderFilters } from "./order-filters";
import { BackfillCogsButton } from "./order-sync-controls";

export const dynamic = "force-dynamic";
// "Đồng bộ ngay" kicks the background worker after responding (after()).
export const maxDuration = 60;

const READINESS = new Set(["complete", "partial", "unmapped"]);
const ESTIMATED_STATES = new Set(["profit", "loss", "insufficient"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Params = { shop?: string; status?: string; mapping?: string; financial?: string; fin?: string; sn?: string; sku?: string; from?: string; to?: string; est?: string; page?: string; size?: string };

/** "Tài chính" filter → view-derived financial filters. */
function finFilter(fin: string | undefined): Partial<ChannelOrderFilters> {
  switch (fin) {
    case "profit":
      return { profitState: "profit" };
    case "loss":
      return { profitState: "loss" };
    case "mismatch":
      return { reconciliation: "mismatch" };
    case "cogs_missing":
      return { settlementState: "available", cogsMissing: true };
    case "settlement_missing":
      return { settlementState: "missing" };
    default:
      return {};
  }
}

const ESTIMATED_PROFIT_HELP = [
  "Lợi nhuận dự kiến = Doanh thu đơn hàng ước tính do Shopee cung cấp - Giá vốn.",
  "Biên lợi nhuận dự kiến = Lợi nhuận dự kiến / Tổng giá trị đơn hàng.",
];
const ESTIMATED_REVENUE_HELP = ["Doanh thu đơn hàng ước tính do Shopee cung cấp (số người bán dự kiến nhận, đã trừ phí và thuế Shopee). Có thể thay đổi tới khi đơn hoàn thành."];
const COGS_HELP = [
  "COGS có bao gồm VAT đầu vào theo hóa đơn NCC khi áp dụng.",
  '"Tạm tính": hàng của NCC công ty chưa có hóa đơn — tạm tính theo VAT mặc định, tự cập nhật theo VAT thật khi lập hóa đơn.',
];
const ACTUAL_PROFIT_HELP = ["Lợi nhuận thực tế = Thu nhập Shopee thực nhận (sau quyết toán) - Giá vốn."];

/** NULL money is "not known yet" — said in words, never shown as 0. */
const money = (v: string | null, missing: string) => (v === null ? <span className="text-muted-foreground">{missing}</span> : formatCurrency(v));

/** Column header with an accessible (?) explanation. */
function HelpHead({ label, help, aria }: { label: string; help: string[]; aria: string }) {
  return (
    <TableHead className="text-right">
      <span className="inline-flex items-center gap-1">
        {label}
        <Tooltip>
          <TooltipTrigger
            render={<button type="button" aria-label={aria} className="rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none" />}
          >
            <CircleHelp className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent className="max-w-72 space-y-1 text-left font-normal">
            {help.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </TooltipContent>
        </Tooltip>
      </span>
    </TableHead>
  );
}

/** Signed amount + optional margin line, success (≥ 0) / danger (< 0). Never called with NULL. */
function ProfitValue({ value, margin, loss }: { value: string; margin?: string | null; loss: boolean }) {
  return (
    <span className={`inline-flex flex-col items-end font-medium ${TONE_TEXT_CLASS[loss ? "danger" : "success"]}`}>
      <span className="inline-flex items-center gap-1">
        {loss && <AlertTriangle aria-hidden="true" className="size-3.5" />}
        {formatSignedCurrency(value)}
      </span>
      {margin !== undefined && <span className="text-xs font-normal">{formatPercentString(margin)}</span>}
    </span>
  );
}

/** COGS uses a provisional (default-VAT) purchase cost — corrects itself when the supplier invoice is linked. */
function ProvisionalHint() {
  return (
    <span className="block text-xs text-warning-text" title="Có hàng nhập từ NCC công ty chưa có hóa đơn — giá vốn tính theo VAT mặc định, tự cập nhật khi lập hóa đơn">
      Tạm tính
    </span>
  );
}

export default async function ShopeeOrdersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const auth = await requirePermission("channel:view");
  const canManage = hasPermission(auth.profile.role, "channel:manage");
  const canSync = hasPermission(auth.profile.role, "channel:sync");
  const canManageCost = hasPermission(auth.profile.role, "cost:manage");
  const params = await searchParams;
  const pageSize = parsePageSize(params.size);
  const page = parsePage(params.page);

  const modeConfig = getShopeeProviderMode();
  let liveProblem: string | null = null;
  if (modeConfig.mode === "live") {
    try {
      getShopeeConfig();
    } catch (err) {
      liveProblem = (err as Error).message;
    }
  }

  const shops = (await listShops()).filter((s) => s.channel === "shopee");
  const filters: ChannelOrderFilters = {
    shopId: shops.some((s) => s.id === params.shop) ? params.shop : undefined,
    orderStatus: params.status?.trim() || undefined,
    mappingReadiness: READINESS.has(params.mapping ?? "") ? (params.mapping as MappingReadiness) : undefined,
    financialStatus: params.financial?.trim() || undefined,
    orderSn: params.sn?.trim() || undefined,
    sku: params.sku?.trim() || undefined,
    dateFrom: DAY.test(params.from ?? "") ? params.from : undefined,
    dateTo: DAY.test(params.to ?? "") ? params.to : undefined,
    ...finFilter(params.fin),
    estimatedState: ESTIMATED_STATES.has(params.est ?? "") ? (params.est as EstimatedProfitState) : undefined,
  };
  const [{ rows, total }, syncStatuses, summary, health] = await Promise.all([
    getChannelOrders(filters, page, pageSize),
    getSyncStatuses(
      shops.map((s) => s.id),
      ["order", "escrow"],
    ),
    getOrderFinancialSummary(filters),
    getSyncHealth(),
  ]);
  // SHOPEE-6 §50: subtle "Có trả hàng" indicator (one query for the visible page)
  // SHOPEE-7 §26: compact release badge (same visible-page query pattern)
  const [withReturns, releases] = await Promise.all([
    getOrdersWithReturns(createAdminClient(), rows.map((o) => o.orderId)),
    getOrdersIncomeStatus(createAdminClient(), rows.map((o) => o.orderId)),
  ]);
  const query: Record<string, string | undefined> = Object.fromEntries(ORDER_FILTER_KEYS.map((k) => [k, params[k]?.trim() || undefined]));
  const hasFilter = activeFilterCount(query, ORDER_FILTER_KEYS) > 0;
  const syncing = hasActiveSync(syncStatuses);
  const neverSynced = shops.every((s) => !syncStatuses.get(`${s.id}|order`)?.lastSuccessAt);
  const now = new Date();
  const profitSign = numericSign(summary.profitSum);

  return (
    <PageContainer>
      <PageHeader
        title="Đơn hàng Shopee"
        description="Đơn hàng đồng bộ từ Shopee. Giá trị sản phẩm là giá trị đơn trên Shopee — chưa phải doanh thu thực nhận hay lợi nhuận."
        meta={
          <>
            <FreshnessSummary shops={shops} statuses={syncStatuses} syncType="order" schedulerStale={health.schedulerStale} />
            <FreshnessSummary shops={shops} statuses={syncStatuses} syncType="escrow" />
            <AutoRefresh active={syncing} />
          </>
        }
      />

      {canManage && <SchedulerWarning health={health} />}
      {modeConfig.mode === "fixture" ? (
        <Callout tone="info" icon={FlaskConical}>
          Đang sử dụng dữ liệu fixture/test. Shopee production API chưa được kích hoạt.
        </Callout>
      ) : liveProblem || modeConfig.problem ? (
        <Callout tone="danger" title="Chưa kết nối API Shopee.">
          {modeConfig.problem ?? liveProblem}
        </Callout>
      ) : null}

      {(canSync || canManage) && shops.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Đồng bộ đơn hàng & tài chính</CardTitle>
            <CardDescription>Tự động mỗi vài phút — chỉ bấm khi cần dữ liệu ngay.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {shops.map((shop) => {
              const usable = shop.isActive && shop.dataSource === modeConfig.mode && !liveProblem && !modeConfig.problem;
              return (
                <div key={shop.id} className="grid gap-4 border-b pb-4 last:border-b-0 last:pb-0 md:grid-cols-[minmax(10rem,14rem)_1fr_1fr_auto]">
                  <div className="space-y-1">
                    <p className="font-medium">{shop.shopName}</p>
                    <StatusBadge tone={shop.dataSource === "fixture" ? "info" : "neutral"} icon={false}>
                      {shop.dataSource === "fixture" ? "FIXTURE" : "LIVE"}
                    </StatusBadge>
                    {!usable && (
                      <p className="text-xs text-muted-foreground">
                        {shop.dataSource === "fixture" ? "Shop fixture chỉ đồng bộ được ở fixture mode." : "Shop thật chỉ đồng bộ được khi API Shopee (live) đã được cấu hình."}
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-semibold text-muted-foreground">Đơn hàng</p>
                    <SyncStatusCell
                      status={syncStatuses.get(`${shop.id}|order`)}
                      canSeeErrors={canManage}
                      now={now}
                      action={canSync ? <SyncNowButton shopId={shop.id} syncType="order" variant="outline" disabled={!usable} /> : undefined}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-semibold text-muted-foreground">Tài chính (escrow)</p>
                    <SyncStatusCell
                      status={syncStatuses.get(`${shop.id}|escrow`)}
                      canSeeErrors={canManage}
                      now={now}
                      action={canSync ? <SyncNowButton shopId={shop.id} syncType="escrow" label="Đồng bộ tài chính" variant="outline" disabled={!usable} /> : undefined}
                    />
                  </div>
                  {canManage && (
                    <div className="flex flex-col items-start gap-2 md:items-end">
                      <BackfillButton shopId={shop.id} syncType="order" days={30} label="Backfill 30 ngày" disabled={!usable} />
                    </div>
                  )}
                </div>
              );
            })}
            {canManageCost && (
              <div className="border-t pt-4">
                <BackfillCogsButton />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <MetricGrid>
        <MetricCard label="Số đơn (theo bộ lọc)" icon={ReceiptText} value={summary.orderCount.toLocaleString("vi-VN")} />
        <MetricCard label="Thu nhập Shopee" icon={Wallet} value={formatCurrency(summary.incomeSum)} hint={`${summary.withIncome} đơn có settlement`} />
        <MetricCard label="Giá vốn (COGS)" icon={Coins} value={formatCurrency(summary.cogsSum)} hint={`${summary.withCogs} đơn đã tính`} />
        <MetricCard
          label="Lợi nhuận sau giá vốn"
          icon={TrendingUp}
          value={formatCurrency(summary.profitSum)}
          tone={profitTone(profitSign)}
          hint={`chỉ ${summary.withProfit} đơn có đủ thu nhập + giá vốn`}
        />
        <MetricCard
          label="Thiếu settlement / giá vốn"
          icon={PackageCheck}
          value={`${summary.missingSettlement} / ${summary.missingCogs}`}
          tone={summary.missingSettlement + summary.missingCogs > 0 ? "warning" : "neutral"}
          hint="đơn hoàn thành chưa đủ số liệu"
        />
        <MetricCard label="Lệch đối soát" icon={Scale} value={summary.mismatchCount} tone={summary.mismatchCount > 0 ? "danger" : "neutral"} hint="settlement khác công thức" />
      </MetricGrid>

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>Đơn hàng ({total.toLocaleString("vi-VN")})</CardTitle>
          <OrderFilters
            shops={shops.map((s) => ({ id: s.id, name: s.shopName }))}
            values={{
              shop: filters.shopId ?? "",
              status: filters.orderStatus ?? "",
              mapping: filters.mappingReadiness ?? "",
              financial: filters.financialStatus ?? "",
              fin: params.fin ?? "",
              sn: filters.orderSn ?? "",
              sku: filters.sku ?? "",
              from: filters.dateFrom ?? "",
              to: filters.dateTo ?? "",
              est: filters.estimatedState ?? "",
            }}
          />
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            hasFilter ? (
              <EmptyState variant="no-results" title="Không tìm thấy đơn phù hợp." description="Thử bỏ bớt bộ lọc hoặc đổi khoảng ngày." />
            ) : neverSynced ? (
              <EmptyState
                icon={ReceiptText}
                title="Chưa có dữ liệu đồng bộ."
                description="Đơn hàng sẽ xuất hiện sau lần đồng bộ đầu tiên (tự động mỗi vài phút)."
                action={
                  <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/shopee/sync" />}>
                    Xem trạng thái đồng bộ
                  </Button>
                }
              />
            ) : (
              <EmptyState icon={ReceiptText} title="Chưa có đơn hàng." description="Shop chưa có đơn nào trong khoảng đã đồng bộ." />
            )
          ) : (
            <>
              <Table stickyHeader>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày đơn</TableHead>
                    <TableHead>Mã đơn</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    {shops.length > 1 && <TableHead>Shop</TableHead>}
                    <TableHead className="text-right">SL</TableHead>
                    <TableHead className="text-right">Giá trị SP</TableHead>
                    <TableHead>Ghép SKU</TableHead>
                    <HelpHead label="COGS" help={COGS_HELP} aria="Giải thích giá vốn" />
                    <HelpHead label="DT ước tính" help={ESTIMATED_REVENUE_HELP} aria="Giải thích doanh thu ước tính" />
                    <HelpHead label="LN dự kiến" help={ESTIMATED_PROFIT_HELP} aria="Giải thích lợi nhuận dự kiến" />
                    <HelpHead label="LN thực tế" help={ACTUAL_PROFIT_HELP} aria="Giải thích lợi nhuận thực tế" />
                    <TableHead>Tài chính</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((o) => {
                    return (
                      <TableRow key={o.orderId}>
                        <TableCell className="text-muted-foreground">{formatDateTime(o.createdAtChannel)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          <Link href={`/shopee/orders/${o.orderId}`} className="rounded text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                            {o.externalOrderSn}
                          </Link>
                          {withReturns.has(o.orderId) && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-warning-text" title="Đơn có yêu cầu trả hàng / hoàn tiền">
                              <Undo2 aria-hidden="true" className="size-3" />
                              Có trả hàng
                            </span>
                          )}
                          <ReleaseBadge release={releases.get(o.orderId)} />
                          {o.dataSource === "fixture" && (
                            <StatusBadge tone="info" icon={false} className="ml-1.5">
                              FIXTURE
                            </StatusBadge>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={toneOf(ORDER_STATUS_TONE, o.orderStatus)} icon={false}>
                            {ORDER_STATUS_LABELS[o.orderStatus] ?? o.orderStatus}
                          </StatusBadge>
                        </TableCell>
                        {shops.length > 1 && (
                          <TableCell className="max-w-36 truncate" title={o.shopName}>
                            {o.shopName}
                          </TableCell>
                        )}
                        <TableCell className="text-right">{formatQuantity(o.totalItemQuantity)}</TableCell>
                        <TableCell className="text-right">{o.itemGrossValue === null ? "—" : formatCurrency(o.itemGrossValue)}</TableCell>
                        <TableCell>
                          <StatusBadge tone={toneOf(READINESS_TONE, o.mappingReadiness)}>
                            {READINESS_LABELS[o.mappingReadiness]}
                            {o.mappingReadiness === "partial" ? ` ${o.mappedLines}/${o.lineCount}` : ""}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="text-right">
                          {money(o.internalCogs, o.cogsReadiness === "partial" ? `Một phần ${o.costedLines}/${o.lineCount}` : "Chưa tính")}
                          {o.cogsProvisional && o.internalCogs !== null && <ProvisionalHint />}
                        </TableCell>
                        <TableCell className="text-right">{money(o.estimatedOrderRevenue, "Chưa có")}</TableCell>
                        <TableCell className="text-right">
                          {o.estimatedProfit === null ? (
                            <span className="text-muted-foreground">Chưa tính</span>
                          ) : (
                            <>
                              <ProfitValue value={o.estimatedProfit} margin={o.estimatedMarginPct} loss={o.estimatedProfitState === "loss"} />
                              {o.cogsProvisional && <ProvisionalHint />}
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {o.profitAfterCogs === null ? (
                            <span className="text-muted-foreground">{o.settlementState === "missing" ? "Chưa quyết toán" : "Chưa tính"}</span>
                          ) : (
                            <ProfitValue value={o.profitAfterCogs} loss={o.profitState === "loss"} />
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <StatusBadge tone={toneOf(FINANCIAL_STATUS_TONE, o.financialStatus)} icon={false}>
                              {FINANCIAL_STATUS_LABELS[o.financialStatus] ?? o.financialStatus}
                            </StatusBadge>
                            {o.reconciliationStatus && o.reconciliationStatus !== "matched" && (
                              <StatusBadge tone={toneOf(RECONCILIATION_TONE, o.reconciliationStatus)}>{RECONCILIATION_LABELS[o.reconciliationStatus]}</StatusBadge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <DataTablePagination pathname="/shopee/orders" query={query} page={page} pageSize={pageSize} total={total} />
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
