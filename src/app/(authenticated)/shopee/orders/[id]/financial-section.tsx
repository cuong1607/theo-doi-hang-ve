// SHOPEE-5 order financial breakdown (server component, database only).
// NULL = "Chưa có" / "Chưa tính"; 0 = a confirmed "0 ₫" — never conflated.
// UIUX-1: statement layout (income → − COGS → = profit), only the profit /
// loss and real problems are coloured; every amount is the stored NUMERIC
// (no money math in the UI).
import { Coins, ReceiptText, TrendingUp, Wallet } from "lucide-react";
import { cn } from "cn";

import { Callout } from "@/components/patterns/callout";
import { MetricCard } from "@/components/patterns/metric-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getOrderFinancialDetail, type FinancialMoneyColumn, type OrderFinancialDetail } from "@/lib/channels/core/financial-queries";
import { formatCurrency, formatDateTime, formatDecimalString, numericSign } from "@/lib/ui/format";
import { FINANCIAL_STATUS_TONE, profitTone, RECONCILIATION_TONE, TONE_TEXT_CLASS, toneOf } from "@/lib/ui/status";

import { FINANCIAL_STATUS_LABELS, RECONCILIATION_LABELS } from "../labels";

function Money({ value, missing = "Chưa có", signed }: { value: string | null; missing?: string; signed?: boolean }) {
  if (value === null) return <span className="font-normal text-muted-foreground">{missing}</span>;
  return <span className={cn(signed && numericSign(value) === -1 && "text-danger-text")}>{formatCurrency(value)}</span>;
}

function Row({ label, value, missing, hint }: { label: string; value: string | null; missing?: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-dashed py-1.5 pl-3 text-sm last:border-b-0">
      <span className="text-muted-foreground">
        {label}
        {hint && <span className="ml-1 text-xs">({hint})</span>}
      </span>
      <span className="text-right font-medium tabular-nums">
        <Money value={value} missing={missing} signed />
      </span>
    </div>
  );
}

function Group({ title, rows, m }: { title: string; rows: Array<[string, FinancialMoneyColumn, string?]>; m: OrderFinancialDetail["money"] }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      {rows.map(([label, col, hint]) => (
        <Row key={col} label={label} value={m[col]} hint={hint} />
      ))}
    </div>
  );
}

/** Statement line: label left, amount right; `total` lines are emphasised. */
function StatementLine({ sign, label, children, total, className }: { sign?: "+" | "−" | "="; label: React.ReactNode; children: React.ReactNode; total?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1.5", total && "mt-1 border-t pt-2.5 text-base font-semibold", className)}>
      <span className="flex items-baseline gap-2">
        <span aria-hidden="true" className="w-3 text-center font-mono text-muted-foreground">
          {sign ?? ""}
        </span>
        {label}
      </span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}

/** Streams in after the order header (Suspense in the page). */
export async function OrderFinancialSectionAsync(props: { orderId: string; orderTotal: string | null; financialStatus: string; cogsReady: boolean }) {
  const detail = await getOrderFinancialDetail(props.orderId);
  return <OrderFinancialSection detail={detail} orderTotal={props.orderTotal} financialStatus={props.financialStatus} cogsReady={props.cogsReady} />;
}

export function OrderFinancialSection({
  detail,
  orderTotal,
  financialStatus,
  cogsReady,
}: {
  detail: OrderFinancialDetail | null;
  orderTotal: string | null;
  financialStatus: string;
  cogsReady: boolean;
}) {
  const m = detail?.money;
  const income = m?.actual_shopee_income ?? null;
  const cogs = m?.internal_cogs ?? null;
  const profit = m?.profit_after_cogs ?? null;
  const usedAfterAdjustment = m?.escrow_amount_after_adjustment !== null && m?.escrow_amount_after_adjustment !== undefined;
  const pTone = profitTone(numericSign(profit));

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Tài chính &amp; lợi nhuận</CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={toneOf(FINANCIAL_STATUS_TONE, financialStatus)}>{FINANCIAL_STATUS_LABELS[financialStatus] ?? financialStatus}</StatusBadge>
            {detail?.reconciliationStatus && <StatusBadge tone={toneOf(RECONCILIATION_TONE, detail.reconciliationStatus)}>{RECONCILIATION_LABELS[detail.reconciliationStatus]}</StatusBadge>}
          </div>
        </div>
        <CardDescription>Thu nhập lấy theo số escrow của Shopee; giá vốn là giá vốn nội bộ đã chốt khi bán.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Giá trị đơn (người mua trả)" icon={ReceiptText} value={<Money value={orderTotal} />} />
          <MetricCard label="Thu nhập Shopee" icon={Wallet} value={<Money value={income} />} hint={usedAfterAdjustment ? "sau điều chỉnh" : "escrow"} />
          <MetricCard label="Giá vốn nội bộ (COGS)" icon={Coins} value={<Money value={cogs} missing="Chưa tính" />} />
          <MetricCard label="Lợi nhuận sau giá vốn" icon={TrendingUp} value={<Money value={profit} missing="Chưa tính" />} tone={profit === null ? "neutral" : pTone} />
        </div>

        {!detail || income === null ? (
          <Callout tone="info" title="Chưa có dữ liệu thanh toán (escrow) từ Shopee cho đơn này.">
            {detail?.escrowLastErrorCode
              ? `Lần thử gần nhất ${formatDateTime(detail.escrowLastAttemptAt)}: ${detail.escrowLastErrorCode}. Hệ thống sẽ tự thử lại.`
              : "Thu nhập được đồng bộ tự động (mỗi 15 phút) cho đơn đã hoàn thành."}
          </Callout>
        ) : (
          <>
            <section aria-labelledby="fin-statement" className="rounded-lg border bg-muted/20 p-4 text-sm">
              <h4 id="fin-statement" className="mb-2 font-semibold">
                Từ thu nhập tới lợi nhuận
              </h4>
              <StatementLine sign="+" label={`Thu nhập Shopee ${usedAfterAdjustment ? "(sau điều chỉnh)" : "(escrow)"}`}>
                {formatCurrency(income)}
              </StatementLine>
              <StatementLine sign="−" label="Giá vốn nội bộ (COGS)">
                {cogs === null ? <span className="text-muted-foreground">chưa tính</span> : `-${formatDecimalString(cogs, " ₫")}`}
              </StatementLine>
              <StatementLine sign="=" label="Lợi nhuận sau giá vốn" total>
                <span className={profit === null ? "text-muted-foreground" : TONE_TEXT_CLASS[pTone]}>{profit === null ? "chưa tính" : formatCurrency(profit)}</span>
              </StatementLine>
              {cogs === null && !cogsReady && (
                <p className="mt-2 text-xs text-warning-text">Giá vốn chưa đủ (dòng chưa ghép SKU hoặc chưa có giá nhập) — không tính lợi nhuận từ giá vốn thiếu.</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                Lợi nhuận đóng góp (trừ quà tặng, đóng gói, quảng cáo, chi phí khác): chưa tính — các chi phí này chưa có dữ liệu, không coi là 0. Biên lợi nhuận: chưa tính
                (chưa chốt mẫu số).
              </p>
            </section>

            {detail.reconciliationStatus === "mismatch" && (
              <Callout tone="danger" title="Tổng các khoản không khớp với escrow Shopee.">
                Thu nhập vẫn lấy theo số escrow của Shopee; cần kiểm tra các khoản bên dưới.
              </Callout>
            )}

            <section aria-labelledby="fin-breakdown" className="space-y-3">
              <h4 id="fin-breakdown" className="text-sm font-semibold">
                Các khoản cấu thành thu nhập Shopee
              </h4>
              <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
                <Group
                  m={m!}
                  title="Doanh thu & giảm giá"
                  rows={[
                    ["Giá trị gốc sản phẩm", "gross_original_value"],
                    ["Người bán giảm giá", "seller_discount"],
                    ["Voucher người bán", "seller_voucher"],
                    ["Shopee giảm giá", "shopee_discount", "Shopee tài trợ"],
                    ["Voucher Shopee", "shopee_voucher", "Shopee tài trợ"],
                  ]}
                />
                <Group
                  m={m!}
                  title="Phí sàn"
                  rows={[
                    ["Phí cố định (commission)", "commission_fee"],
                    ["Phí dịch vụ", "service_fee"],
                    ["Phí thanh toán", "transaction_fee"],
                    ["Phí xử lý thẻ", "processing_fee"],
                    ["Phí chiến dịch", "campaign_fee"],
                    ["Phí tiếp thị liên kết", "affiliate_fee"],
                    ["Phí khác", "other_platform_fee"],
                  ]}
                />
                <Group
                  m={m!}
                  title="Vận chuyển"
                  rows={[
                    ["Phí ship người mua trả", "buyer_paid_shipping"],
                    ["Phí ship thực tế", "actual_shipping_fee"],
                    ["Shopee trợ giá ship", "shipping_rebate"],
                    ["Giảm giá ship (3PL)", "shipping_discount"],
                    ["Phí ship hoàn hàng", "reverse_shipping_fee"],
                  ]}
                />
                <Group
                  m={m!}
                  title="Thuế"
                  rows={[
                    ["Thuế GTGT khấu trừ", "withholding_vat_tax"],
                    ["Thuế TNCN khấu trừ", "withholding_pit_tax"],
                    ["Thuế TNDN khấu trừ", "withholding_cit_tax"],
                    ["Thuế escrow", "escrow_tax"],
                    ["Thuế khác", "other_tax"],
                  ]}
                />
                <Group
                  m={m!}
                  title="Hoàn tiền & điều chỉnh"
                  rows={[
                    ["Hoàn tiền cho người mua", "refund_amount", "không tự hoàn giá vốn"],
                    ["Shopee bồi thường", "seller_compensation_amount"],
                    ["Tổng điều chỉnh", "total_adjustment_amount"],
                  ]}
                />
                <div>
                  <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Đối soát</h4>
                  <Row label="Shopee escrow (thu nhập)" value={income} />
                  <Row label="Tính lại từ các khoản" value={m!.calculated_settlement} missing="Chưa tính (chưa có khoản đã kiểm chứng)" />
                  <Row label="Chênh lệch" value={m!.settlement_variance} missing="—" hint={m!.settlement_tolerance ? `dung sai ±${formatDecimalString(m!.settlement_tolerance)}` : undefined} />
                  {m!.unverified_component_amount !== null && <Row label="Khoản chưa kiểm chứng (không cộng vào)" value={m!.unverified_component_amount} />}
                </div>
              </div>
            </section>

            <details className="group rounded-lg border p-3 transition-colors open:bg-muted/10">
              <summary className="cursor-pointer rounded text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                Chi tiết từng khoản Shopee ({detail.components.length})
              </summary>
              <Table className="mt-2">
                <TableHeader>
                  <TableRow>
                    <TableHead>Trường Shopee</TableHead>
                    <TableHead>Nhóm</TableHead>
                    <TableHead className="text-right">Ảnh hưởng tới người bán</TableHead>
                    <TableHead>Trong công thức</TableHead>
                    <TableHead>Ghi chú</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.components.map((c) => (
                    <TableRow key={c.componentKey}>
                      <TableCell className="font-mono text-xs">
                        {c.providerField}
                        {c.componentKey.includes("#") ? ` ${c.componentKey.split("#")[1]?.split(":")[0] ?? ""}` : ""}
                      </TableCell>
                      <TableCell className="text-xs">{c.category}</TableCell>
                      <TableCell className="text-right text-xs">
                        <Money value={c.amount} signed />
                      </TableCell>
                      <TableCell className="text-xs">{c.includedInSettlement ? "có" : "không"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {c.metadata?.unknown ? "trường mới, chưa có trong từ điển" : c.metadata?.unverified ? "chưa kiểm chứng" : c.metadata?.impact === "info" ? "thông tin" : ""}
                        {typeof c.metadata?.reason === "string" ? ` ${c.metadata.reason}` : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-xs text-muted-foreground">
                Số dương = tiền về người bán, số âm = bị trừ. Đồng bộ lúc {formatDateTime(detail.escrowSyncedAt)} · {detail.calculationVersion}.
              </p>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}
