import Link from "next/link";
import { requirePermission } from "@/lib/auth/session";
import { AlertTriangle, Wallet } from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";
import { getPaymentList } from "@/lib/payments/list";
import { formatCurrency } from "@/lib/format";
import { ListPagination } from "@/components/list-pagination";
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

import { PaymentFilters } from "./payment-filters";

const PAGE_SIZE = 20;

function formatDateVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function getAllSuppliers() {
  const supabase = createAdminClient();
  const { data } = await supabase.from("suppliers").select("id, code, name").order("code");
  return data ?? [];
}

// Dynamic route reads searchParams already — no other dynamic API is used,
// so Next.js would otherwise prerender once at build time.
export const dynamic = "force-dynamic";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    supplier?: string;
    q?: string;
    page?: string;
  }>;
}) {
  await requirePermission("payment:view");
  const params = await searchParams;
  const fromDate = (params.from ?? "").trim();
  const toDate = (params.to ?? "").trim();
  const supplierId = (params.supplier ?? "").trim();
  const search = (params.q ?? "").trim();
  const page = Math.max(1, Number(params.page) || 1);

  const [suppliers, { rows, total, error }] = await Promise.all([
    getAllSuppliers(),
    getPaymentList({ fromDate, toDate, supplierId, search }, page, PAGE_SIZE),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilter = !!(fromDate || toDate || supplierId || search);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Lịch sử thanh toán</h2>
        <p className="text-muted-foreground">Bộ lọc ngày tính theo ngày thanh toán.</p>
      </div>

      <Card>
        <CardHeader className="flex-col items-start gap-4 space-y-0">
          <CardTitle>Bộ lọc</CardTitle>
          <PaymentFilters fromDate={fromDate} toDate={toDate} supplierId={supplierId} search={search} suppliers={suppliers} />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách thanh toán</CardTitle>
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
              <Wallet className="size-8 text-muted-foreground" />
              <p className="font-medium">
                {hasFilter ? "Không tìm thấy dữ liệu phù hợp." : "Chưa có thanh toán nào."}
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ngày thanh toán</TableHead>
                      <TableHead>NCC</TableHead>
                      <TableHead>Số hóa đơn</TableHead>
                      <TableHead>Tổng tiền</TableHead>
                      <TableHead>Người tạo</TableHead>
                      <TableHead className="text-right">Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{formatDateVN(p.payment_date)}</TableCell>
                        <TableCell>
                          {p.supplier_code} — {p.supplier_name}
                        </TableCell>
                        <TableCell className="max-w-xs truncate" title={p.invoice_numbers ?? undefined}>
                          {p.invoice_numbers ?? "—"}
                        </TableCell>
                        <TableCell>{formatCurrency(p.total_amount)}</TableCell>
                        <TableCell>{p.created_by_name ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            nativeButton={false}
                            render={<Link href={`/payments/${p.id}`} />}
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
                  if (fromDate) qp.set("from", fromDate);
                  if (toDate) qp.set("to", toDate);
                  if (supplierId) qp.set("supplier", supplierId);
                  if (search) qp.set("q", search);
                  if (p > 1) qp.set("page", String(p));
                  const qs = qp.toString();
                  return qs ? `/payments?${qs}` : "/payments";
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
