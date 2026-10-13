import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, FlaskConical, Info } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getChannelOrderDetail } from "@/lib/channels/core/order-queries";
import { isMappingStatus } from "@/lib/channels/core/types";
import { ORDER_STATUS_LABELS } from "@/lib/channels/shopee/order-status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { ModelRowActions } from "../../products/model-row-actions";
import { fmtDate, formatDecimal, MAPPING_LABELS, MAPPING_VARIANT, toModelView } from "../../shared";
import { COGS_LABELS, COGS_VARIANT, COST_METHOD_LABELS, FINANCIAL_STATUS_LABELS, READINESS_LABELS, READINESS_VARIANT } from "../labels";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export default async function ShopeeOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("channel:view");
  const role = auth.profile.role;
  const canMap = hasPermission(role, "channel:map");
  const canManage = hasPermission(role, "channel:manage");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const detail = await getChannelOrderDetail(id);
  if (!detail) notFound();
  const o = detail.summary;

  return (
    <div className="space-y-6">
      <Link href="/shopee/orders" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Đơn hàng Shopee
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-2xl font-bold tracking-tight">{o.externalOrderSn}</h2>
        <Badge variant="outline">{ORDER_STATUS_LABELS[o.orderStatus] ?? o.orderStatus}</Badge>
        <Badge variant={READINESS_VARIANT[o.mappingReadiness]}>Mapping: {READINESS_LABELS[o.mappingReadiness]}</Badge>
        {o.dataSource === "fixture" && (
          <Badge variant="secondary">
            <FlaskConical /> FIXTURE
          </Badge>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Thông tin đơn</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="Shop">{o.shopName}</Field>
            <Field label="Trạng thái Shopee">{o.orderStatus}</Field>
            <Field label="Ngày tạo">{fmtDate(o.createdAtChannel)}</Field>
            <Field label="Thanh toán lúc">{fmtDate(detail.paidAtChannel)}</Field>
            <Field label="Lấy hàng lúc">{fmtDate(detail.pickupDoneAtChannel)}</Field>
            <Field label="Hạn giao">{fmtDate(detail.shipByDate)}</Field>
            <Field label="Đơn vị vận chuyển">{detail.shippingCarrier ?? "—"}</Field>
            <Field label="Thanh toán">
              {detail.paymentMethod ?? "—"}
              {detail.cod ? " (COD)" : ""}
            </Field>
            <Field label="Tổng tiền đơn (Shopee)">{formatDecimal(o.channelTotalAmount, " ₫")}</Field>
            <Field label="Phí ship ước tính (Shopee)">{formatDecimal(detail.estimatedShippingFee, " ₫")}</Field>
            <Field label="Cập nhật trên Shopee">{fmtDate(o.updatedAtChannel)}</Field>
            <Field label="Đồng bộ lần cuối">{fmtDate(o.lastSyncedAt)}</Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sản phẩm ({o.lineCount} dòng)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU Shopee</TableHead>
                <TableHead>Tên</TableHead>
                <TableHead>Biến thể</TableHead>
                <TableHead className="text-right">SL</TableHead>
                <TableHead className="text-right">Giá gốc</TableHead>
                <TableHead className="text-right">Giá bán</TableHead>
                <TableHead>SKU nội bộ</TableHead>
                <TableHead>Mapping</TableHead>
                <TableHead>Phương pháp</TableHead>
                <TableHead className="text-right">COGS / đơn vị</TableHead>
                <TableHead className="text-right">Tổng COGS</TableHead>
                <TableHead className="text-right">Ghép</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.lines.map((line) => {
                const unitStatus = line.unit && isMappingStatus(line.unit.mappingStatus) ? line.unit.mappingStatus : null;
                return (
                  <TableRow key={line.id}>
                    <TableCell className="font-mono text-xs">{line.modelSku ?? line.itemSku ?? <span className="text-muted-foreground">(trống)</span>}</TableCell>
                    <TableCell>
                      <p className="max-w-[240px] truncate" title={line.itemName}>
                        {line.itemName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        #{line.externalItemId}
                        {line.promotionType ? ` · ${line.promotionType}` : ""}
                      </p>
                    </TableCell>
                    <TableCell>{line.externalModelId ? line.modelName ?? `#${line.externalModelId}` : <span className="text-muted-foreground">Không biến thể</span>}</TableCell>
                    <TableCell className="text-right">{formatDecimal(line.quantity)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{formatDecimal(line.originalUnitPrice, " ₫")}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{formatDecimal(line.discountedUnitPrice, " ₫")}</TableCell>
                    <TableCell className="font-mono text-xs">{line.internalSku ?? "—"}</TableCell>
                    <TableCell>
                      {line.internalProductId ? (
                        <Badge variant="outline">Đã ghép</Badge>
                      ) : !line.unit ? (
                        <Badge variant="destructive" title="Sản phẩm chưa có trong danh mục Shopee đã đồng bộ">
                          Chưa có trong danh mục
                        </Badge>
                      ) : (
                        <Badge variant={unitStatus ? MAPPING_VARIANT[unitStatus] : "secondary"}>{unitStatus ? MAPPING_LABELS[unitStatus] : "Chưa ghép"}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {line.costMethod ? COST_METHOD_LABELS[line.costMethod] ?? line.costMethod : <span className="text-muted-foreground">Chưa tính</span>}
                      {line.cogsReversedAt && <p className="text-xs text-muted-foreground">đã hoàn kho (huỷ)</p>}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {line.costPerUnitSnapshot === null ? <span className="text-muted-foreground">Chưa tính</span> : formatDecimal(line.costPerUnitSnapshot, " ₫")}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {line.totalCogs === null ? <span className="text-muted-foreground">Chưa tính</span> : formatDecimal(line.totalCogs, " ₫")}
                      {line.negativeInventory && <p className="text-xs text-destructive">tồn tính giá vốn âm</p>}
                    </TableCell>
                    <TableCell className="text-right">
                      {line.unit && !line.internalProductId ? (
                        <ModelRowActions row={toModelView(line.unit)} canMap={canMap} canManage={canManage} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tài chính</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="Giá trị sản phẩm (giá bán × SL)">{o.itemGrossValue === null ? "Chưa xác định" : formatDecimal(o.itemGrossValue, " ₫")}</Field>
            <Field label="Giá trị theo giá gốc">{o.originalItemValue === null ? "Chưa xác định" : formatDecimal(o.originalItemValue, " ₫")}</Field>
            <Field label="Tổng số lượng">{formatDecimal(o.totalItemQuantity)}</Field>
            <Field label="Trạng thái COGS">
              <Badge variant={COGS_VARIANT[o.cogsReadiness]}>
                {COGS_LABELS[o.cogsReadiness]}
                {o.cogsReadiness === "partial" ? ` ${o.costedLines}/${o.lineCount}` : ""}
              </Badge>
            </Field>
            <Field label="Tổng COGS">
              {o.totalCogs !== null ? formatDecimal(o.totalCogs, " ₫") : <span className="text-muted-foreground">Chưa tính (thiếu dữ liệu giá vốn)</span>}
            </Field>
            <Field label="Trạng thái tài chính">{FINANCIAL_STATUS_LABELS[o.financialStatus] ?? o.financialStatus}</Field>
            <Field label="Lợi nhuận">Chưa có</Field>
          </dl>
          {detail.lines.some((l) => l.negativeInventory) && (
            <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              Tồn kho giá vốn đang âm. Có thể dữ liệu nhập hàng lịch sử chưa đầy đủ hoặc đơn bán đã được ghi nhận trước hàng nhập.
            </p>
          )}
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            Phí Shopee / settlement sẽ được đồng bộ ở SHOPEE-5.
            {o.financialSyncEligible ? " Đơn đã hoàn thành — đủ điều kiện đồng bộ tài chính khi tính năng sẵn sàng." : ""}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
