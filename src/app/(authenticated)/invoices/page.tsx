import Link from "next/link";
import { AlertTriangle, FileSearch, Plus } from "lucide-react";

import { canCreateInvoices, getCurrentRole } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getInvoiceList } from "@/lib/invoices/list";
import { INVOICE_SOURCE_LABELS } from "@/lib/invoices/receipt-days";
import { formatCurrency } from "@/lib/format";
import { ListPagination } from "@/components/list-pagination";
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

import { InvoiceFilters } from "./invoice-filters";

const PAGE_SIZE = 10;

const SUPPLIER_TYPE_LABELS: Record<string, string> = {
  business_household: "Hộ kinh doanh",
  company: "Công ty",
};

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function getAllSuppliers() {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("suppliers")
    .select("id, code, name, supplier_type")
    .order("code");
  return data ?? [];
}

// Dynamic route reads searchParams already, but this is explicit for the
// same reason as /receipts: no other dynamic API is used to trigger fresh
// per-request rendering implicitly.
export const dynamic = "force-dynamic";

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    supplier?: string;
    invoiceNo?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const fromDate = (params.from ?? "").trim();
  const toDate = (params.to ?? "").trim();
  const supplierId = (params.supplier ?? "").trim();
  const invoiceNo = (params.invoiceNo ?? "").trim();
  const page = Math.max(1, Number(params.page) || 1);

  const [suppliers, { rows, total, error }] = await Promise.all([
    getAllSuppliers(),
    getInvoiceList({ fromDate, toDate, supplierId, invoiceNo }, page, PAGE_SIZE),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilter = !!(fromDate || toDate || supplierId || invoiceNo);
  const canCreate = canCreateInvoices(getCurrentRole());
  const supplierTypeById = new Map(suppliers.map((s) => [s.id, s.supplier_type]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Danh sách hóa đơn</h2>
          <p className="text-muted-foreground">Quản lý hóa đơn nhập hàng từ nhà cung cấp.</p>
        </div>
        {canCreate && (
          <Button nativeButton={false} render={<Link href="/invoices/new" />}>
            <Plus className="mr-2 size-4" />
            Tạo hóa đơn
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="flex-col items-start gap-4 space-y-0">
          <CardTitle>Bộ lọc</CardTitle>
          <InvoiceFilters
            fromDate={fromDate}
            toDate={toDate}
            supplierId={supplierId}
            invoiceNo={invoiceNo}
            suppliers={suppliers}
          />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hóa đơn</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <AlertTriangle className="size-8 text-destructive" />
              <p className="font-medium">Đã xảy ra lỗi khi tải dữ liệu.</p>
              <p className="text-sm text-muted-foreground">Vui lòng tải lại trang để thử lại.</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <FileSearch className="size-8 text-muted-foreground" />
              <p className="font-medium">
                {hasFilter ? "Không tìm thấy dữ liệu phù hợp." : "Chưa có hóa đơn nào."}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mã hóa đơn</TableHead>
                    <TableHead>Ngày hóa đơn</TableHead>
                    <TableHead>NCC</TableHead>
                    <TableHead>Loại NCC</TableHead>
                    <TableHead>Nguồn</TableHead>
                    <TableHead>Số SKU</TableHead>
                    <TableHead>Tổng SL</TableHead>
                    <TableHead>Tổng phải trả</TableHead>
                    <TableHead className="text-right">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.invoice_no}</TableCell>
                      <TableCell>{formatDateVN(row.invoice_date)}</TableCell>
                      <TableCell>
                        {row.supplier_code} — {row.supplier_name}
                      </TableCell>
                      <TableCell>
                        {SUPPLIER_TYPE_LABELS[supplierTypeById.get(row.supplier_id) ?? ""] ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.source_type === "from_receipts" ? "secondary" : "outline"}>
                          {INVOICE_SOURCE_LABELS[row.source_type]}
                        </Badge>
                      </TableCell>
                      <TableCell>{row.sku_count}</TableCell>
                      <TableCell>{row.total_quantity}</TableCell>
                      <TableCell>{formatCurrency(row.total_amount)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          nativeButton={false}
                          render={<Link href={`/invoices/${row.id}`} />}
                        >
                          Xem
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ListPagination
                page={page}
                totalPages={totalPages}
                buildHref={(p) => {
                  const qp = new URLSearchParams();
                  if (fromDate) qp.set("from", fromDate);
                  if (toDate) qp.set("to", toDate);
                  if (supplierId) qp.set("supplier", supplierId);
                  if (invoiceNo) qp.set("invoiceNo", invoiceNo);
                  if (p > 1) qp.set("page", String(p));
                  const qs = qp.toString();
                  return qs ? `/invoices?${qs}` : "/invoices";
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
