import Link from "next/link";
import { AlertTriangle, FlaskConical, ReceiptText } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getChannelOrders, getOrderFinancialSummary, type ChannelOrderFilters, type MappingReadiness } from "@/lib/channels/core/order-queries";
import { listShops } from "@/lib/channels/core/queries";
import { getSyncStatuses } from "@/lib/channels/core/sync-status-queries";
import { getShopeeConfig } from "@/lib/channels/shopee/config";
import { ORDER_STATUS_LABELS } from "@/lib/channels/shopee/order-status";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ListPagination } from "@/components/list-pagination";

import { fmtDate, formatDecimal } from "../shared";
import { FINANCIAL_STATUS_LABELS, READINESS_LABELS, READINESS_VARIANT, RECONCILIATION_LABELS, RECONCILIATION_VARIANT } from "./labels";
import { BackfillButton, SyncNowButton } from "../sync/sync-buttons";
import { FreshnessSummary, SyncFreshness } from "../sync/sync-status";
import { OrderFilters } from "./order-filters";
import { BackfillCogsButton } from "./order-sync-controls";

export const dynamic = "force-dynamic";
// "Đồng bộ ngay" kicks the background worker after responding (after()).
export const maxDuration = 60;

const PAGE_SIZE = 25;
const READINESS = new Set(["complete", "partial", "unmapped"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Params = { shop?: string; status?: string; mapping?: string; financial?: string; fin?: string; sn?: string; sku?: string; from?: string; to?: string; page?: string };

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
      return { settlementState: "available", cogsReadiness: "incomplete" };
    case "settlement_missing":
      return { settlementState: "missing" };
    default:
      return {};
  }
}

function SummaryTile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "warn" | "danger" }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`text-xl font-bold ${tone === "danger" ? "text-destructive" : tone === "warn" ? "text-amber-600" : ""}`}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

const money = (v: string | null, missing: string) => (v === null ? <span className="text-muted-foreground">{missing}</span> : formatDecimal(v, " ₫"));

export default async function ShopeeOrdersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const auth = await requirePermission("channel:view");
  const canManage = hasPermission(auth.profile.role, "channel:manage");
  const canSync = hasPermission(auth.profile.role, "channel:sync");
  const canManageCost = hasPermission(auth.profile.role, "cost:manage");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

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
  };
  const [{ rows, total }, syncStatuses, summary] = await Promise.all([
    getChannelOrders(filters, page, PAGE_SIZE),
    getSyncStatuses(
      shops.map((s) => s.id),
      ["order", "escrow"],
    ),
    getOrderFinancialSummary(filters),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilter = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Đơn hàng Shopee</h2>
        <p className="text-muted-foreground">
          Đơn hàng đồng bộ từ Shopee. Giá trị sản phẩm là giá trị đơn trên Shopee — chưa phải doanh thu thực nhận hay lợi nhuận.
        </p>
        <FreshnessSummary shops={shops} statuses={syncStatuses} syncType="order" />
      </div>

      {modeConfig.mode === "fixture" ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          Đang sử dụng dữ liệu fixture/test. Shopee production API chưa được kích hoạt.
        </p>
      ) : liveProblem || modeConfig.problem ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Chưa kết nối API Shopee. {modeConfig.problem ?? liveProblem}
        </p>
      ) : null}

      {(canSync || canManage) && shops.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Đồng bộ đơn hàng</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {shops.map((shop) => {
              const usable = shop.isActive && shop.dataSource === modeConfig.mode && !liveProblem && !modeConfig.problem;
              return (
                <div key={shop.id} className="flex flex-col gap-3 border-b pb-4 last:border-b-0 last:pb-0 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {shop.shopName}
                      <Badge variant={shop.dataSource === "fixture" ? "secondary" : "outline"}>{shop.dataSource === "fixture" ? "FIXTURE" : "LIVE"}</Badge>
                    </p>
                    <SyncFreshness status={syncStatuses.get(`${shop.id}|order`)} canSeeErrors={canManage} />
                    <p className="pt-1 text-xs font-medium text-muted-foreground">Tài chính (escrow):</p>
                    <SyncFreshness status={syncStatuses.get(`${shop.id}|escrow`)} canSeeErrors={canManage} />
                    {!usable && (
                      <p className="text-xs text-muted-foreground">
                        {shop.dataSource === "fixture" ? "Shop fixture chỉ đồng bộ được ở fixture mode." : "Shop thật chỉ đồng bộ được khi API Shopee (live) đã được cấu hình."}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    {canSync && <SyncNowButton shopId={shop.id} syncType="order" disabled={!usable} />}
                    {canSync && <SyncNowButton shopId={shop.id} syncType="escrow" label="Đồng bộ tài chính" disabled={!usable} />}
                    {canManage && <BackfillButton shopId={shop.id} syncType="order" days={30} label="Backfill 30 ngày" disabled={!usable} />}
                  </div>
                </div>
              );
            })}
            {canManageCost && <BackfillCogsButton />}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <SummaryTile label="Số đơn (theo bộ lọc)" value={summary.orderCount} />
        <SummaryTile label="Thu nhập Shopee" value={formatDecimal(summary.incomeSum, " ₫")} sub={`${summary.withIncome} đơn có settlement`} />
        <SummaryTile label="Giá vốn (COGS)" value={formatDecimal(summary.cogsSum, " ₫")} sub={`${summary.withCogs} đơn đã tính`} />
        <SummaryTile label="Lợi nhuận sau giá vốn" value={formatDecimal(summary.profitSum, " ₫")} sub={`chỉ ${summary.withProfit} đơn có đủ thu nhập + giá vốn`} tone={summary.profitSum.startsWith("-") ? "danger" : undefined} />
        <SummaryTile label="Thiếu settlement / giá vốn" value={`${summary.missingSettlement} / ${summary.missingCogs}`} tone={summary.missingSettlement + summary.missingCogs > 0 ? "warn" : undefined} />
        <SummaryTile label="Lệch đối soát" value={summary.mismatchCount} tone={summary.mismatchCount > 0 ? "danger" : undefined} />
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-4 space-y-0">
          <CardTitle>Đơn hàng ({total})</CardTitle>
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
            }}
          />
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <ReceiptText className="size-8 text-muted-foreground" />
              <p className="font-medium">{hasFilter ? "Không có đơn phù hợp." : "Chưa có đơn hàng Shopee — hãy chạy đồng bộ đơn."}</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày đơn</TableHead>
                    <TableHead>Shop</TableHead>
                    <TableHead>Mã đơn</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead className="text-right">Số lượng</TableHead>
                    <TableHead className="text-right">Giá trị SP</TableHead>
                    <TableHead>Mapping SKU</TableHead>
                    <TableHead className="text-right">Thu nhập Shopee</TableHead>
                    <TableHead className="text-right">COGS</TableHead>
                    <TableHead className="text-right">Lợi nhuận sau GV</TableHead>
                    <TableHead>Tài chính</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((o) => (
                    <TableRow key={o.orderId}>
                      <TableCell className="whitespace-nowrap">{fmtDate(o.createdAtChannel)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {o.shopName}
                        {o.dataSource === "fixture" && (
                          <Badge variant="secondary" className="ml-1">
                            FIXTURE
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <Link href={`/shopee/orders/${o.orderId}`} className="text-primary underline-offset-4 hover:underline">
                          {o.externalOrderSn}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{ORDER_STATUS_LABELS[o.orderStatus] ?? o.orderStatus}</TableCell>
                      <TableCell className="text-right">{formatDecimal(o.totalItemQuantity)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{o.itemGrossValue === null ? "—" : formatDecimal(o.itemGrossValue, " ₫")}</TableCell>
                      <TableCell>
                        <Badge variant={READINESS_VARIANT[o.mappingReadiness]}>
                          {READINESS_LABELS[o.mappingReadiness]}
                          {o.mappingReadiness === "partial" ? ` ${o.mappedLines}/${o.lineCount}` : ""}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">{money(o.shopeeNetIncome, "Chưa có")}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {money(o.internalCogs, o.cogsReadiness === "partial" ? `Một phần ${o.costedLines}/${o.lineCount}` : "Chưa tính")}
                      </TableCell>
                      <TableCell className={`text-right whitespace-nowrap ${o.profitState === "loss" ? "text-destructive" : ""}`}>{money(o.profitAfterCogs, "Chưa tính")}</TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-col items-start gap-1">
                          <span>{FINANCIAL_STATUS_LABELS[o.financialStatus] ?? o.financialStatus}</span>
                          {o.reconciliationStatus && o.reconciliationStatus !== "matched" && (
                            <Badge variant={RECONCILIATION_VARIANT[o.reconciliationStatus]}>{RECONCILIATION_LABELS[o.reconciliationStatus]}</Badge>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ListPagination
                page={page}
                totalPages={totalPages}
                buildHref={(p) => {
                  const sp = new URLSearchParams();
                  for (const [k, v] of Object.entries({ shop: filters.shopId, status: filters.orderStatus, mapping: filters.mappingReadiness, financial: filters.financialStatus, fin: params.fin, sn: filters.orderSn, sku: filters.sku, from: filters.dateFrom, to: filters.dateTo })) {
                    if (v) sp.set(k, v);
                  }
                  if (p > 1) sp.set("page", String(p));
                  const qs = sp.toString();
                  return qs ? `/shopee/orders?${qs}` : "/shopee/orders";
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
