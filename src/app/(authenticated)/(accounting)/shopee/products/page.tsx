import Link from "next/link";
import { ArrowRight, Boxes, CheckCircle2, CircleDashed, FlaskConical, PackageSearch, SearchCheck, TriangleAlert, Archive } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { listShops } from "@/lib/channels/core/queries";
import { getShopeeProductMappingSummary, getShopeeProducts, type ChannelModelFilters } from "@/lib/channels/core/product-queries";
import { getSyncHealth, getSyncStatuses } from "@/lib/channels/core/sync-status-queries";
import { isMappingStatus } from "@/lib/channels/core/types";
import { getShopeeConfig } from "@/lib/channels/shopee/config";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { formatCurrency, formatDateTime, formatQuantity } from "@/lib/ui/format";
import { activeFilterCount, parsePage, parsePageSize } from "@/lib/ui/list-query";
import { MAPPING_STATUS_TONE } from "@/lib/ui/status";
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

import { MAPPING_LABELS, PRODUCT_FILTER_KEYS, toModelView } from "../shared";
import { BackfillButton, SyncNowButton } from "../sync/sync-buttons";
import { FreshnessSummary, hasActiveSync, SchedulerWarning, SyncStatusCell } from "../sync/sync-status";
import { ModelRowActions } from "./model-row-actions";
import { ShopeeProductFilters } from "./product-filters";
import { AutoMapButton, CreateFixtureShopButton } from "./sync-controls";

export const dynamic = "force-dynamic";
// "Đồng bộ ngay" kicks the background worker after responding (after()).
export const maxDuration = 60;

type Params = { shop?: string; mapping?: string; status?: string; name?: string; sku?: string; isku?: string; page?: string; size?: string };

export default async function ShopeeProductsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const auth = await requirePermission("channel:view");
  const role = auth.profile.role;
  const canManage = hasPermission(role, "channel:manage");
  const canSync = hasPermission(role, "channel:sync");
  const canMap = hasPermission(role, "channel:map");
  const params = await searchParams;
  const page = parsePage(params.page);
  const pageSize = parsePageSize(params.size);

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
  const shopFilter = shops.some((s) => s.id === params.shop) ? params.shop : undefined;
  const mappingFilter = params.mapping === "review" || isMappingStatus(params.mapping) ? (params.mapping as ChannelModelFilters["mappingStatus"]) : undefined;
  const filters: ChannelModelFilters = {
    shopId: shopFilter,
    mappingStatus: mappingFilter,
    itemStatus: params.status?.trim() || undefined,
    itemName: params.name?.trim() || undefined,
    channelSku: params.sku?.trim() || undefined,
    internalSku: params.isku?.trim() || undefined,
  };

  const [{ rows, total }, summary, syncStatuses, health] = await Promise.all([
    getShopeeProducts(filters, page, pageSize),
    getShopeeProductMappingSummary(shopFilter),
    getSyncStatuses(
      shops.map((s) => s.id),
      ["product"],
    ),
    getSyncHealth(),
  ]);
  const query: Record<string, string | undefined> = Object.fromEntries(PRODUCT_FILTER_KEYS.map((k) => [k, params[k]?.trim() || undefined]));
  const hasFilter = activeFilterCount(query, PRODUCT_FILTER_KEYS) > 0;
  const syncing = hasActiveSync(syncStatuses);
  const now = new Date();
  const unmappedHref = `/shopee/products?mapping=unmapped`;

  return (
    <PageContainer>
      <PageHeader
        title="Sản phẩm Shopee"
        description="Biến thể đồng bộ từ Shopee và SKU nội bộ được ghép. Giá và tồn kho Shopee chỉ để tham khảo — không phải giá vốn hay tồn kho nội bộ."
        meta={
          <>
            <FreshnessSummary shops={shops} statuses={syncStatuses} syncType="product" schedulerStale={health.schedulerStale} />
            <AutoRefresh active={syncing} />
          </>
        }
      />

      {canManage && <SchedulerWarning health={health} />}
      {modeConfig.mode === "fixture" ? (
        <Callout tone="info" icon={FlaskConical}>
          API Shopee production chưa được kích hoạt. Dữ liệu đồng bộ hiện tại đang sử dụng fixture/test mode (chỉ cho shop fixture).
        </Callout>
      ) : liveProblem || modeConfig.problem ? (
        <Callout tone="danger" title="Chưa kết nối API Shopee.">
          {modeConfig.problem ?? liveProblem}
        </Callout>
      ) : null}

      {(canSync || canManage) && (
        <Card>
          <CardHeader>
            <CardTitle>Shop &amp; đồng bộ</CardTitle>
            <CardDescription>
              <b>Đồng bộ sản phẩm</b>: Shopee → hệ thống (tự động mỗi giờ, chạy nền). <b>Tự động ghép SKU</b>: chỉ dùng dữ liệu đã đồng bộ — không gọi Shopee, không ghi đè ghép tay.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {shops.length === 0 && <EmptyState title="Chưa có shop Shopee nào." description="Kết nối shop ở trang Tích hợp Shopee." className="py-6" />}
            {shops.map((shop) => {
              const sourceMatches = shop.isActive && shop.dataSource === modeConfig.mode && !liveProblem && !modeConfig.problem;
              return (
                <div key={shop.id} className="grid gap-4 border-b pb-4 last:border-b-0 last:pb-0 md:grid-cols-[minmax(10rem,14rem)_1fr_auto]">
                  <div className="space-y-1">
                    <p className="font-medium">{shop.shopName}</p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <StatusBadge tone={shop.dataSource === "fixture" ? "info" : "neutral"} icon={false}>
                        {shop.dataSource === "fixture" ? "FIXTURE" : "LIVE"}
                      </StatusBadge>
                      #{shop.externalShopId}
                    </p>
                    {!sourceMatches && (
                      <p className="text-xs text-muted-foreground">
                        {shop.dataSource === "fixture" ? "Shop fixture chỉ đồng bộ được ở fixture mode." : "Shop thật chỉ đồng bộ được khi API Shopee (live) đã được cấu hình."}
                      </p>
                    )}
                  </div>
                  <SyncStatusCell
                    status={syncStatuses.get(`${shop.id}|product`)}
                    canSeeErrors={canManage}
                    now={now}
                    action={canSync ? <SyncNowButton shopId={shop.id} syncType="product" label="Đồng bộ sản phẩm" variant="outline" disabled={!sourceMatches} /> : undefined}
                  />
                  <div className="flex flex-col items-start gap-2 md:items-end">
                    {canManage && <AutoMapButton shopId={shop.id} />}
                    {canManage && <BackfillButton shopId={shop.id} syncType="product" label="Quét toàn bộ" disabled={!sourceMatches} />}
                  </div>
                </div>
              );
            })}
            {modeConfig.mode === "fixture" && modeConfig.fixtureAllowed && !shops.some((s) => s.dataSource === "fixture") && <CreateFixtureShopButton />}
          </CardContent>
        </Card>
      )}

      <MetricGrid>
        <MetricCard label="Biến thể đang bán" icon={Boxes} value={summary.activeModels.toLocaleString("vi-VN")} />
        <MetricCard label="Đã ghép" icon={CheckCircle2} value={summary.activeMapped.toLocaleString("vi-VN")} />
        <MetricCard label="Chưa ghép" icon={CircleDashed} value={summary.activeUnmapped.toLocaleString("vi-VN")} tone={summary.activeUnmapped > 0 ? "warning" : "neutral"} hint="đơn có biến thể này sẽ thiếu giá vốn" />
        <MetricCard label="Xung đột" icon={TriangleAlert} value={summary.activeConflict} tone={summary.activeConflict > 0 ? "danger" : "neutral"} hint="SKU khớp nhiều sản phẩm nội bộ" />
        <MetricCard label="Cần kiểm tra lại" icon={SearchCheck} value={summary.reviewRequired} tone={summary.reviewRequired > 0 ? "warning" : "neutral"} />
        <MetricCard label="Ngừng bán / đã xóa" icon={Archive} value={summary.inactiveModels.toLocaleString("vi-VN")} />
      </MetricGrid>
      {summary.activeModels > 0 && summary.activeUnmapped + summary.activeConflict > 0 && mappingFilter !== "unmapped" && (
        <Callout
          tone="warning"
          action={
            <Button size="sm" variant="outline" nativeButton={false} render={<Link href={unmappedHref} />}>
              Xem biến thể chưa ghép <ArrowRight />
            </Button>
          }
        >
          {summary.activeUnmapped + summary.activeConflict} biến thể đang bán chưa ghép được SKU nội bộ — đơn chứa các biến thể này sẽ thiếu giá vốn (COGS).
        </Callout>
      )}

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>Biến thể Shopee ({total.toLocaleString("vi-VN")})</CardTitle>
          <ShopeeProductFilters
            shops={shops.map((s) => ({ id: s.id, name: s.shopName }))}
            values={{ shop: shopFilter ?? "", mapping: mappingFilter ?? "", status: filters.itemStatus ?? "", name: filters.itemName ?? "", sku: filters.channelSku ?? "", isku: filters.internalSku ?? "" }}
          />
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            hasFilter ? (
              <EmptyState variant="no-results" title="Không tìm thấy biến thể phù hợp." description="Thử bỏ bớt bộ lọc hoặc tìm theo từ khóa khác." />
            ) : (
              <EmptyState
                icon={PackageSearch}
                title="Chưa có dữ liệu sản phẩm Shopee."
                description="Sản phẩm sẽ xuất hiện sau lần đồng bộ đầu tiên (tự động mỗi giờ)."
                action={
                  <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/shopee/sync" />}>
                    Xem trạng thái đồng bộ
                  </Button>
                }
              />
            )
          ) : (
            <>
              <Table stickyHeader>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sản phẩm / biến thể Shopee</TableHead>
                    <TableHead>Ghép SKU</TableHead>
                    <TableHead className="text-right">Giá Shopee</TableHead>
                    <TableHead className="text-right">Tồn Shopee</TableHead>
                    <TableHead>Trạng thái Shopee</TableHead>
                    {shops.length > 1 && <TableHead>Shop</TableHead>}
                    <TableHead>Đồng bộ</TableHead>
                    <TableHead className="text-right">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const view = toModelView(row);
                    return (
                      <TableRow key={row.channelModelId} className={row.isActive ? "" : "text-muted-foreground"}>
                        <TableCell className="whitespace-normal">
                          <div className="max-w-[340px] min-w-52">
                            <p className="truncate font-medium text-foreground" title={row.itemName}>
                              {row.itemName}
                            </p>
                            <p className="truncate text-xs text-muted-foreground" title={row.modelName ?? undefined}>
                              {row.isSynthetic ? "Không biến thể" : row.modelName ?? `#${row.externalModelId}`} · #{row.externalItemId}
                              {row.isKit ? " · combo" : ""}
                              {row.dataSource === "fixture" ? " · FIXTURE" : ""}
                            </p>
                            {row.removedAt && <p className="text-xs text-warning-text">Đã gỡ khỏi Shopee</p>}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          {/* Shopee SKU → internal SKU, the one thing this screen is for. */}
                          <div className="flex min-w-56 flex-wrap items-center gap-1.5 text-xs">
                            <span className="font-mono">{row.channelSku ?? <span className="text-muted-foreground">(trống)</span>}</span>
                            <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" />
                            {row.internalSku ? (
                              <span className="font-mono font-medium text-foreground" title={view.internalProductName ?? undefined}>
                                {row.internalSku}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">chưa có</span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <StatusBadge tone={row.isActive && row.mappingStatus === "unmapped" ? "warning" : MAPPING_STATUS_TONE[row.mappingStatus]}>{MAPPING_LABELS[row.mappingStatus]}</StatusBadge>
                            {row.mappingReviewRequired && <StatusBadge tone="warning">Cần kiểm tra lại</StatusBadge>}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{formatCurrency(row.channelCurrentPrice)}</TableCell>
                        <TableCell className="text-right">{formatQuantity(row.availableStock)}</TableCell>
                        <TableCell className="text-xs">{row.itemStatus ?? "—"}</TableCell>
                        {shops.length > 1 && (
                          <TableCell className="max-w-36 truncate" title={row.shopName}>
                            {row.shopName}
                          </TableCell>
                        )}
                        <TableCell className="text-xs text-muted-foreground">{formatDateTime(row.lastSyncedAt)}</TableCell>
                        <TableCell className="text-right">
                          <ModelRowActions row={view} canMap={canMap} canManage={canManage} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <DataTablePagination pathname="/shopee/products" query={query} page={page} pageSize={pageSize} total={total} />
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
