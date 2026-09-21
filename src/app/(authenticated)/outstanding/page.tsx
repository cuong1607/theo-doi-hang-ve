import Link from "next/link";
import { AlertTriangle, PackageSearch } from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";
import { getOutstandingList, type OutstandingStatus } from "@/lib/outstanding/list";
import { STATUS_BADGE_VARIANT, STATUS_LABELS } from "@/lib/outstanding/status";
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

import { OutstandingFilters } from "./outstanding-filters";

const PAGE_SIZE = 20;
const VALID_STATUSES: OutstandingStatus[] = ["need_makeup", "low", "normal"];

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function getAllSuppliers() {
  const supabase = createAdminClient();
  const { data } = await supabase.from("suppliers").select("id, code, name").order("code");
  return data ?? [];
}

// Dynamic route reads searchParams already, but explicit for the same
// reason as the other list pages — no other dynamic API is used, so
// Next.js would otherwise prerender once at build time.
export const dynamic = "force-dynamic";

export default async function OutstandingPage({
  searchParams,
}: {
  searchParams: Promise<{
    supplier?: string;
    invoiceDate?: string;
    sku?: string;
    status?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const supplierId = (params.supplier ?? "").trim();
  const invoiceDate = (params.invoiceDate ?? "").trim();
  const sku = (params.sku ?? "").trim();
  const statusParam = (params.status ?? "").trim();
  const status = VALID_STATUSES.includes(statusParam as OutstandingStatus)
    ? (statusParam as OutstandingStatus)
    : undefined;
  const page = Math.max(1, Number(params.page) || 1);

  const [suppliers, { rows, total, error }] = await Promise.all([
    getAllSuppliers(),
    getOutstandingList({ supplierId, invoiceDate, sku, status }, page, PAGE_SIZE),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilter = !!(supplierId || invoiceDate || sku || status);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Theo dõi hàng còn phải về</h2>
        <p className="text-muted-foreground">
          Đối chiếu hóa đơn với hàng đã nhận theo logic của bảng Excel hiện tại.
        </p>
      </div>

      <Card>
        <CardContent className="text-sm text-muted-foreground">
          Lưu ý: số &quot;Đã nhận&quot; cộng dồn mọi phiếu nhập cùng NCC + SKU có ngày nhận từ
          ngày hóa đơn trở đi. Nếu một NCC + SKU có nhiều hóa đơn với khoảng thời gian chồng lấn
          nhau, cùng một phiếu nhập có thể được tính vào &quot;Đã nhận&quot; của nhiều hóa đơn
          (double-count) — đây là hành vi giống hệt bảng Excel hiện tại, phase này chưa xây dựng
          engine phân bổ (allocation) để tách riêng từng phiếu về đúng 1 hóa đơn.
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-col items-start gap-4 space-y-0">
          <CardTitle>Bộ lọc</CardTitle>
          <OutstandingFilters
            supplierId={supplierId}
            invoiceDate={invoiceDate}
            sku={sku}
            status={status ?? ""}
            suppliers={suppliers}
          />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hàng còn phải về</CardTitle>
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
              <PackageSearch className="size-8 text-muted-foreground" />
              <p className="font-medium">
                {hasFilter ? "Không tìm thấy dữ liệu phù hợp." : "Chưa có hóa đơn nào."}
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>NCC</TableHead>
                      <TableHead>Ngày HĐ</TableHead>
                      <TableHead>Số HĐ</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Tên sản phẩm</TableHead>
                      <TableHead>SL hóa đơn</TableHead>
                      <TableHead>Đã nhận</TableHead>
                      <TableHead>Còn lại</TableHead>
                      <TableHead>Tiền hóa đơn</TableHead>
                      <TableHead>Tiền đã nhận</TableHead>
                      <TableHead>Tiền còn lại</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead className="text-right">Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.invoice_item_id}>
                        <TableCell className="font-medium">
                          {row.supplier_code} — {row.supplier_name}
                        </TableCell>
                        <TableCell>{formatDateVN(row.invoice_date)}</TableCell>
                        <TableCell>{row.invoice_no}</TableCell>
                        <TableCell>{row.sku}</TableCell>
                        <TableCell>{row.product_name}</TableCell>
                        <TableCell>{row.invoice_qty}</TableCell>
                        <TableCell>{row.received_qty}</TableCell>
                        <TableCell className={row.remaining_qty < 0 ? "text-destructive" : undefined}>
                          {row.remaining_qty}
                        </TableCell>
                        <TableCell>{formatCurrency(row.invoice_value)}</TableCell>
                        <TableCell>{formatCurrency(row.received_value)}</TableCell>
                        <TableCell className={row.remaining_value < 0 ? "text-destructive" : undefined}>
                          {formatCurrency(row.remaining_value)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_BADGE_VARIANT[row.status]}>
                            {STATUS_LABELS[row.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            nativeButton={false}
                            render={<Link href={`/outstanding/${row.invoice_item_id}`} />}
                          >
                            Xem
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ListPagination
                page={page}
                totalPages={totalPages}
                buildHref={(p) => {
                  const qp = new URLSearchParams();
                  if (supplierId) qp.set("supplier", supplierId);
                  if (invoiceDate) qp.set("invoiceDate", invoiceDate);
                  if (sku) qp.set("sku", sku);
                  if (status) qp.set("status", status);
                  if (p > 1) qp.set("page", String(p));
                  const qs = qp.toString();
                  return qs ? `/outstanding?${qs}` : "/outstanding";
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
