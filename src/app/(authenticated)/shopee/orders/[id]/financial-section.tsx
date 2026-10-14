// SHOPEE-5 order financial breakdown (server component, database only).
// NULL = "Chưa có" / "Chưa tính"; 0 = a confirmed "0 ₫" — never conflated.
import { AlertTriangle, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FinancialMoneyColumn, OrderFinancialDetail } from "@/lib/channels/core/financial-queries";

import { fmtDate, formatDecimal } from "../../shared";
import { FINANCIAL_STATUS_LABELS, RECONCILIATION_LABELS, RECONCILIATION_VARIANT } from "../labels";

function Money({ value, missing = "Chưa có", signed }: { value: string | null; missing?: string; signed?: boolean }) {
  if (value === null) return <span className="text-muted-foreground">{missing}</span>;
  const negative = value.startsWith("-");
  return <span className={signed && negative ? "text-destructive" : ""}>{formatDecimal(value, " ₫")}</span>;
}

function Row({ label, value, missing, hint }: { label: string; value: string | null; missing?: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5 text-sm last:border-b-0">
      <span className="text-muted-foreground">
        {label}
        {hint && <span className="ml-1 text-xs">({hint})</span>}
      </span>
      <span className="text-right font-medium tabular-nums">
        <Money value={value} missing={missing} />
      </span>
    </div>
  );
}

function Group({ title, rows, m }: { title: string; rows: Array<[string, FinancialMoneyColumn, string?]>; m: OrderFinancialDetail["money"] }) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold">{title}</h4>
      {rows.map(([label, col, hint]) => (
        <Row key={col} label={label} value={m[col]} hint={hint} />
      ))}
    </div>
  );
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

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>Tài chính & lợi nhuận</CardTitle>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline">{FINANCIAL_STATUS_LABELS[financialStatus] ?? financialStatus}</Badge>
          {detail?.reconciliationStatus && <Badge variant={RECONCILIATION_VARIANT[detail.reconciliationStatus]}>{RECONCILIATION_LABELS[detail.reconciliationStatus]}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Giá trị đơn Shopee (người mua trả)</dt>
            <dd className="text-lg font-semibold">
              <Money value={orderTotal} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Thu nhập Shopee (escrow)</dt>
            <dd className="text-lg font-semibold">
              <Money value={income} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Giá vốn nội bộ (COGS)</dt>
            <dd className="text-lg font-semibold">
              <Money value={cogs} missing="Chưa tính" />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Lợi nhuận sau giá vốn</dt>
            <dd className="text-lg font-semibold">
              <Money value={profit} missing="Chưa tính" signed />
            </dd>
          </div>
        </dl>

        {!detail || income === null ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            Chưa có dữ liệu thanh toán (escrow) từ Shopee cho đơn này.
            {detail?.escrowLastErrorCode
              ? ` Lần thử gần nhất ${fmtDate(detail.escrowLastAttemptAt)}: ${detail.escrowLastErrorCode}.`
              : " Dữ liệu được lấy qua \"Đồng bộ tài chính\" (chạy nền) cho đơn đã hoàn thành."}
          </p>
        ) : (
          <>
            {/* Chi tiết tính toán */}
            <div className="rounded-md border bg-muted/30 p-4 font-mono text-sm">
              <p className="mb-2 font-sans text-sm font-semibold">Chi tiết tính toán</p>
              <div className="flex justify-between">
                <span>Thu nhập Shopee {usedAfterAdjustment ? "(sau điều chỉnh)" : "(escrow)"}</span>
                <span>{formatDecimal(income, " ₫")}</span>
              </div>
              <div className="flex justify-between">
                <span>− Giá vốn nội bộ</span>
                <span>{cogs === null ? "chưa tính" : `-${formatDecimal(cogs, " ₫")}`}</span>
              </div>
              <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
                <span>= Lợi nhuận sau giá vốn</span>
                <span className={profit?.startsWith("-") ? "text-destructive" : ""}>{profit === null ? "chưa tính" : formatDecimal(profit, " ₫")}</span>
              </div>
              {cogs === null && (
                <p className="mt-2 font-sans text-xs text-muted-foreground">
                  {cogsReady ? "" : "Giá vốn chưa đủ (dòng chưa ghép SKU hoặc chưa có giá nhập) — không tính lợi nhuận từ giá vốn thiếu."}
                </p>
              )}
              <p className="mt-2 font-sans text-xs text-muted-foreground">
                Lợi nhuận đóng góp (trừ quà tặng, đóng gói, quảng cáo, chi phí khác): chưa tính — các chi phí này chưa có dữ liệu, không coi là 0. Biên lợi nhuận: chưa
                tính (chưa chốt mẫu số).
              </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
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
                <h4 className="mb-1 text-sm font-semibold">Đối soát</h4>
                <Row label="Shopee escrow (thu nhập)" value={income} />
                <Row label="Tính lại từ các khoản" value={m!.calculated_settlement} missing="Chưa tính (chưa có khoản đã kiểm chứng)" />
                <Row label="Chênh lệch" value={m!.settlement_variance} missing="—" hint={m!.settlement_tolerance ? `dung sai ±${formatDecimal(m!.settlement_tolerance)}` : undefined} />
                {m!.unverified_component_amount !== null && (
                  <Row label="Khoản chưa kiểm chứng (không cộng vào)" value={m!.unverified_component_amount} />
                )}
              </div>
            </div>

            {detail.reconciliationStatus === "mismatch" && (
              <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                Tổng các khoản không khớp với escrow Shopee. Thu nhập vẫn lấy theo số escrow của Shopee; cần kiểm tra các khoản bên dưới.
              </p>
            )}

            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">Chi tiết từng khoản Shopee ({detail.components.length})</summary>
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
                      <TableCell className="font-mono text-xs">{c.providerField}{c.componentKey.includes("#") ? ` ${c.componentKey.split("#")[1]?.split(":")[0] ?? ""}` : ""}</TableCell>
                      <TableCell className="text-xs">{c.category}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
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
                Số dương = tiền về người bán, số âm = bị trừ. Đồng bộ lúc {fmtDate(detail.escrowSyncedAt)} · {detail.calculationVersion}.
              </p>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}
