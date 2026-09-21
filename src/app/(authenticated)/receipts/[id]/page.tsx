import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, Pencil } from "lucide-react";

import { canEditReceipts, getCurrentRole } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency } from "@/lib/format";
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

type ReceiptDetail = {
  id: string;
  receipt_no: string;
  receipt_date: string;
  shift: string;
  receiver_name: string;
  note: string | null;
  supplier_id: string;
  suppliers: { code: string; name: string } | null;
  receipt_items: {
    id: string;
    unit_price: number;
    delivered_qty: number;
    received_qty: number;
    difference_qty: number;
    line_total: number;
    products: { sku: string; name: string; unit: string } | null;
  }[];
};

async function getReceipt(id: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("receipts")
    .select(
      "id, receipt_no, receipt_date, shift, receiver_name, note, supplier_id, suppliers(code, name), receipt_items(id, unit_price, delivered_qty, received_qty, difference_qty, line_total, products(sku, name, unit))"
    )
    .eq("id", id)
    .maybeSingle();
  return data as unknown as ReceiptDetail | null;
}

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const receipt = await getReceipt(id);

  if (!receipt) {
    notFound();
  }

  const canEdit = canEditReceipts(getCurrentRole());

  const totalDelivered = receipt.receipt_items.reduce((sum, i) => sum + i.delivered_qty, 0);
  const totalReceived = receipt.receipt_items.reduce((sum, i) => sum + i.received_qty, 0);
  const totalDifference = receipt.receipt_items.reduce((sum, i) => sum + i.difference_qty, 0);
  const totalAmount = receipt.receipt_items.reduce((sum, i) => sum + i.line_total, 0);
  const vatAmount = Math.round(totalAmount * 0.08 * 100) / 100;
  const grandTotal = Math.round(totalAmount * 1.08 * 100) / 100;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon-sm"
            nativeButton={false}
            render={<Link href="/receipts" />}
          >
            <ArrowLeft />
          </Button>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">{receipt.receipt_no}</h2>
            <p className="text-muted-foreground">Chi tiết phiếu nhập hàng.</p>
          </div>
        </div>
        <div className="flex gap-2">
          {canEdit && (
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={`/receipts/${receipt.id}/edit`} />}
            >
              <Pencil className="mr-2 size-4" />
              Sửa phiếu
            </Button>
          )}
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href={`/receipts/daily/${receipt.receipt_date}/${receipt.supplier_id}`} />}
          >
            <CalendarDays className="mr-2 size-4" />
            Xem tổng hợp cả ngày
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Thông tin phiếu nhập</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <InfoField label="Ngày nhận" value={receipt.receipt_date} />
          <InfoField
            label="Nhà cung cấp"
            value={
              receipt.suppliers ? `${receipt.suppliers.code} — ${receipt.suppliers.name}` : "—"
            }
          />
          <InfoField label="Ca" value={SHIFT_LABELS[receipt.shift] ?? receipt.shift} />
          <InfoField label="Người nhận" value={receipt.receiver_name} />
          <InfoField label="Ghi chú" value={receipt.note || "—"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách hàng nhận</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Tên hàng</TableHead>
                <TableHead>Đơn vị</TableHead>
                <TableHead>Đơn giá</TableHead>
                <TableHead>SL giao</TableHead>
                <TableHead>SL nhận</TableHead>
                <TableHead>Chênh lệch</TableHead>
                <TableHead>Thành tiền</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipt.receipt_items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.products?.sku ?? "—"}</TableCell>
                  <TableCell>{item.products?.name ?? "—"}</TableCell>
                  <TableCell>{item.products?.unit ?? "—"}</TableCell>
                  <TableCell>{formatCurrency(item.unit_price)}</TableCell>
                  <TableCell>{item.delivered_qty}</TableCell>
                  <TableCell>{item.received_qty}</TableCell>
                  <TableCell className={item.difference_qty < 0 ? "text-destructive" : undefined}>
                    {item.difference_qty}
                  </TableCell>
                  <TableCell>{formatCurrency(item.line_total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tổng hợp</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <InfoField label="Tổng SL giao" value={String(totalDelivered)} />
          <InfoField label="Tổng SL nhận" value={String(totalReceived)} />
          <InfoField label="Tổng chênh lệch" value={String(totalDifference)} />
          <InfoField label="Tổng tiền" value={formatCurrency(totalAmount)} />
          <InfoField label="VAT 8%" value={formatCurrency(vatAmount)} />
          <InfoField label="Tổng sau VAT" value={formatCurrency(grandTotal)} strong />
        </CardContent>
      </Card>
    </div>
  );
}

function InfoField({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground">{label}</p>
      <p className={strong ? "text-base font-semibold" : "font-medium"}>{value}</p>
    </div>
  );
}
