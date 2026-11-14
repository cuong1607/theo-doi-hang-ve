import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { hasPermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { INCOMPLETE_REASON_LABEL, PAYOUT_RECON_INFO, PAYOUT_SOURCE_LABEL, PAYOUT_STATUS_LABEL, RESOLUTION_INFO } from "@/lib/channels/core/payout-display";
import { getPayout, getPayoutAdjustments, getPayoutNotes, getPayoutOrders } from "@/lib/channels/core/payouts";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency, formatDateTime, formatSignedCurrency } from "@/lib/ui/format";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { PayoutNoteForm } from "./note-form";

export const dynamic = "force-dynamic";

function Line({ label, value, strong, hint }: { label: React.ReactNode; value: React.ReactNode; strong?: boolean; hint?: React.ReactNode }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${strong ? "border-t font-medium" : ""}`}>
      <span className="text-sm">
        {label}
        {hint && <span className="block text-xs font-normal text-muted-foreground">{hint}</span>}
      </span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

export default async function PayoutDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("channel:view");
  const canReconcile = hasPermission(auth.profile.role, "payout:reconcile");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = createAdminClient();
  const p = await getPayout(db, id);
  if (!p) notFound();
  const [orders, adjustments, notes] = await Promise.all([getPayoutOrders(db, id), getPayoutAdjustments(db, id), getPayoutNotes(db, id)]);
  const info = PAYOUT_RECON_INFO[p.reconciliationStatus];
  const wallet = p.payoutSource === "wallet";

  return (
    <PageContainer>
      <Link href="/shopee/payouts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="size-4" /> Giải ngân & payout
      </Link>
      <PageHeader
        title={<span className="font-mono">{p.providerPayoutId}</span>}
        description={
          <span>
            {p.shopName} · {PAYOUT_SOURCE_LABEL[p.payoutSource ?? ""] ?? p.payoutSource} · {formatDateTime(p.payoutTime)} · {PAYOUT_STATUS_LABEL[p.payoutStatus]}
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge tone={info.tone} icon={false}>
              {info.label}
            </StatusBadge>
            {p.resolutionStatus !== "open" && (
              <StatusBadge tone={RESOLUTION_INFO[p.resolutionStatus].tone} icon={false}>
                {RESOLUTION_INFO[p.resolutionStatus].label}
              </StatusBadge>
            )}
            Đồng bộ lần cuối {formatDateTime(p.syncedAt)}
          </span>
        }
      />

      {p.reconciliationStatus === "mismatch" && (
        <Callout tone="danger" title={`Lệch ${formatSignedCurrency(p.differenceAmount)}`}>
          Shopee chuyển {formatCurrency(p.payoutAmount)} nhưng các khoản giải ngân + điều chỉnh {wallet ? "+ số dư ví " : ""}cộng lại {p.expectedAmount ? formatCurrency(p.expectedAmount) : "—"}. Xem bảng bên dưới để tìm
          khoản thiếu / thừa.{p.resolutionReason ? ` Lý do đã ghi nhận: ${p.resolutionReason}.` : ""}
        </Callout>
      )}
      {p.reconciliationStatus === "incomplete" && (
        <Callout tone="warning" title="Chưa đủ dữ liệu để đối soát">
          {INCOMPLETE_REASON_LABEL[p.incompleteReason ?? ""] ?? p.incompleteReason}. Đây không phải lệch — trạng thái sẽ tự cập nhật khi có đủ dữ liệu.
        </Callout>
      )}
      {p.lastProviderAmount && (
        <Callout tone="warning" title="Shopee báo số tiền khác cho payout này">
          Lần đồng bộ sau báo {formatCurrency(p.lastProviderAmount)} (lưu ban đầu {formatCurrency(p.payoutAmount)}). Số payout gốc không bị ghi đè — kiểm tra với Shopee.
        </Callout>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Đối soát</CardTitle>
            <CardDescription>
              {wallet
                ? "Rút tiền = số dư ví trước kỳ + tiền giải ngân + điều chỉnh − số dư còn lại sau khi rút."
                : "Payout = tổng tiền giải ngân của các đơn + các khoản điều chỉnh."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-0">
            <Line label={`Giải ngân đơn hàng (${p.orderCount} đơn)`} value={p.ordersReleasedTotal ? formatCurrency(p.ordersReleasedTotal) : "—"} />
            <Line label={`Điều chỉnh (${p.adjustmentCount} khoản)`} value={p.adjustmentsTotal ? formatSignedCurrency(p.adjustmentsTotal) : "—"} />
            {wallet && <Line label="Số dư ví trước kỳ" value={p.openingBalance === null ? "chưa rõ" : `+${formatCurrency(p.openingBalance)}`} />}
            {wallet && <Line label="Số dư còn lại sau khi rút" value={p.closingBalance === null ? "chưa rõ" : `−${formatCurrency(p.closingBalance)}`} />}
            <Line label="= Kỳ vọng" value={p.expectedAmount ? formatCurrency(p.expectedAmount) : "—"} strong />
            <Line label="Shopee chuyển (thực tế)" value={formatCurrency(p.payoutAmount)} hint="Shopee payout / rút tiền — không phải xác nhận tiền đã về ngân hàng" />
            <Line
              label="Chênh lệch (thực tế − kỳ vọng)"
              value={<span className={p.reconciliationStatus === "mismatch" ? "text-danger-text" : ""}>{p.differenceAmount === null ? "—" : formatSignedCurrency(p.differenceAmount)}</span>}
              strong
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ghi chú đối soát ({notes.length})</CardTitle>
            <CardDescription>Ghi chú và trạng thái xử lý không bao giờ sửa số tiền hay số chênh lệch.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {canReconcile ? <PayoutNoteForm payoutId={p.id} current={p.resolutionStatus} /> : <p className="text-sm text-muted-foreground">Chỉ admin được ghi chú / đóng chênh lệch.</p>}
            {notes.length > 0 && (
              <ul className="space-y-2 border-t pt-3">
                {notes.map((n) => (
                  <li key={n.id} className="text-sm">
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(n.createdAt)} · {n.createdByName ?? "hệ thống"}
                      {n.differenceAtNote ? ` · lệch lúc ghi ${formatSignedCurrency(n.differenceAtNote)}` : ""}
                    </span>
                    <span className="block">{n.note}</span>
                    {n.resolutionStatus && (
                      <span className="block text-xs text-muted-foreground">
                        → {RESOLUTION_INFO[n.resolutionStatus].label}
                        {n.resolutionReason ? `: ${n.resolutionReason}` : ""}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Đơn trong payout ({orders.length})</CardTitle>
          <CardDescription>Kỳ vọng = thu nhập thực tế của đơn (quyết toán sau điều chỉnh, gồm trả hàng). Chênh lệch = giải ngân − kỳ vọng.</CardDescription>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Không có đơn nào trong lần chuyển này.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã đơn</TableHead>
                  <TableHead>Thời điểm</TableHead>
                  <TableHead className="text-right">Giải ngân</TableHead>
                  <TableHead className="text-right">Kỳ vọng</TableHead>
                  <TableHead className="text-right">Chênh lệch</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => (
                  <TableRow key={o.externalOrderSn}>
                    <TableCell className="font-mono text-xs">
                      {o.orderId ? (
                        <Link href={`/shopee/orders/${o.orderId}`} className="text-primary underline-offset-4 hover:underline">
                          {o.externalOrderSn}
                        </Link>
                      ) : (
                        <>
                          {o.externalOrderSn}
                          <span className="block font-sans text-warning-text">chưa có trong hệ thống</span>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDateTime(o.occurredAt)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(o.releasedAmount)}</TableCell>
                    <TableCell className="text-right">{o.expectedAmount === null ? <span className="text-muted-foreground">—</span> : formatCurrency(o.expectedAmount)}</TableCell>
                    <TableCell className={`text-right ${o.differenceAmount && o.differenceAmount !== "0.00" ? "text-danger-text" : ""}`}>{o.differenceAmount === null ? "—" : formatSignedCurrency(o.differenceAmount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Điều chỉnh ({adjustments.length})</CardTitle>
          <CardDescription>Bồi thường, sửa phí, khấu trừ hoàn tiền… — lưu riêng, không gộp vào dòng đơn. Dấu: + cộng tiền, − trừ tiền.</CardDescription>
        </CardHeader>
        <CardContent>
          {adjustments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Không có điều chỉnh.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Loại</TableHead>
                  <TableHead>Mô tả</TableHead>
                  <TableHead>Đơn</TableHead>
                  <TableHead>Thời điểm</TableHead>
                  <TableHead className="text-right">Số tiền</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adjustments.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs">{a.adjustmentType ?? "—"}</TableCell>
                    <TableCell className="max-w-72 text-xs">{a.description ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {a.orderId ? (
                        <Link href={`/shopee/orders/${a.orderId}`} className="underline-offset-4 hover:underline">
                          {a.externalOrderSn}
                        </Link>
                      ) : (
                        (a.externalOrderSn ?? "—")
                      )}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDateTime(a.occurredAt)}</TableCell>
                    <TableCell className="text-right">{formatSignedCurrency(a.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
