import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

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

type InvoiceDetail = {
  id: string;
  invoice_no: string;
  invoice_date: string;
  note: string | null;
  supplier_id: string;
  suppliers: { code: string; name: string } | null;
  invoice_items: {
    id: string;
    unit_price: number;
    quantity: number;
    line_total: number;
    products: { sku: string; name: string; unit: string } | null;
  }[];
};

async function getInvoice(id: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("invoices")
    .select(
      "id, invoice_no, invoice_date, note, supplier_id, suppliers(code, name), invoice_items(id, unit_price, quantity, line_total, products(sku, name, unit))"
    )
    .eq("id", id)
    .maybeSingle();
  return data as unknown as InvoiceDetail | null;
}

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const invoice = await getInvoice(id);

  if (!invoice) {
    notFound();
  }

  const totalQuantity = invoice.invoice_items.reduce((sum, i) => sum + i.quantity, 0);
  const totalAmount = invoice.invoice_items.reduce((sum, i) => sum + i.line_total, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" nativeButton={false} render={<Link href="/invoices" />}>
          <ArrowLeft />
        </Button>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{invoice.invoice_no}</h2>
          <p className="text-muted-foreground">Chi tiết hóa đơn nhà cung cấp.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Thông tin hóa đơn</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <InfoField label="Ngày hóa đơn" value={invoice.invoice_date} />
          <InfoField
            label="Nhà cung cấp"
            value={invoice.suppliers ? `${invoice.suppliers.code} — ${invoice.suppliers.name}` : "—"}
          />
          <InfoField label="Ghi chú" value={invoice.note || "—"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách hàng hóa</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Tên hàng</TableHead>
                <TableHead>Đơn vị</TableHead>
                <TableHead>Đơn giá</TableHead>
                <TableHead>SL hóa đơn</TableHead>
                <TableHead>Thành tiền</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.invoice_items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.products?.sku ?? "—"}</TableCell>
                  <TableCell>{item.products?.name ?? "—"}</TableCell>
                  <TableCell>{item.products?.unit ?? "—"}</TableCell>
                  <TableCell>{formatCurrency(item.unit_price)}</TableCell>
                  <TableCell>{item.quantity}</TableCell>
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
        <CardContent className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          <InfoField label="Tổng SL" value={String(totalQuantity)} />
          <InfoField label="Tổng tiền" value={formatCurrency(totalAmount)} strong />
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
