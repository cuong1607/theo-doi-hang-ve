import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getLedgerSourceLinks, getProductCostLedger, getProductCostState } from "@/lib/inventory-cost/queries";
import { COST_EVENT_LABELS } from "@/lib/inventory-cost/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { fmtDate, formatDecimal } from "../../../shopee/shared";
import { RebuildCostButton } from "../rebuild-button";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE_LABELS: Record<string, string> = {
  receipt_item: "Phiếu nhập",
  channel_order_item: "Đơn Shopee",
  manual_adjustment: "Điều chỉnh",
  opening_balance: "Tồn đầu kỳ",
  return_item: "Hàng trả",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`text-xl font-bold ${tone === "danger" ? "text-destructive" : ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

export default async function ProductCostDetailPage({ params }: { params: Promise<{ productId: string }> }) {
  const auth = await requirePermission("cost:view");
  const canManage = hasPermission(auth.profile.role, "cost:manage");
  const { productId } = await params;
  if (!UUID.test(productId)) notFound();
  const product = await getProductCostState(productId);
  if (!product) notFound();
  const { rows, total } = await getProductCostLedger(productId);
  const links = await getLedgerSourceLinks(rows);

  return (
    <div className="space-y-6">
      <Link href="/inventory/costs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Giá vốn sản phẩm
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{product.name}</h2>
          <p className="font-mono text-sm text-muted-foreground">
            {product.sku}
            {product.supplierName ? ` · ${product.supplierName}` : ""}
          </p>
        </div>
        {canManage && <RebuildCostButton productId={productId} />}
      </div>

      {product.negativeQuantity && (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Tồn kho giá vốn đang âm. Có thể dữ liệu nhập hàng lịch sử chưa đầy đủ hoặc đơn bán đã được ghi nhận trước hàng nhập.
        </p>
      )}
      {product.needsRebuild && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Lần tự tính giá vốn gần nhất bị lỗi ({product.lastError ?? "không rõ"}). Phiếu nhập vẫn được lưu — admin hãy bấm &quot;Tính lại giá vốn&quot;.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="SL tính giá vốn" value={product.hasHistory ? formatDecimal(product.quantityOnHand) : "—"} tone={product.negativeQuantity ? "danger" : undefined} />
        <Stat label="Giá vốn bình quân" value={product.movingAverageCost === null ? "Chưa có" : formatDecimal(product.movingAverageCost, " ₫")} />
        <Stat label="Giá trị tồn theo giá vốn" value={product.hasHistory && product.movingAverageCost !== null ? formatDecimal(product.inventoryValue, " ₫") : "—"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sổ giá vốn ({total} sự kiện)</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Chưa có lịch sử giá vốn.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ngày</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead>Nguồn</TableHead>
                  <TableHead className="text-right">SL thay đổi</TableHead>
                  <TableHead className="text-right">SL trước</TableHead>
                  <TableHead className="text-right">SL sau</TableHead>
                  <TableHead className="text-right">Đơn giá vốn</TableHead>
                  <TableHead className="text-right">BQ trước</TableHead>
                  <TableHead className="text-right">BQ sau</TableHead>
                  <TableHead className="text-right">Giá trị</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => {
                  const href = e.sourceId ? links.get(e.sourceId) : undefined;
                  return (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs whitespace-nowrap">{fmtDate(e.eventTime)}</TableCell>
                      <TableCell className="text-xs">
                        {COST_EVENT_LABELS[e.eventType]}
                        {e.negativeInventory && <p className="text-destructive">tồn âm</p>}
                      </TableCell>
                      <TableCell className="text-xs">
                        {SOURCE_LABELS[e.sourceType] ?? e.sourceType}{" "}
                        {href ? (
                          <Link href={href} className="font-mono text-primary underline-offset-4 hover:underline">
                            {e.sourceExternalId ?? "xem"}
                          </Link>
                        ) : (
                          <span className="font-mono">{e.sourceExternalId ?? ""}</span>
                        )}
                      </TableCell>
                      <TableCell className={`text-right ${e.quantityChange.startsWith("-") ? "text-destructive" : "text-primary"}`}>
                        {e.quantityChange.startsWith("-") ? "" : "+"}
                        {formatDecimal(e.quantityChange)}
                      </TableCell>
                      <TableCell className="text-right">{formatDecimal(e.qtyBefore)}</TableCell>
                      <TableCell className={`text-right ${e.qtyAfter.startsWith("-") ? "text-destructive" : ""}`}>{formatDecimal(e.qtyAfter)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{e.unitCost === null ? <span className="text-muted-foreground">Chưa tính</span> : formatDecimal(e.unitCost, " ₫")}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{formatDecimal(e.avgCostBefore, " ₫")}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{formatDecimal(e.avgCostAfter, " ₫")}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{e.movementCost === null ? <span className="text-muted-foreground">Chưa tính</span> : formatDecimal(e.movementCost, " ₫")}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {total > rows.length && <p className="pt-3 text-xs text-muted-foreground">Hiển thị {rows.length} sự kiện gần nhất.</p>}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        <Badge variant="outline">Lưu ý</Badge> Sổ giá vốn là bản dựng lại hiện tại. COGS của đơn hàng cũ là snapshot tại thời điểm tính và không tự thay đổi.
      </p>
    </div>
  );
}
