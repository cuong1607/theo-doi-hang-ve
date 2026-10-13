import Link from "next/link";
import { Calculator, Info } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getProductCostOverview, type CostWarningFilter } from "@/lib/inventory-cost/queries";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ListPagination } from "@/components/list-pagination";

import { fmtDate, formatDecimal } from "../../shopee/shared";
import { CostFilters } from "./cost-filters";
import { RebuildCostButton } from "./rebuild-button";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;
const WARNINGS = new Set(["negative", "missing_cost", "no_history", "needs_rebuild"]);

export default async function InventoryCostsPage({ searchParams }: { searchParams: Promise<{ q?: string; warning?: string; page?: string }> }) {
  const auth = await requirePermission("cost:view");
  const canManage = hasPermission(auth.profile.role, "cost:manage");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const q = params.q?.trim() ?? "";
  const warning = WARNINGS.has(params.warning ?? "") ? (params.warning as CostWarningFilter) : undefined;
  const { rows, total } = await getProductCostOverview({ search: q || undefined, warning }, page, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Giá vốn sản phẩm</h2>
          <p className="text-muted-foreground">Giá vốn bình quân di động tính từ phiếu nhập hàng và đơn bán đã ghi nhận.</p>
        </div>
        {canManage && <RebuildCostButton />}
      </div>

      <p className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        &quot;SL tính giá vốn&quot; = hàng nhập đã biết trừ hàng bán đã ghi nhận. Đây không phải tồn kho thực tế cho tới khi kiểm kê / nhập tồn đầu kỳ.
      </p>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-4 space-y-0">
          <CardTitle>Sản phẩm ({total})</CardTitle>
          <CostFilters q={q} warning={warning ?? ""} />
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Calculator className="size-8 text-muted-foreground" />
              <p className="font-medium">Không có sản phẩm phù hợp.</p>
            </div>
          ) : (
            <>
              <Table>
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
                        <Link href={`/inventory/costs/${r.productId}`} className="text-primary underline-offset-4 hover:underline">
                          {r.sku}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {r.name}
                        {!r.isActive && (
                          <Badge variant="secondary" className="ml-1">
                            Ngừng HĐ
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className={`text-right ${r.negativeQuantity ? "text-destructive" : ""}`}>{r.hasHistory ? formatDecimal(r.quantityOnHand) : "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{r.movingAverageCost === null ? <span className="text-muted-foreground">Chưa có</span> : formatDecimal(r.movingAverageCost, " ₫")}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{r.hasHistory && r.movingAverageCost !== null ? formatDecimal(r.inventoryValue, " ₫") : "—"}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.lastEventTime)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {r.negativeQuantity && <Badge variant="destructive">Tồn tính giá vốn âm</Badge>}
                          {r.missingCost && <Badge variant="destructive">Thiếu dữ liệu giá vốn</Badge>}
                          {!r.hasHistory && <Badge variant="secondary">Chưa có lịch sử</Badge>}
                          {r.needsRebuild && (
                            <Badge variant="destructive" title={r.lastError ?? ""}>
                              Cần tính lại
                            </Badge>
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
                  if (q) sp.set("q", q);
                  if (warning) sp.set("warning", warning);
                  if (p > 1) sp.set("page", String(p));
                  const qs = sp.toString();
                  return qs ? `/inventory/costs?${qs}` : "/inventory/costs";
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
