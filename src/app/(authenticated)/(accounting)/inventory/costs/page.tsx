import Link from "next/link";
import { Calculator, History } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getProductCostOverview, type CostWarningFilter } from "@/lib/inventory-cost/queries";
import { formatCurrency, formatDateTime, formatQuantity } from "@/lib/ui/format";
import { parsePage, parsePageSize } from "@/lib/ui/list-query";
import { Callout } from "@/components/patterns/callout";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { CostFilters } from "./cost-filters";
import { RebuildCostButton } from "./rebuild-button";

export const dynamic = "force-dynamic";

const WARNINGS = new Set(["negative", "missing_cost", "no_history", "needs_rebuild", "vat_pending", "provisional"]);

export default async function InventoryCostsPage({ searchParams }: { searchParams: Promise<{ q?: string; warning?: string; page?: string; size?: string }> }) {
  const auth = await requirePermission("cost:view");
  const canManage = hasPermission(auth.profile.role, "cost:manage");
  const params = await searchParams;
  const page = parsePage(params.page);
  const pageSize = parsePageSize(params.size);
  const q = params.q?.trim() ?? "";
  const warning = WARNINGS.has(params.warning ?? "") ? (params.warning as CostWarningFilter) : undefined;
  const { rows, total } = await getProductCostOverview({ search: q || undefined, warning }, page, pageSize);
  const hasFilter = Boolean(q || warning);

  return (
    <PageContainer>
      <PageHeader
        title="Giá vốn sản phẩm"
        description="Giá vốn bình quân di động tính từ phiếu nhập hàng và đơn bán đã ghi nhận — tự cập nhật khi có phiếu nhập hoặc đơn mới."
        actions={
          canManage ? (
            <>
              <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/inventory/costs/restatement" />}>
                <History /> Điều chỉnh COGS đơn lịch sử
              </Button>
              <RebuildCostButton />
            </>
          ) : undefined
        }
      />

      <Callout tone="info">
        &quot;SL tính giá vốn&quot; = hàng nhập đã biết trừ hàng bán đã ghi nhận. Đây không phải tồn kho thực tế cho tới khi kiểm kê / nhập tồn đầu kỳ. Hàng từ NCC công ty tính
        theo giá nhập + VAT của hóa đơn NCC; hàng chưa có hóa đơn hiện &quot;Chờ hóa đơn VAT&quot;.
      </Callout>

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>Sản phẩm ({total.toLocaleString("vi-VN")})</CardTitle>
          <CostFilters q={q} warning={warning ?? ""} />
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            hasFilter ? (
              <EmptyState variant="no-results" title="Không tìm thấy sản phẩm phù hợp." description="Thử từ khóa khác hoặc bỏ lọc cảnh báo." />
            ) : (
              <EmptyState icon={Calculator} title="Chưa có sản phẩm nào." description="Giá vốn xuất hiện khi sản phẩm có phiếu nhập." />
            )
          ) : (
            <>
              <Table stickyHeader>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Sản phẩm</TableHead>
                    <TableHead className="text-right">SL tính giá vốn</TableHead>
                    <TableHead className="text-right">Giá vốn bình quân</TableHead>
                    <TableHead className="text-right">Giá trị tồn theo giá vốn</TableHead>
                    <TableHead>Sự kiện gần nhất</TableHead>
                    <TableHead>Cảnh báo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.productId}>
                      <TableCell className="font-mono text-xs">
                        <Link href={`/inventory/costs/${r.productId}`} className="rounded text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                          {r.sku}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[320px] truncate" title={r.name}>
                        {r.name}
                        {!r.isActive && (
                          <StatusBadge tone="neutral" icon={false} className="ml-1.5">
                            Ngừng HĐ
                          </StatusBadge>
                        )}
                      </TableCell>
                      <TableCell className={`text-right ${r.negativeQuantity ? "font-medium text-warning-text" : ""}`}>{r.hasHistory ? formatQuantity(r.quantityOnHand) : "—"}</TableCell>
                      <TableCell className="text-right">
                        {r.movingAverageCost === null ? <span className="text-muted-foreground">{r.vatPending ? "Chờ VAT" : "Chưa có"}</span> : formatCurrency(r.movingAverageCost)}
                        {r.costProvisional && r.movingAverageCost !== null && <p className="text-xs text-warning-text">Tạm tính</p>}
                      </TableCell>
                      <TableCell className="text-right">{r.hasHistory && r.movingAverageCost !== null ? formatCurrency(r.inventoryValue) : "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(r.lastEventTime)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {r.negativeQuantity && <StatusBadge tone="warning">Tồn tính giá vốn âm</StatusBadge>}
                          {r.vatPending ? (
                            <StatusBadge tone="warning">Chờ hóa đơn VAT</StatusBadge>
                          ) : (
                            r.missingCost && <StatusBadge tone="warning">Thiếu dữ liệu giá vốn</StatusBadge>
                          )}
                          {r.costProvisional && (
                            <StatusBadge tone="warning" title="Có hàng nhập từ NCC công ty chưa có hóa đơn — đang tính VAT mặc định; tự đúng lại khi lập hóa đơn">
                              Tạm tính (chưa có hóa đơn)
                            </StatusBadge>
                          )}
                          {!r.hasHistory && <StatusBadge tone="neutral">Chưa có lịch sử</StatusBadge>}
                          {r.needsRebuild && (
                            <StatusBadge tone="danger" title={r.lastError ?? ""}>
                              Cần tính lại
                            </StatusBadge>
                          )}
                          {!r.negativeQuantity && !r.missingCost && !r.costProvisional && r.hasHistory && !r.needsRebuild && <span className="text-xs text-muted-foreground">—</span>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <DataTablePagination pathname="/inventory/costs" query={{ q: q || undefined, warning }} page={page} pageSize={pageSize} total={total} />
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
