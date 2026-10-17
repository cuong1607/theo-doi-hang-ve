import { ArrowLeft, Coins, PackageCheck, Receipt, Wallet } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { getReturnDetail } from "@/lib/channels/core/returns";
import { DISPOSITION_INFO, returnStatusInfo } from "@/lib/channels/shopee/return-status";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency, formatDateTime, formatQuantity, formatSignedCurrency } from "@/lib/ui/format";
import { Callout } from "@/components/patterns/callout";
import { MetricCard } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { DispositionControl } from "../disposition-control";

export const dynamic = "force-dynamic";

const EFFECT_LABELS: Record<string, string> = { none: "không đổi tồn kho", restocked: "nhập lại kho", restock_reversed: "huỷ nhập lại kho" };

export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("channel:view");
  const canDispose = hasPermission(auth.profile.role, "return:disposition");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await getReturnDetail(createAdminClient(), id);
  if (!detail) notFound();
  const s = detail.summary;
  const st = returnStatusInfo(s.status);
  const f = detail.financials;

  return (
    <PageContainer>
      <Link href="/shopee/returns" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="size-4" /> Trả hàng Shopee
      </Link>
      <PageHeader
        title={<span className="font-mono">{s.externalReturnSn}</span>}
        description={
          <span>
            {s.shopName} · đơn{" "}
            <Link href={`/shopee/orders/${s.orderId}`} className="font-mono text-primary underline-offset-4 hover:underline">
              {s.externalOrderSn}
            </Link>{" "}
            · yêu cầu lúc {formatDateTime(s.createdAtChannel)}
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge tone={st.tone} icon={false}>
              {st.label}
            </StatusBadge>
            Đồng bộ lần cuối {formatDateTime(detail.lastSyncedAt)}
          </span>
        }
      />

      <Callout tone="info" title="Hoàn tiền ≠ nhập lại kho.">
        Số tiền hoàn của Shopee đã nằm trong thu nhập thực nhận (escrow) — không bị trừ thêm lần nữa. Hàng chỉ về tồn kho và giá vốn chỉ được hoàn lại khi chọn cách
        xử lý “Nhập lại kho” cho từng dòng; Hỏng / Thất lạc / Huỷ bỏ giữ nguyên giá vốn đã tính.
      </Callout>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Hoàn tiền (theo yêu cầu trả hàng)" icon={Receipt} value={s.refundAmount === null ? "—" : formatCurrency(s.refundAmount)} hint="số liệu vận hành — tài chính lấy theo escrow" />
        <MetricCard label="Thu nhập thực nhận (escrow)" icon={Wallet} value={f?.actualShopeeIncome == null ? <span className="text-muted-foreground">Chưa quyết toán</span> : formatCurrency(f.actualShopeeIncome)} hint={f?.sellerCompensationAmount ? `gồm bồi thường cho người bán ${formatCurrency(f.sellerCompensationAmount)}` : "đã gồm hoàn tiền / điều chỉnh"} />
        <MetricCard
          label="Giá vốn ròng"
          icon={Coins}
          value={f?.netCogs == null ? <span className="text-muted-foreground">Chưa tính</span> : formatCurrency(f.netCogs)}
          hint={f ? `gốc ${f.internalCogs === null ? "chưa tính" : formatCurrency(f.internalCogs)} − hoàn ${formatCurrency(f.reversedCogs)}` : undefined}
        />
        <MetricCard
          label="Lợi nhuận thực tế"
          icon={PackageCheck}
          value={f?.actualProfit == null ? <span className="text-muted-foreground">Chưa tính</span> : formatSignedCurrency(f.actualProfit)}
          tone={f?.actualProfit == null ? "neutral" : f.actualProfit.startsWith("-") ? "danger" : "success"}
          hint="thực nhận − giá vốn ròng"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sản phẩm trả ({detail.items.length})</CardTitle>
          <CardDescription>Mỗi dòng gắn với dòng đơn gốc — giá vốn hoàn lại luôn theo snapshot lúc bán, không theo giá vốn hiện tại.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sản phẩm</TableHead>
                <TableHead>Dòng đơn gốc</TableHead>
                <TableHead className="text-right">SL trả</TableHead>
                <TableHead className="text-right">Giá vốn gốc</TableHead>
                <TableHead>Cách xử lý</TableHead>
                <TableHead>Tồn kho</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.items.map((it) => {
                const line = it.orderLine;
                const restockable = !!line && line.totalCogs !== null && !line.cogsReversedAt;
                const label = `${it.itemName ?? it.externalItemId} × ${formatQuantity(it.quantity)}`;
                return (
                  <TableRow key={it.id} className="align-top">
                    <TableCell className="whitespace-normal">
                      <p className="max-w-64 font-medium">{it.itemName ?? `#${it.externalItemId}`}</p>
                      <p className="text-xs text-muted-foreground">
                        #{it.externalItemId}
                        {it.externalModelId ? ` · model ${it.externalModelId}` : ""}
                        {it.refundAmount ? ` · hoàn ${formatCurrency(it.refundAmount)}` : ""}
                      </p>
                    </TableCell>
                    <TableCell className="text-xs whitespace-normal">
                      {!line ? (
                        <span className="text-warning-text">Không khớp dòng đơn gốc (hoặc đã trả đủ) — không nhập lại kho được</span>
                      ) : (
                        <>
                          <span className="font-mono">{line.internalSku ?? "chưa ghép SKU"}</span>
                          {line.productType === "combo" && (
                            <StatusBadge tone="info" icon={false} className="ml-1.5">
                              Combo
                            </StatusBadge>
                          )}
                          <span className="block text-muted-foreground">đã bán {formatQuantity(line.quantity)}</span>
                          {line.components.length > 0 && (
                            <ul className="mt-1 text-muted-foreground" aria-label="Thành phần combo lúc bán">
                              {line.components.map((c) => (
                                <li key={c.componentProductId}>
                                  <span className="font-mono">{c.sku}</span> × {formatQuantity(c.quantityPerCombo)}/combo
                                  {c.costPerUnit !== null && <> · {formatCurrency(c.costPerUnit)}</>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{formatQuantity(it.quantity)}</TableCell>
                    <TableCell className="text-right text-xs">
                      {line?.costPerUnitSnapshot ? formatCurrency(line.costPerUnitSnapshot) : <span className="text-muted-foreground">chưa có</span>}
                      {line?.costPerUnitSnapshot && <span className="block text-muted-foreground">/ đơn vị bán</span>}
                    </TableCell>
                    <TableCell>
                      {canDispose ? (
                        <DispositionControl returnItemId={it.id} current={it.disposition} restockable={restockable} label={label} />
                      ) : (
                        <StatusBadge tone={DISPOSITION_INFO[it.disposition].tone} icon={false}>
                          {DISPOSITION_INFO[it.disposition].label}
                        </StatusBadge>
                      )}
                      {canDispose && !restockable && line && (
                        <span className="mt-1 block text-xs text-muted-foreground">{line.cogsReversedAt ? "Đơn đã huỷ & hoàn kho" : "Dòng đơn chưa có giá vốn gốc"}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs whitespace-normal">
                      {it.restocks.length === 0 ? (
                        <span className="text-muted-foreground">{it.disposition === "pending" ? "chờ quyết định" : "không nhập kho"}</span>
                      ) : (
                        <ul className="text-success-text">
                          {it.restocks.map((r) => (
                            <li key={r.id}>
                              Nhập lại <span className="font-mono">{r.sku}</span> × {formatQuantity(r.quantity)} · {formatCurrency(r.unitCost)} = {formatCurrency(r.totalCost)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {it.events.length > 0 && (
                        <details className="mt-1 text-muted-foreground">
                          <summary className="cursor-pointer">Lịch sử ({it.events.length})</summary>
                          <ul className="mt-1 space-y-0.5">
                            {it.events.map((e, i) => (
                              <li key={i}>
                                {formatDateTime(e.changedAt)} · {DISPOSITION_INFO[e.oldDisposition as keyof typeof DISPOSITION_INFO]?.label ?? e.oldDisposition} →{" "}
                                {DISPOSITION_INFO[e.newDisposition as keyof typeof DISPOSITION_INFO]?.label ?? e.newDisposition} ({EFFECT_LABELS[e.inventoryEffect] ?? e.inventoryEffect}
                                {e.cogsDelta !== "0" && e.cogsDelta !== "0.00" ? `, ${formatSignedCurrency(e.cogsDelta)}` : ""}){e.changedByName ? ` · ${e.changedByName}` : ""}
                                {e.reason ? ` — ${e.reason}` : ""}
                              </li>
                            ))}
                          </ul>
                        </details>
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
          <CardTitle>Thông tin trả hàng</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <p>
            <span className="text-muted-foreground">Lý do: </span>
            {s.reason ?? "—"}
            {detail.textReason ? ` — ${detail.textReason}` : ""}
          </p>
          <p>
            <span className="text-muted-foreground">Vận chuyển hoàn: </span>
            {detail.reverseLogisticsStatus ?? (detail.needsLogistics === false ? "không cần gửi trả" : "—")}
            {detail.trackingNumber ? ` · ${detail.trackingNumber}` : ""}
          </p>
          <p>
            <span className="text-muted-foreground">Thương lượng: </span>
            {detail.negotiationStatus ?? "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Bồi thường người bán: </span>
            {detail.sellerCompensationStatus ?? "—"}
            {s.sellerCompensationAmount ? ` · ${formatCurrency(s.sellerCompensationAmount)}` : ""}
          </p>
          <p>
            <span className="text-muted-foreground">Loại: </span>
            {detail.returnRefundType ?? "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Hoàn tất lúc: </span>
            {detail.completedAt ? formatDateTime(detail.completedAt) : "—"}
          </p>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
