import Link from "next/link";
import { requirePermission } from "@/lib/auth/session";
import { notFound } from "next/navigation";

import { getDailyReceiptDetail, type DailyProductRow, type SourceReceipt } from "@/lib/receipts/daily";
import { formatCurrency } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { DailyProductTable, SummaryField, type DailyTableRow } from "./daily-product-table";

const SHIFT_LABELS: Record<string, string> = {
  morning: "Ca sáng",
  afternoon: "Ca chiều",
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatTimeVN(isoTimestamp: string) {
  return new Date(isoTimestamp).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toShiftRow(p: DailyProductRow, shift: "morning" | "afternoon"): DailyTableRow {
  return shift === "morning"
    ? {
        productId: p.product_id,
        sku: p.sku,
        name: p.product_name,
        unit: p.unit,
        delivered: p.morning_delivered_qty,
        received: p.morning_received_qty,
        difference: p.morning_difference_qty,
        lineTotal: p.morning_line_total,
        unitPrices: p.morning_unit_prices,
      }
    : {
        productId: p.product_id,
        sku: p.sku,
        name: p.product_name,
        unit: p.unit,
        delivered: p.afternoon_delivered_qty,
        received: p.afternoon_received_qty,
        difference: p.afternoon_difference_qty,
        lineTotal: p.afternoon_line_total,
        unitPrices: p.afternoon_unit_prices,
      };
}

function ReceiptList({ receipts }: { receipts: SourceReceipt[] }) {
  if (receipts.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground select-none">
        {receipts.length} phiếu nguồn
      </summary>
      <ul className="mt-2 space-y-1 pl-1">
        {receipts.map((r) => (
          <li key={r.receipt_id}>
            <Link href={`/receipts/${r.receipt_id}`} className="text-primary hover:underline">
              {r.receipt_no}
            </Link>{" "}
            — {r.receiver_name} — {formatTimeVN(r.created_at)}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default async function DailyReceiptDetailPage({
  params,
}: {
  params: Promise<{ date: string; supplierId: string }>;
}) {
  await requirePermission("receipt:view");
  const { date, supplierId } = await params;

  if (!DATE_PATTERN.test(date)) {
    notFound();
  }

  const { supplier, products, receipts, linkedInvoice } = await getDailyReceiptDetail(date, supplierId);

  if (!supplier) {
    notFound();
  }

  const morningRows = products.filter((p) => p.morning_item_count > 0).map((p) => toShiftRow(p, "morning"));
  const afternoonRows = products
    .filter((p) => p.afternoon_item_count > 0)
    .map((p) => toShiftRow(p, "afternoon"));
  const allDayRows: DailyTableRow[] = products.map((p) => ({
    productId: p.product_id,
    sku: p.sku,
    name: p.product_name,
    unit: p.unit,
    delivered: p.total_delivered_qty,
    received: p.total_received_qty,
    difference: p.total_difference_qty,
    lineTotal: p.total_line_total,
  }));

  const morningReceipts = receipts.filter((r) => r.shift === "morning");
  const afternoonReceipts = receipts.filter((r) => r.shift === "afternoon");

  const totalDelivered = allDayRows.reduce((sum, r) => sum + r.delivered, 0);
  const totalReceived = allDayRows.reduce((sum, r) => sum + r.received, 0);
  const totalDifference = allDayRows.reduce((sum, r) => sum + r.difference, 0);
  const totalAmount = allDayRows.reduce((sum, r) => sum + r.lineTotal, 0);
  const vatAmount = Math.round(totalAmount * 0.08 * 100) / 100;
  const grandTotal = Math.round(totalAmount * 1.08 * 100) / 100;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">
          Hàng về ngày {formatDateVN(date)}
        </h2>
        <p className="text-muted-foreground">
          {supplier.code} — {supplier.name}
        </p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <SummaryField label="Ngày" value={formatDateVN(date)} />
          <SummaryField label="Nhà cung cấp" value={`${supplier.code} — ${supplier.name}`} />
          <SummaryField label="Tổng số phiếu" value={String(receipts.length)} />
          <SummaryField
            label="Số phiếu sáng / chiều"
            value={`${morningReceipts.length} / ${afternoonReceipts.length}`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          {linkedInvoice ? (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <Badge variant="default">Đã lập hóa đơn</Badge>
                <span>
                  <span className="text-muted-foreground">Số HĐ: </span>
                  <span className="font-medium">{linkedInvoice.invoice_no}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">Ngày HĐ: </span>
                  <span className="font-medium">{formatDateVN(linkedInvoice.invoice_date)}</span>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href={`/invoices/${linkedInvoice.id}`} />}
              >
                Xem hóa đơn
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <Badge variant="outline">Chưa lập hóa đơn</Badge>
              <span className="text-muted-foreground">
                Có thể chọn ngày này ở Lịch sử hàng về để tạo hóa đơn từ hàng đã nhận.
              </span>
            </div>
          )}
        </CardContent>
      </Card>
      {linkedInvoice && (
        <p className="-mt-3 text-sm text-muted-foreground">
          Dữ liệu hàng về của ngày này đã khóa: không thể thêm, xóa, chuyển phiếu hoặc sửa số lượng/đơn
          giá vì hóa đơn {linkedInvoice.invoice_no} được lập từ đó.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Ca sáng</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <DailyProductTable
            title=""
            rows={morningRows}
            showUnitPrice
            emptyMessage="Không có hàng về ca sáng"
          />
          <ReceiptList receipts={morningReceipts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ca chiều</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <DailyProductTable
            title=""
            rows={afternoonRows}
            showUnitPrice
            emptyMessage="Không có hàng về ca chiều"
          />
          <ReceiptList receipts={afternoonReceipts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tổng cả ngày</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <DailyProductTable
            title=""
            rows={allDayRows}
            showUnitPrice={false}
            showSummary={false}
            emptyMessage="Không có hàng về trong ngày"
          />
          {allDayRows.length > 0 && (
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 border-t pt-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
              <SummaryField label="Tổng SL giao" value={String(totalDelivered)} />
              <SummaryField label="Tổng SL nhận" value={String(totalReceived)} />
              <SummaryField
                label="Tổng chênh lệch"
                value={String(totalDifference)}
                emphasis={totalDifference < 0}
              />
              <SummaryField label="Tổng tiền" value={formatCurrency(totalAmount)} />
              <SummaryField label="VAT 8%" value={formatCurrency(vatAmount)} />
              <SummaryField label="Tổng sau VAT" value={formatCurrency(grandTotal)} strong />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Phiếu nguồn</CardTitle>
        </CardHeader>
        <CardContent>
          {receipts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Chưa có phiếu nào trong ngày.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã phiếu</TableHead>
                  <TableHead>Ca</TableHead>
                  <TableHead>Người nhận</TableHead>
                  <TableHead>Thời gian tạo</TableHead>
                  <TableHead>Số SKU</TableHead>
                  <TableHead>Tổng tiền</TableHead>
                  <TableHead className="text-right">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipts.map((r) => (
                  <TableRow key={r.receipt_id}>
                    <TableCell className="font-medium">{r.receipt_no}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{SHIFT_LABELS[r.shift] ?? r.shift}</Badge>
                    </TableCell>
                    <TableCell>{r.receiver_name}</TableCell>
                    <TableCell>{formatTimeVN(r.created_at)}</TableCell>
                    <TableCell>{r.sku_count}</TableCell>
                    <TableCell>{formatCurrency(r.total_amount)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        nativeButton={false}
                        render={<Link href={`/receipts/${r.receipt_id}`} />}
                      >
                        Xem
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
