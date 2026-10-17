import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getChannelOrderDetail } from "@/lib/channels/core/order-queries";
import { isMappingStatus } from "@/lib/channels/core/types";
import { ORDER_STATUS_LABELS } from "@/lib/channels/shopee/order-status";
import { formatCurrency, formatDateTime, formatQuantity } from "@/lib/ui/format";
import { COGS_READINESS_TONE, MAPPING_STATUS_TONE, ORDER_STATUS_TONE, READINESS_TONE, toneOf } from "@/lib/ui/status";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { CardSkeleton } from "@/components/patterns/skeletons";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { ModelRowActions } from "../../products/model-row-actions";
import { MAPPING_LABELS, toModelView } from "../../shared";
import { COGS_LABELS, COST_METHOD_LABELS, READINESS_LABELS } from "../labels";
import { OrderFinancialSectionAsync } from "./financial-section";
import { OrderReleaseSectionAsync } from "./release-section";
import { OrderReturnsSectionAsync } from "./returns-section";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
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
  // The financial section streams in separately (Suspense) — the order
  // header / items never wait for the slower financial aggregate.
  const detail = await getChannelOrderDetail(id);
  if (!detail) notFound();
  const o = detail.summary;

  return (
    <PageContainer>
      <Link href="/shopee/orders" className="inline-flex items-center gap-1 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
        <ArrowLeft className="size-4" /> Đơn hàng Shopee
      </Link>

      <PageHeader
        title={<span className="font-mono">{o.externalOrderSn}</span>}
        description={`${o.shopName} · đặt lúc ${formatDateTime(o.createdAtChannel)}`}
        meta={
          <>
            <StatusBadge tone={toneOf(ORDER_STATUS_TONE, o.orderStatus)}>{ORDER_STATUS_LABELS[o.orderStatus] ?? o.orderStatus}</StatusBadge>
            <StatusBadge tone={toneOf(READINESS_TONE, o.mappingReadiness)}>Ghép SKU: {READINESS_LABELS[o.mappingReadiness]}</StatusBadge>
            <StatusBadge tone={toneOf(COGS_READINESS_TONE, o.cogsReadiness)}>
              COGS: {COGS_LABELS[o.cogsReadiness]}
              {o.cogsReadiness === "partial" ? ` ${o.costedLines}/${o.lineCount}` : ""}
            </StatusBadge>
            {o.dataSource === "fixture" && (
              <StatusBadge tone="info" icon={false}>
                FIXTURE
              </StatusBadge>
            )}
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Tóm tắt đơn</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 md:grid-cols-4">
            <Field label="Tổng tiền đơn (Shopee)">{formatCurrency(o.channelTotalAmount)}</Field>
            <Field label="Giá trị sản phẩm (giá bán × SL)">{o.itemGrossValue === null ? "Chưa xác định" : formatCurrency(o.itemGrossValue)}</Field>
            <Field label="Giá trị theo giá gốc">{o.originalItemValue === null ? "Chưa xác định" : formatCurrency(o.originalItemValue)}</Field>
            <Field label="Tổng số lượng">{formatQuantity(o.totalItemQuantity)}</Field>
            <Field label="Thanh toán">
              {detail.paymentMethod ?? "—"}
              {detail.cod ? " (COD)" : ""}
            </Field>
            <Field label="Đơn vị vận chuyển">{detail.shippingCarrier ?? "—"}</Field>
            <Field label="Phí ship ước tính (Shopee)">{formatCurrency(detail.estimatedShippingFee)}</Field>
            <Field label="Trạng thái Shopee">
              <span className="font-mono text-xs">{o.orderStatus}</span>
            </Field>
          </dl>
          <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-4 md:grid-cols-4">
            <Field label="Thanh toán lúc">{formatDateTime(detail.paidAtChannel)}</Field>
            <Field label="Lấy hàng lúc">{formatDateTime(detail.pickupDoneAtChannel)}</Field>
            <Field label="Hạn giao">{formatDateTime(detail.shipByDate)}</Field>
            <Field label="Cập nhật trên Shopee">{formatDateTime(o.updatedAtChannel)}</Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sản phẩm ({o.lineCount} dòng)</CardTitle>
          <CardDescription>SKU Shopee → SKU nội bộ và giá vốn đã chốt của từng dòng.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sản phẩm</TableHead>
                <TableHead>Ghép SKU</TableHead>
                <TableHead className="text-right">SL</TableHead>
                <TableHead className="text-right">Giá gốc</TableHead>
                <TableHead className="text-right">Giá bán</TableHead>
                <TableHead>Phương pháp</TableHead>
                <TableHead className="text-right">COGS / đơn vị</TableHead>
                <TableHead className="text-right">Tổng COGS</TableHead>
                <TableHead className="text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.lines.map((line) => {
                const unitStatus = line.unit && isMappingStatus(line.unit.mappingStatus) ? line.unit.mappingStatus : null;
                return (
                  <TableRow key={line.id}>
                    <TableCell className="whitespace-normal">
                      <p className="max-w-[280px] truncate font-medium" title={line.itemName}>
                        {line.itemName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {line.externalModelId ? line.modelName ?? `#${line.externalModelId}` : "Không biến thể"} · #{line.externalItemId}
                        {line.promotionType ? ` · ${line.promotionType}` : ""}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex min-w-48 flex-wrap items-center gap-1.5 text-xs">
                        <span className="font-mono">{line.modelSku ?? line.itemSku ?? <span className="text-muted-foreground">(trống)</span>}</span>
                        <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" />
                        {line.internalSku ? <span className="font-mono font-medium">{line.internalSku}</span> : <span className="text-muted-foreground">chưa có</span>}
                      </div>
                      <div className="mt-1">
                        {line.internalProductId ? (
                          <StatusBadge tone="success">Đã ghép</StatusBadge>
                        ) : !line.unit ? (
                          <StatusBadge tone="warning" title="Sản phẩm chưa có trong danh mục Shopee đã đồng bộ">
                            Chưa có trong danh mục
                          </StatusBadge>
                        ) : (
                          // On an order line an unmapped unit blocks COGS → warning, not just neutral.
                          <StatusBadge tone={unitStatus === "mapping_conflict" ? MAPPING_STATUS_TONE.mapping_conflict : "warning"}>{unitStatus ? MAPPING_LABELS[unitStatus] : "Chưa ghép"}</StatusBadge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{formatQuantity(line.quantity)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatCurrency(line.originalUnitPrice)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(line.discountedUnitPrice)}</TableCell>
                    <TableCell className="text-xs whitespace-normal">
                      {line.costMethod ? COST_METHOD_LABELS[line.costMethod] ?? line.costMethod : <span className="text-muted-foreground">Chưa tính</span>}
                      {line.cogsReversedAt && <p className="text-xs text-muted-foreground">đã hoàn kho (huỷ)</p>}
                      {line.comboComponents.length > 0 && (
                        <ul className="mt-1 min-w-48 space-y-0.5 text-muted-foreground" aria-label="Thành phần combo đã chụp">
                          {line.comboComponents.map((c) => (
                            <li key={c.componentProductId}>
                              <span className="font-mono">{c.componentSku}</span> × {formatQuantity(c.totalComponentQuantity)}
                              <span className="text-[11px]"> ({formatQuantity(c.quantityPerCombo)}/combo)</span>
                              {c.costPerUnitSnapshot !== null && <> · {formatCurrency(c.costPerUnitSnapshot)} = {formatCurrency(c.componentTotalCogs)}</>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{line.costPerUnitSnapshot === null ? <span className="text-muted-foreground">Chưa tính</span> : formatCurrency(line.costPerUnitSnapshot)}</TableCell>
                    <TableCell className="text-right">
                      {line.totalCogs === null ? <span className="text-muted-foreground">Chưa tính</span> : formatCurrency(line.totalCogs)}
                      {line.costPending && <p className="text-xs text-warning-text">chờ hóa đơn VAT của NCC</p>}
                      {line.costProvisional && <p className="text-xs text-warning-text">tạm tính (VAT mặc định)</p>}
                      {line.negativeInventory && <p className="text-xs text-warning-text">tồn tính giá vốn âm</p>}
                    </TableCell>
                    <TableCell className="text-right">
                      {line.unit && !line.internalProductId ? <ModelRowActions row={toModelView(line.unit)} canMap={canMap} canManage={canManage} /> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {detail.lines.some((l) => l.costPending) && (
            <Callout tone="warning" className="mt-4">
              Có dòng hàng nhập từ NCC công ty chưa được lập hóa đơn (chưa biết VAT đầu vào) — COGS để &quot;Chưa tính&quot; thay vì đoán VAT. COGS sẽ tự điền khi lập hóa đơn
              &quot;từ hàng đã nhận&quot; cho ngày hàng về tương ứng.
            </Callout>
          )}
          {detail.lines.some((l) => l.costProvisional) && (
            <Callout tone="warning" className="mt-4" title="COGS tạm tính.">
              Có dòng hàng nhập từ NCC công ty chưa được lập hóa đơn — giá vốn đang tính theo VAT mặc định. Khi lập hóa đơn &quot;từ hàng đã nhận&quot; cho ngày hàng về tương ứng,
              COGS và lợi nhuận dự kiến của đơn này tự cập nhật theo VAT thật (có ghi lịch sử điều chỉnh).
            </Callout>
          )}
          {detail.lines.some((l) => l.negativeInventory) && (
            <Callout tone="warning" className="mt-4">
              Tồn kho giá vốn đang âm. Có thể dữ liệu nhập hàng lịch sử chưa đầy đủ hoặc đơn bán đã được ghi nhận trước hàng nhập.
            </Callout>
          )}
        </CardContent>
      </Card>

      <Suspense fallback={<CardSkeleton lines={6} />}>
        <OrderFinancialSectionAsync orderId={id} summary={o} />
      </Suspense>
      <Suspense fallback={<CardSkeleton lines={4} />}>
        <OrderReleaseSectionAsync orderId={id} />
      </Suspense>
      <Suspense fallback={null}>
        <OrderReturnsSectionAsync orderId={id} />
      </Suspense>

      <p className="text-xs text-muted-foreground">Đồng bộ lần cuối: {formatDateTime(o.lastSyncedAt)}</p>
    </PageContainer>
  );
}
