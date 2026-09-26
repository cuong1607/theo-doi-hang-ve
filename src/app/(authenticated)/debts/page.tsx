import Link from "next/link";
import { requirePermission } from "@/lib/auth/session";
import { AlertTriangle, FileClock, Receipt, Wallet } from "lucide-react";

import { canCreatePayments } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDebtOverview } from "@/lib/debt/overview";
import { getInvoiceDebtList, type PaymentStatus } from "@/lib/debt/invoice-debt";
import { getSupplierDebtSummaryFiltered } from "@/lib/debt/supplier-debt";
import { formatCurrency } from "@/lib/format";
import { ListPagination } from "@/components/list-pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { DebtFilters } from "./debt-filters";
import { DebtInvoiceSelection } from "./debt-invoice-selection";

const PAGE_SIZE = 20;
const VALID_STATUSES: PaymentStatus[] = ["unpaid", "partial", "paid"];
const SUPPLIER_TYPE_LABELS: Record<string, string> = {
  business_household: "Hộ kinh doanh",
  company: "Công ty",
};
// No real lower bound on the workbook's data — "hiển thị tất cả" by default
// unless the user narrows the range, per CN2's plain Từ ngày/Đến ngày filter
// (no preset buttons, unlike the dashboard).
const DEFAULT_FROM_DATE = "2000-01-01";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function getAllSuppliers() {
  const supabase = createAdminClient();
  const { data } = await supabase.from("suppliers").select("id, code, name").order("code");
  return data ?? [];
}

// Dynamic route: the default "Đến ngày" is real today, and totals must
// always reflect the live database — no other dynamic API is used, so
// Next.js would otherwise prerender once at build time.
export const dynamic = "force-dynamic";

export default async function DebtsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    supplier?: string;
    status?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const auth = await requirePermission("debt:view");
  const params = await searchParams;
  const fromDate = (params.from ?? "").trim() || DEFAULT_FROM_DATE;
  const toDate = (params.to ?? "").trim() || todayISO();
  const supplierId = (params.supplier ?? "").trim();
  const statusParam = (params.status ?? "").trim();
  const paymentStatus = VALID_STATUSES.includes(statusParam as PaymentStatus)
    ? (statusParam as PaymentStatus)
    : undefined;
  const search = (params.q ?? "").trim();
  const page = Math.max(1, Number(params.page) || 1);

  const filters = { fromDate, toDate, supplierId: supplierId || undefined, paymentStatus, search };
  const canPay = canCreatePayments(auth.profile.role);

  const [
    suppliers,
    { data: overview, error: overviewError },
    { rows: supplierRows, error: supplierError },
    { rows: invoiceRows, total, error: invoiceError },
  ] = await Promise.all([
    getAllSuppliers(),
    getDebtOverview(filters),
    getSupplierDebtSummaryFiltered(filters),
    getInvoiceDebtList(
      { supplierId: filters.supplierId, paymentStatus, fromDate, toDate, search },
      page,
      PAGE_SIZE
    ),
  ]);

  const hasError = overviewError || supplierError || invoiceError;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function buildHref(qp: URLSearchParams) {
    const qs = qp.toString();
    return qs ? `/debts?${qs}` : "/debts";
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Công nợ nhà cung cấp</h2>
        <p className="text-muted-foreground">
          Đối chiếu hóa đơn với các khoản đã thanh toán. Bộ lọc ngày tính theo ngày hóa đơn.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-col items-start gap-4 space-y-0">
          <CardTitle>Bộ lọc</CardTitle>
          <DebtFilters
            fromDate={fromDate === DEFAULT_FROM_DATE ? "" : fromDate}
            toDate={params.to ?? ""}
            supplierId={supplierId}
            status={paymentStatus ?? ""}
            search={search}
            suppliers={suppliers}
          />
        </CardHeader>
      </Card>

      {hasError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <AlertTriangle className="size-8 text-destructive" />
            <p className="font-medium">Đã xảy ra lỗi khi tải dữ liệu công nợ.</p>
            <p className="text-sm text-muted-foreground">Vui lòng tải lại trang để thử lại.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Phần 2 — Tổng quan. Ưu tiên Tổng phải trả / Đã thanh toán / Còn nợ;
              chiết khấu + VAT chỉ là thông tin phụ để giải thích vì sao "Tổng
              phải trả" khác "Tạm tính", nên xuống một dòng phụ nhỏ hơn. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Tổng phải trả"
              value={formatCurrency(overview?.total_final_amount ?? 0)}
              icon={Receipt}
            />
            <StatCard
              title="Đã thanh toán"
              value={formatCurrency(overview?.total_paid_amount ?? 0)}
              icon={Wallet}
            />
            <StatCard
              title="Còn nợ"
              value={formatCurrency(overview?.total_remaining_amount ?? 0)}
              icon={Wallet}
              emphasis={(overview?.total_remaining_amount ?? 0) > 0}
            />
            <StatCard
              title="Số hóa đơn còn nợ"
              value={String(overview?.open_invoice_count ?? 0)}
              icon={FileClock}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <SubStatCard title="Tổng giá trị trước điều chỉnh" value={formatCurrency(overview?.total_subtotal_amount ?? 0)} />
            <SubStatCard title="Tổng chiết khấu" value={formatCurrency(overview?.total_discount_amount ?? 0)} />
            <SubStatCard title="Tổng VAT" value={formatCurrency(overview?.total_vat_amount ?? 0)} />
          </div>

          {/* Phần 3 — Tổng hợp theo nhà cung cấp */}
          <Card>
            <CardHeader>
              <CardTitle>Tổng hợp theo nhà cung cấp</CardTitle>
            </CardHeader>
            <CardContent>
              {supplierRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Chưa có nhà cung cấp nào.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>NCC</TableHead>
                        <TableHead>Loại NCC</TableHead>
                        <TableHead>Tạm tính</TableHead>
                        <TableHead>Chiết khấu</TableHead>
                        <TableHead>VAT</TableHead>
                        <TableHead>Tổng phải trả</TableHead>
                        <TableHead>Đã thanh toán</TableHead>
                        <TableHead>Còn nợ</TableHead>
                        <TableHead>Số HĐ còn nợ</TableHead>
                        <TableHead className="text-right">Thao tác</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {supplierRows.map((s) => {
                        const qp = new URLSearchParams();
                        qp.set("supplier", s.supplier_id);
                        if (params.from) qp.set("from", params.from);
                        if (params.to) qp.set("to", params.to);
                        if (paymentStatus) qp.set("status", paymentStatus);
                        if (search) qp.set("q", search);
                        return (
                          <TableRow key={s.supplier_id} data-state={supplierId === s.supplier_id ? "selected" : undefined}>
                            <TableCell className="font-medium">
                              {s.supplier_code} — {s.supplier_name}
                            </TableCell>
                            <TableCell>{SUPPLIER_TYPE_LABELS[s.supplier_type] ?? s.supplier_type}</TableCell>
                            <TableCell>{formatCurrency(s.supplier_subtotal_total)}</TableCell>
                            <TableCell>{formatCurrency(s.supplier_discount_total)}</TableCell>
                            <TableCell>{formatCurrency(s.supplier_vat_total)}</TableCell>
                            <TableCell className="font-medium">{formatCurrency(s.supplier_final_total)}</TableCell>
                            <TableCell>{formatCurrency(s.supplier_paid_total)}</TableCell>
                            <TableCell className={s.supplier_remaining_total > 0 ? "font-medium text-destructive" : undefined}>
                              {formatCurrency(s.supplier_remaining_total)}
                            </TableCell>
                            <TableCell>{s.supplier_open_invoice_count}</TableCell>
                            <TableCell className="text-right">
                              <Link href={buildHref(qp)} className="text-sm text-primary hover:underline">
                                Xem hóa đơn
                              </Link>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Phần 4 — Chi tiết hóa đơn công nợ */}
          <Card>
            <CardHeader>
              <CardTitle>Chi tiết hóa đơn công nợ</CardTitle>
            </CardHeader>
            <CardContent>
              <DebtInvoiceSelection rows={invoiceRows} canPay={canPay} />
              {invoiceRows.length > 0 && (
                <ListPagination
                  page={page}
                  totalPages={totalPages}
                  buildHref={(p) => {
                    const qp = new URLSearchParams();
                    if (params.from) qp.set("from", params.from);
                    if (params.to) qp.set("to", params.to);
                    if (supplierId) qp.set("supplier", supplierId);
                    if (paymentStatus) qp.set("status", paymentStatus);
                    if (search) qp.set("q", search);
                    if (p > 1) qp.set("page", String(p));
                    return buildHref(qp);
                  }}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatCard({
  title,
  value,
  icon: Icon,
  emphasis,
}: {
  title: string;
  value: string;
  icon: typeof Wallet;
  emphasis?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className={emphasis ? "text-2xl font-bold text-destructive" : "text-2xl font-bold"}>{value}</div>
      </CardContent>
    </Card>
  );
}

function SubStatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-normal text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-lg font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
