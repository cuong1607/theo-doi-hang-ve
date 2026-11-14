import Link from "next/link";
import { ArrowLeft, CheckCircle2, Coins, History, ReceiptText } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { CostEngine } from "@/lib/inventory-cost/engine";
import { COSTING_VERSION } from "@/lib/inventory-cost/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency, formatDateTime, formatQuantity, formatSignedCurrency, numericSign } from "@/lib/ui/format";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { MetricCard, MetricGrid } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { RestateCogsButton } from "./restate-button";
import { getShopeeFlags } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

const PREVIEW_LIMIT = 500;

/**
 * Historical COGS restatement (dry-run + explicit apply). Read-only until the
 * admin confirms; amounts are computed in SQL (NUMERIC) and shown as-is.
 */
export default async function CogsRestatementPage() {
  const legacyShopee = getShopeeFlags().legacyModulesEnabled;
  await requirePermission("cost:manage");
  const engine = new CostEngine({ db: createAdminClient(), logger: () => {} });
  const [summary, candidates] = await Promise.all([engine.restatementSummary(), engine.restatementCandidates(PREVIEW_LIMIT)]);
  const restatable = candidates.filter((c) => c.restatable);
  const diffSign = numericSign(summary.difference);

  return (
    <PageContainer>
      <Link href="/inventory/costs" className="inline-flex items-center gap-1 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
        <ArrowLeft className="size-4" /> Giá vốn sản phẩm
      </Link>
      <PageHeader
        title="Điều chỉnh COGS đơn lịch sử"
        description="Xem trước chênh lệch giữa COGS đã chốt của đơn cũ và sổ giá vốn hiện tại (sau khi dựng lại). Không có gì thay đổi cho tới khi bấm điều chỉnh."
        actions={
          restatable.length > 0 ? (
            <RestateCogsButton itemIds={restatable.map((c) => c.orderItemId)} lines={restatable.length} orders={new Set(restatable.map((c) => c.orderId)).size} difference={summary.restatableLines === restatable.length ? formatSignedCurrency(summary.difference) : "xem bảng"} />
          ) : undefined
        }
      />

      <Callout tone="info">
        Bước 1: &quot;Dựng lại sổ giá vốn&quot; (tính lại giá vốn hiện tại, gồm VAT hóa đơn NCC công ty). Bước 2: xem chênh lệch dưới đây. Bước 3: chỉ khi đồng ý mới bấm điều
        chỉnh — mỗi dòng lưu giá trị cũ / mới, lý do, người thực hiện, phiên bản {COSTING_VERSION}. Dòng đã hoàn kho (đơn huỷ) không điều chỉnh.
      </Callout>

      <MetricGrid>
        <MetricCard label="Dòng chênh lệch" icon={ReceiptText} value={summary.affectedLines.toLocaleString("vi-VN")} hint={`${summary.affectedOrders} đơn`} />
        <MetricCard label="Điều chỉnh được" icon={CheckCircle2} value={summary.restatableLines.toLocaleString("vi-VN")} hint="đã biết giá vốn mới" />
        <MetricCard
          label="Chưa xác định"
          icon={History}
          value={summary.pendingLines.toLocaleString("vi-VN")}
          tone={summary.pendingLines > 0 ? "warning" : "neutral"}
          hint="giá vốn mới đang chờ hóa đơn VAT"
        />
        <MetricCard label="COGS cũ → mới" icon={Coins} value={formatCurrency(summary.newTotalCogs)} hint={`cũ ${formatCurrency(summary.oldTotalCogs)}`} />
        <MetricCard label="Chênh lệch" icon={Coins} value={formatSignedCurrency(summary.difference)} tone={diffSign === 0 ? "neutral" : "warning"} hint="chỉ dòng điều chỉnh được" />
      </MetricGrid>

      <Card>
        <CardHeader>
          <CardTitle>
            Các dòng chênh lệch ({candidates.length.toLocaleString("vi-VN")}
            {summary.affectedLines > candidates.length ? ` / ${summary.affectedLines.toLocaleString("vi-VN")}` : ""})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {candidates.length === 0 ? (
            <EmptyState icon={CheckCircle2} title="Không có chênh lệch." description="COGS đã chốt của mọi đơn khớp với sổ giá vốn hiện tại." />
          ) : (
            <Table stickyHeader>
              <TableHeader>
                <TableRow>
                  <TableHead>Ngày đơn</TableHead>
                  <TableHead>Mã đơn</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">SL</TableHead>
                  <TableHead className="text-right">Giá vốn/đv cũ</TableHead>
                  <TableHead className="text-right">Giá vốn/đv mới</TableHead>
                  <TableHead className="text-right">COGS cũ</TableHead>
                  <TableHead className="text-right">COGS mới</TableHead>
                  <TableHead className="text-right">Chênh lệch</TableHead>
                  <TableHead>Phiên bản cũ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c) => (
                  <TableRow key={c.orderItemId}>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(c.createdAtChannel)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {legacyShopee ? (
                        <Link href={`/shopee/orders/${c.orderId}`} className="rounded text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                          {c.externalOrderSn}
                        </Link>
                      ) : (
                        c.externalOrderSn
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs" title={c.productName ?? ""}>
                      {c.sku ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">{formatQuantity(c.quantity)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(c.oldCostPerUnit)}</TableCell>
                    <TableCell className="text-right">{c.newCostPerUnit === null ? <StatusBadge tone="warning">Chờ VAT</StatusBadge> : formatCurrency(c.newCostPerUnit)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(c.oldTotalCogs)}</TableCell>
                    <TableCell className="text-right">{c.newTotalCogs === null ? "—" : formatCurrency(c.newTotalCogs)}</TableCell>
                    <TableCell className="text-right font-medium">{c.difference === null ? "—" : formatSignedCurrency(c.difference)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.oldCostVersion ?? "moving-average-v1"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {summary.affectedLines > candidates.length && (
            <p className="pt-3 text-xs text-muted-foreground">
              Hiển thị {candidates.length} dòng mới nhất; nút điều chỉnh chỉ áp dụng cho các dòng đang hiển thị. Sau khi điều chỉnh, tải lại trang để xem phần còn lại.
            </p>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
