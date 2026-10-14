import { AlertTriangle, FlaskConical, PackageSearch } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { listShops } from "@/lib/channels/core/queries";
import { getShopeeProductMappingSummary, getShopeeProducts, type ChannelModelFilters } from "@/lib/channels/core/product-queries";
import { getSyncStatuses } from "@/lib/channels/core/sync-status-queries";
import { isMappingStatus } from "@/lib/channels/core/types";
import { getShopeeConfig } from "@/lib/channels/shopee/config";
import { getShopeeProviderMode } from "@/lib/channels/shopee/provider-mode";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ListPagination } from "@/components/list-pagination";

import { fmtDate, formatDecimal, MAPPING_LABELS, MAPPING_VARIANT, toModelView } from "../shared";
import { BackfillButton, SyncNowButton } from "../sync/sync-buttons";
import { FreshnessSummary, SyncFreshness } from "../sync/sync-status";
import { ModelRowActions } from "./model-row-actions";
import { ShopeeProductFilters } from "./product-filters";
import { AutoMapButton, CreateFixtureShopButton } from "./sync-controls";

export const dynamic = "force-dynamic";
// "Đồng bộ ngay" kicks the background worker after responding (after()).
export const maxDuration = 60;

const PAGE_SIZE = 20;

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: "warn" | "danger" }) {
  const color = tone === "danger" && value > 0 ? "text-destructive" : tone === "warn" && value > 0 ? "text-amber-600" : "";
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold ${color}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

export default async function ShopeeProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; mapping?: string; status?: string; name?: string; sku?: string; isku?: string; page?: string }>;
}) {
  const auth = await requirePermission("channel:view");
  const role = auth.profile.role;
  const canManage = hasPermission(role, "channel:manage");
  const canSync = hasPermission(role, "channel:sync");
  const canMap = hasPermission(role, "channel:map");
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

  const [{ rows, total }, summary, syncStatuses] = await Promise.all([
    getShopeeProducts(filters, page, PAGE_SIZE),
    getShopeeProductMappingSummary(shopFilter),
    getSyncStatuses(
      shops.map((s) => s.id),
      ["product"],
    ),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilter = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Sản phẩm Shopee</h2>
        <p className="text-muted-foreground">
          Đồng bộ sản phẩm / biến thể từ Shopee và ghép với SKU nội bộ. Giá và tồn kho Shopee chỉ để tham khảo — không phải giá vốn hay tồn kho nội bộ.
        </p>
        <FreshnessSummary shops={shops} statuses={syncStatuses} syncType="product" />
      </div>

      {modeConfig.mode === "fixture" ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          API Shopee production chưa được kích hoạt. Dữ liệu đồng bộ hiện tại đang sử dụng fixture/test mode (chỉ cho shop fixture).
        </p>
      ) : liveProblem || modeConfig.problem ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Chưa kết nối API Shopee. {modeConfig.problem ?? liveProblem}
        </p>
      ) : null}

      {(canSync || canManage) && (
        <Card>
          <CardHeader>
            <CardTitle>Shop &amp; đồng bộ</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {shops.length === 0 && <p className="text-sm text-muted-foreground">Chưa có shop Shopee nào. Kết nối shop ở trang Tích hợp Shopee.</p>}
            {shops.map((shop) => {
              const sourceMatches = shop.isActive && shop.dataSource === modeConfig.mode && !liveProblem && !modeConfig.problem;
              return (
                <div key={shop.id} className="flex flex-col gap-3 border-b pb-4 last:border-b-0 last:pb-0 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {shop.shopName}
                      <Badge variant={shop.dataSource === "fixture" ? "secondary" : "outline"}>{shop.dataSource === "fixture" ? "FIXTURE" : "LIVE"}</Badge>
                      <span className="text-muted-foreground">#{shop.externalShopId}</span>
                    </p>
                    <SyncFreshness status={syncStatuses.get(`${shop.id}|product`)} canSeeErrors={canManage} />
                    {!sourceMatches && (
                      <p className="text-xs text-muted-foreground">
                        {shop.dataSource === "fixture" ? "Shop fixture chỉ đồng bộ được ở fixture mode." : "Shop thật chỉ đồng bộ được khi API Shopee (live) đã được cấu hình."}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    {canSync && <SyncNowButton shopId={shop.id} syncType="product" disabled={!sourceMatches} />}
                    {canManage && <BackfillButton shopId={shop.id} syncType="product" label="Quét toàn bộ" disabled={!sourceMatches} />}
                    {canManage && <AutoMapButton shopId={shop.id} />}
                  </div>
                </div>
              );
            })}
            {modeConfig.mode === "fixture" && modeConfig.fixtureAllowed && !shops.some((s) => s.dataSource === "fixture") && <CreateFixtureShopButton />}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <SummaryCard label="Biến thể đang bán" value={summary.activeModels} />
        <SummaryCard label="Đã ghép" value={summary.activeMapped} />
        <SummaryCard label="Chưa ghép" value={summary.activeUnmapped} tone="warn" />
        <SummaryCard label="Xung đột" value={summary.activeConflict} tone="danger" />
        <SummaryCard label="Cần kiểm tra lại" value={summary.reviewRequired} tone="warn" />
        <SummaryCard label="Ngừng bán / đã xóa" value={summary.inactiveModels} />
      </div>
      {summary.activeModels > 0 && summary.activeUnmapped + summary.activeConflict > 0 && (
        <p className="text-sm text-muted-foreground">
          Cần ghép hết các biến thể đang bán trước khi bắt đầu đồng bộ đơn hàng (SHOPEE-3).
        </p>
      )}

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-4 space-y-0">
          <CardTitle>Biến thể Shopee ({total})</CardTitle>
          <ShopeeProductFilters
            shops={shops.map((s) => ({ id: s.id, name: s.shopName }))}
            values={{ shop: shopFilter ?? "", mapping: mappingFilter ?? "", status: filters.itemStatus ?? "", name: filters.itemName ?? "", sku: filters.channelSku ?? "", isku: filters.internalSku ?? "" }}
          />
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <PackageSearch className="size-8 text-muted-foreground" />
              <p className="font-medium">{hasFilter ? "Không có biến thể phù hợp." : "Chưa có dữ liệu sản phẩm Shopee — hãy chạy đồng bộ."}</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Shop</TableHead>
                    <TableHead>Sản phẩm Shopee</TableHead>
                    <TableHead>Biến thể</TableHead>
                    <TableHead>SKU Shopee</TableHead>
                    <TableHead className="text-right">Giá Shopee</TableHead>
                    <TableHead className="text-right">Tồn Shopee</TableHead>
                    <TableHead>SKU nội bộ</TableHead>
                    <TableHead>Trạng thái ghép</TableHead>
                    <TableHead>Trạng thái Shopee</TableHead>
                    <TableHead>Đồng bộ</TableHead>
                    <TableHead className="text-right">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const view = toModelView(row);
                    return (
                      <TableRow key={row.channelModelId} className={row.isActive ? "" : "opacity-60"}>
                        <TableCell className="whitespace-nowrap">
                          {row.shopName}
                          {row.dataSource === "fixture" && (
                            <Badge variant="secondary" className="ml-1">
                              FIXTURE
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="max-w-[260px]">
                            <p className="truncate font-medium" title={row.itemName}>
                              {row.itemName}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              #{row.externalItemId}
                              {row.isKit ? " · combo" : ""}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          {row.isSynthetic ? <span className="text-muted-foreground">Không biến thể</span> : row.modelName ?? `#${row.externalModelId}`}
                          {row.removedAt && <p className="text-xs text-destructive">đã gỡ khỏi Shopee</p>}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{row.channelSku ?? <span className="text-muted-foreground">(trống)</span>}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{formatDecimal(row.channelCurrentPrice, " ₫")}</TableCell>
                        <TableCell className="text-right">{formatDecimal(row.availableStock)}</TableCell>
                        <TableCell className="font-mono text-xs">{row.internalSku ?? "—"}</TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant={MAPPING_VARIANT[row.mappingStatus]}>{MAPPING_LABELS[row.mappingStatus]}</Badge>
                            {row.mappingReviewRequired && <Badge variant="destructive">Cần kiểm tra lại</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{row.itemStatus ?? "—"}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{fmtDate(row.lastSyncedAt)}</TableCell>
                        <TableCell className="text-right">
                          <ModelRowActions row={view} canMap={canMap} canManage={canManage} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <ListPagination
                page={page}
                totalPages={totalPages}
                buildHref={(p) => {
                  const sp = new URLSearchParams();
                  for (const [k, v] of Object.entries({ shop: shopFilter, mapping: mappingFilter, status: filters.itemStatus, name: filters.itemName, sku: filters.channelSku, isku: filters.internalSku })) {
                    if (v) sp.set(k, v);
                  }
                  if (p > 1) sp.set("page", String(p));
                  const qs = sp.toString();
                  return qs ? `/shopee/products?${qs}` : "/shopee/products";
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
