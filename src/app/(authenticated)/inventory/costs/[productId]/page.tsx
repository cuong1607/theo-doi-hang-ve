import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getLedgerSourceLinks, getProductCostLedger, getProductCostState } from "@/lib/inventory-cost/queries";
import { COST_BASIS_LABELS, COST_EVENT_LABELS } from "@/lib/inventory-cost/types";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { MetricCard } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
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
    <PageContainer>
      <Link href="/inventory/costs" className="inline-flex items-center gap-1 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
        <ArrowLeft className="size-4" /> Giá vốn sản phẩm
      </Link>
      <PageHeader
        title={product.name}
        description={
          <span className="font-mono">
            {product.sku}
            {product.supplierName ? ` · ${product.supplierName}` : ""}
          </span>
        }
        actions={canManage ? <RebuildCostButton productId={productId} /> : undefined}
      />

      {product.negativeQuantity && (
        <Callout tone="warning">Tồn kho giá vốn đang âm. Có thể dữ liệu nhập hàng lịch sử chưa đầy đủ hoặc đơn bán đã được ghi nhận trước hàng nhập.</Callout>
      )}
      {product.vatPending && (
        <Callout tone="warning" title="Giá vốn bình quân đang chờ VAT.">
          Tồn hiện tại có hàng nhập từ NCC công ty chưa được lập hóa đơn (chưa biết VAT) — giá vốn bình quân tạm chưa xác định, đơn bán trong thời gian này để &quot;COGS chưa
          tính&quot;. Khi lập hóa đơn &quot;từ hàng đã nhận&quot; cho ngày hàng về đó, hệ thống tự tính lại và điền COGS cho các đơn đang chờ.
        </Callout>
      )}
      {product.needsRebuild && (
        <Callout tone="danger" title="Lần tự tính giá vốn gần nhất bị lỗi.">
          ({product.lastError ?? "không rõ"}). Phiếu nhập vẫn được lưu — admin hãy bấm &quot;Dựng lại sổ giá vốn (sửa lỗi)&quot;.
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard label="SL tính giá vốn" value={product.hasHistory ? formatDecimal(product.quantityOnHand) : "—"} tone={product.negativeQuantity ? "warning" : "neutral"} />
        <MetricCard
          label="Giá vốn bình quân"
          value={product.movingAverageCost === null ? (product.vatPending ? "Chờ VAT" : "Chưa có") : formatDecimal(product.movingAverageCost, " ₫")}
          tone={product.vatPending ? "warning" : "neutral"}
          hint="gồm VAT đầu vào khi áp dụng"
        />
        <MetricCard label="Giá trị tồn theo giá vốn" value={product.hasHistory && product.movingAverageCost !== null ? formatDecimal(product.inventoryValue, " ₫") : "—"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sổ giá vốn ({total} sự kiện)</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState title="Chưa có lịch sử giá vốn." description="Sổ giá vốn bắt đầu từ phiếu nhập đầu tiên của sản phẩm." />
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
                  <TableHead className="text-right">Giá nhập (chưa VAT)</TableHead>
                  <TableHead className="text-right">VAT</TableHead>
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
                        {e.negativeInventory && <p className="text-warning-text">tồn âm</p>}
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
                      <TableCell className={`text-right ${e.quantityChange.startsWith("-") ? "text-warning-text" : "text-success-text"}`}>
                        {e.quantityChange.startsWith("-") ? "" : "+"}
                        {formatDecimal(e.quantityChange)}
                      </TableCell>
                      <TableCell className="text-right">{formatDecimal(e.qtyBefore)}</TableCell>
                      <TableCell className={`text-right ${e.qtyAfter.startsWith("-") ? "text-warning-text" : ""}`}>{formatDecimal(e.qtyAfter)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{e.baseUnitCost === null ? <span className="text-muted-foreground">—</span> : formatDecimal(e.baseUnitCost, " ₫")}</TableCell>
                      <TableCell className="text-right text-xs whitespace-nowrap">
                        {e.eventType !== "purchase_in" ? (
                          <span className="text-muted-foreground">—</span>
                        ) : e.costBasis === "vat_pending" ? (
                          <span className="text-warning-text">chờ hóa đơn</span>
                        ) : e.costBasis === "invoice_vat" ? (
                          <span title={COST_BASIS_LABELS.invoice_vat}>{formatDecimal(e.vatRate)}%</span>
                        ) : e.costBasis === "raw" ? (
                          <span className="text-muted-foreground" title={COST_BASIS_LABELS.raw}>
                            không áp dụng
                          </span>
                        ) : (
                          <span className="text-muted-foreground" title="Ghi trước khi tính VAT — dựng lại sổ để cập nhật">
                            chưa dựng lại
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {e.unitCost === null ? (
                          <span className="text-muted-foreground">{e.costPending || e.costBasis === "vat_pending" ? "Chờ VAT" : "Chưa tính"}</span>
                        ) : (
                          formatDecimal(e.unitCost, " ₫")
                        )}
                      </TableCell>
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
      <Callout tone="neutral">
        Đơn giá vốn của hàng nhập từ NCC công ty = giá nhập (chưa VAT) × (1 + VAT% của hóa đơn NCC đã lập cho ngày hàng về đó). NCC hộ kinh doanh: giá nhập, không cộng VAT. Sổ
        giá vốn là bản dựng lại hiện tại; COGS của đơn hàng cũ là snapshot tại thời điểm tính và chỉ thay đổi khi admin điều chỉnh có chủ đích.
      </Callout>
    </PageContainer>
  );
}
