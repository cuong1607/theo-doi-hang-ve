import Link from "next/link";
import { requirePermission } from "@/lib/auth/session";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getPaymentDetail } from "@/lib/payments/detail";
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

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("payment:view");
  const { id } = await params;
  const { data: payment, error } = await getPaymentDetail(id);

  if (error || !payment) {
    notFound();
  }

  const items = [...payment.payment_items].sort((a, b) =>
    (a.invoices?.invoice_no ?? "").localeCompare(b.invoices?.invoice_no ?? "")
  );
  const invoiceList = items.map((i) => i.invoices?.invoice_no).filter(Boolean).join(", ");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" nativeButton={false} render={<Link href="/payments" />}>
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            {formatDateVN(payment.payment_date)} - Thanh toán HĐ {invoiceList}
          </h2>
          <p className="text-muted-foreground">
            {payment.suppliers?.code} — {payment.suppliers?.name}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách hóa đơn đã thanh toán</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Số HĐ</TableHead>
                  <TableHead>Ngày HĐ</TableHead>
                  <TableHead className="text-right">Số tiền</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      {item.invoices ? (
                        <Link href={`/invoices/${item.invoices.id}`} className="hover:underline">
                          {item.invoices.invoice_no}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>{item.invoices ? formatDateVN(item.invoices.invoice_date) : "—"}</TableCell>
                    <TableCell className="text-right">{formatCurrency(item.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mt-4 flex items-center justify-between rounded-md bg-muted px-3 py-2">
            <span className="font-medium">Tổng thanh toán</span>
            <span className="text-lg font-bold">{formatCurrency(payment.total_amount)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Thông tin thanh toán</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Ngày thanh toán</p>
            <p>{formatDateVN(payment.payment_date)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Nhà cung cấp</p>
            <p>
              {payment.suppliers?.code} — {payment.suppliers?.name}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Người tạo</p>
            <p>{payment.profiles?.full_name ?? "—"}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs font-medium text-muted-foreground">Ghi chú</p>
            <p>{payment.note || "—"}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
