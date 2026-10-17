// SHOPEE-7 §25: payment / release of one order — kept apart from the profit
// section: profit = escrow income − net COGS; this is cash (did Shopee
// release it, how much, when, in which payout). Streams in (Suspense).
import Link from "next/link";

import { INCOME_STATUS_INFO } from "@/lib/channels/core/payout-display";
import { getOrderIncomeStatus } from "@/lib/channels/core/payouts";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency, formatDateTime, formatSignedCurrency } from "@/lib/ui/format";
import { Callout } from "@/components/patterns/callout";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm tabular-nums">{children}</dd>
    </div>
  );
}

export async function OrderReleaseSectionAsync({ orderId }: { orderId: string }) {
  const s = await getOrderIncomeStatus(createAdminClient(), orderId);
  if (!s) return null;
  const info = INCOME_STATUS_INFO[s.incomeStatus];
  const hasLater = s.laterAdjustmentAmount !== null && s.laterAdjustmentAmount !== "0.00";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Giải ngân Shopee
          <StatusBadge tone={info.tone} icon={false}>
            {info.label}
          </StatusBadge>
          {s.releaseStale && (
            <StatusBadge tone="warning" icon={false}>
              Chờ quá lâu
            </StatusBadge>
          )}
        </CardTitle>
        <CardDescription>Dòng tiền — tách riêng khỏi lãi của đơn. {info.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {s.incomeStatus === "mismatch" && (
          <Callout tone="danger" title={`Lệch ${formatSignedCurrency(s.differenceAmount)}`}>
            Shopee giải ngân {s.releasedAmount ? formatCurrency(s.releasedAmount) : "—"}
            {hasLater ? ` (cộng điều chỉnh về sau ${formatSignedCurrency(s.laterAdjustmentAmount)})` : ""} nhưng thu nhập thực tế của đơn là {s.expectedAmount ? formatCurrency(s.expectedAmount) : "—"}.
          </Callout>
        )}
        {s.releaseStale && (
          <Callout tone="warning">Đơn đã hoàn thành từ {formatDateTime(s.completedAtChannel)} mà Shopee vẫn chưa giải ngân — nên kiểm tra trên Seller Center.</Callout>
        )}
        <dl className="divide-y">
          <Row label="Thu nhập Shopee thực tế (kỳ vọng)">{s.expectedAmount ? formatCurrency(s.expectedAmount) : <span className="text-muted-foreground">chưa có quyết toán</span>}</Row>
          <Row label="Đã giải ngân">{s.releasedAmount ? formatCurrency(s.releasedAmount) : <span className="text-muted-foreground">—</span>}</Row>
          {hasLater && <Row label="Điều chỉnh sau giải ngân">{formatSignedCurrency(s.laterAdjustmentAmount)}</Row>}
          <Row label="Chênh lệch">{s.differenceAmount === null ? <span className="text-muted-foreground">—</span> : formatSignedCurrency(s.differenceAmount)}</Row>
          <Row label="Thời điểm giải ngân">{s.actualPayoutTime ? formatDateTime(s.actualPayoutTime) : <span className="text-muted-foreground">—</span>}</Row>
          {s.daysToRelease !== null && <Row label="Số ngày từ hoàn thành → giải ngân">{s.daysToRelease.replace(".", ",")} ngày</Row>}
          <Row label="Payout">
            {s.payoutId ? (
              <Link href={`/shopee/payouts/${s.payoutId}`} className="font-mono text-primary underline-offset-4 hover:underline">
                {s.providerPayoutId}
              </Link>
            ) : (
              <span className="text-muted-foreground">chưa nằm trong payout nào</span>
            )}
          </Row>
        </dl>
        {s.incomeSyncedAt && <p className="text-xs text-muted-foreground">Cập nhật giải ngân lúc {formatDateTime(s.incomeSyncedAt)}. “Giải ngân” là Shopee chuyển tiền của đơn — không xác nhận tiền đã về ngân hàng.</p>}
      </CardContent>
    </Card>
  );
}
