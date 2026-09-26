import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getOutstandingDetail } from "@/lib/outstanding/detail";
import { STATUS_BADGE_VARIANT, STATUS_LABELS } from "@/lib/outstanding/status";
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

const SHIFT_LABELS: Record<string, string> = {
  morning: "Ca sáng",
  afternoon: "Ca chiều",
};

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export default async function OutstandingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { row, contributingReceipts } = await getOutstandingDetail(id);

  if (!row) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" nativeButton={false} render={<Link href="/outstanding" />}>
          <ArrowLeft />
        </Button>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            {row.invoice_no} — {row.sku}
          </h2>
          <p className="text-muted-foreground">
            Đối chiếu hóa đơn với các phiếu nhập được tính vào số đã nhận.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Thông tin hóa đơn</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <InfoField label="Nhà cung cấp" value={`${row.supplier_code} — ${row.supplier_name}`} />
          <InfoField label="Ngày hóa đơn" value={formatDateVN(row.invoice_date)} />
          <InfoField label="Số hóa đơn" value={row.invoice_no} />
          <InfoField label="SKU" value={row.sku} />
          <InfoField label="Tên sản phẩm" value={row.product_name} />
          <InfoField label="Đơn vị" value={row.unit} />
          <InfoField label="Đơn giá" value={formatCurrency(row.unit_price)} />
          <InfoField label="SL hóa đơn" value={String(row.invoice_qty)} />
          <div className="space-y-0.5">
            <p className="text-muted-foreground">Trạng thái</p>
            <Badge variant={STATUS_BADGE_VARIANT[row.status]}>{STATUS_LABELS[row.status]}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Các phiếu nhập được tính vào số đã nhận</CardTitle>
        </CardHeader>
        <CardContent>
          {row.source_type === "from_receipts" && (
            <p className="mb-4 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              Hóa đơn tạo từ hàng đã nhận: chỉ tính các phiếu thuộc đúng những ngày hàng về đã liên kết
              với hóa đơn, cùng SKU và cùng đơn giá.
            </p>
          )}
          {contributingReceipts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {row.source_type === "from_receipts"
                ? "Không có phiếu nhập nào trong các ngày đã liên kết khớp SKU và đơn giá này."
                : "Chưa có phiếu nhập nào của NCC này (từ ngày hóa đơn trở đi) khớp SKU này."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ngày nhận</TableHead>
                  <TableHead>Số phiếu</TableHead>
                  <TableHead>Ca</TableHead>
                  <TableHead>SL nhận</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contributingReceipts.map((r) => (
                  <TableRow key={r.receipt_id}>
                    <TableCell>{formatDateVN(r.receipt_date)}</TableCell>
                    <TableCell>{r.receipt_no}</TableCell>
                    <TableCell>{SHIFT_LABELS[r.shift] ?? r.shift}</TableCell>
                    <TableCell className="text-emerald-600 dark:text-emerald-400">
                      +{r.received_qty}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tổng hợp</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          <InfoField label="Đã nhận" value={String(row.received_qty)} />
          <InfoField
            label="Còn lại"
            value={String(row.remaining_qty)}
            emphasis={row.remaining_qty < 0}
          />
          <InfoField label="Tiền hóa đơn" value={formatCurrency(row.invoice_value)} />
          <InfoField label="Tiền đã nhận" value={formatCurrency(row.received_value)} />
          <InfoField
            label="Tiền còn lại"
            value={formatCurrency(row.remaining_value)}
            emphasis={row.remaining_value < 0}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function InfoField({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground">{label}</p>
      <p className={emphasis ? "font-semibold text-destructive" : "font-medium"}>{value}</p>
    </div>
  );
}
