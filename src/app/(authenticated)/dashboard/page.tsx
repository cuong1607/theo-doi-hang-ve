import type { ComponentType } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarDays,
  FileClock,
  FileText,
  PackageCheck,
  PackageX,
  Wallet,
} from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency } from "@/lib/format";
import { isRangePreset, resolveDateRange, type RangePreset } from "@/lib/dashboard/date-range";
import {
  getDashboardDailySeries,
  getDashboardFinancialSummary,
  getDashboardFinancialSupplierBreakdown,
  getDashboardFinancialTypeBreakdown,
  getDashboardOutstandingSummary,
  getDashboardSummary,
  getDashboardSupplierTotals,
  getRecentDailySummaries,
  getRecentReceipts,
  getTopOutstanding,
} from "@/lib/dashboard/queries";
import type { SupplierType } from "@/lib/debt/invoice-debt";
import { STATUS_BADGE_VARIANT, STATUS_LABELS } from "@/lib/outstanding/status";
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

import { DashboardFilters } from "./dashboard-filters";

const SHIFT_LABELS: Record<string, string> = {
  morning: "Ca sáng",
  afternoon: "Ca chiều",
};

const SUPPLIER_TYPE_LABELS: Record<string, string> = {
  business_household: "Hộ kinh doanh",
  company: "Công ty",
};

const VALID_SUPPLIER_TYPES: SupplierType[] = ["business_household", "company"];

const TOP_OUTSTANDING_LIMIT = 5;
const RECENT_LIMIT = 8;

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
// reason as the other pages in this app — no other dynamic API is used, so
// Next.js would otherwise prerender once at build time and freeze "today".
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    supplier?: string;
    supplierType?: string;
  }>;
}) {
  const params = await searchParams;
  const range: RangePreset = isRangePreset(params.range ?? "") ? (params.range as RangePreset) : "today";
  const supplierId = (params.supplier ?? "").trim();
  const supplierTypeParam = (params.supplierType ?? "").trim();
  const supplierType = VALID_SUPPLIER_TYPES.includes(supplierTypeParam as SupplierType)
    ? (supplierTypeParam as SupplierType)
    : undefined;
  const { from: fromDate, to: toDate } = resolveDateRange(range, params.from, params.to);
  const filters = { fromDate, toDate, supplierId: supplierId || undefined };
  const financialFilters = { ...filters, supplierType };

  const [
    suppliers,
    { data: summary, error: summaryError },
    { data: outstandingSummary, error: outstandingSummaryError },
    { data: dailySeries, error: dailySeriesError },
    { data: supplierTotals, error: supplierTotalsError },
    { data: topLow, error: topLowError },
    { data: topNeedMakeup, error: topNeedMakeupError },
    { data: recentDailySummaries, error: recentDailyError },
    { data: recentReceipts, error: recentReceiptsError },
    { data: financialSummary, error: financialSummaryError },
    { data: financialSupplierRows, error: financialSupplierError },
    { data: financialTypeRows, error: financialTypeError },
  ] = await Promise.all([
    getAllSuppliers(),
    getDashboardSummary(filters),
    getDashboardOutstandingSummary(filters),
    getDashboardDailySeries(filters),
    getDashboardSupplierTotals(filters),
    getTopOutstanding(filters, "low", TOP_OUTSTANDING_LIMIT),
    getTopOutstanding(filters, "need_makeup", TOP_OUTSTANDING_LIMIT),
    getRecentDailySummaries(filters, RECENT_LIMIT),
    getRecentReceipts(filters, RECENT_LIMIT),
    getDashboardFinancialSummary(financialFilters),
    getDashboardFinancialSupplierBreakdown(financialFilters),
    getDashboardFinancialTypeBreakdown(financialFilters),
  ]);

  const hasError =
    summaryError ||
    outstandingSummaryError ||
    dailySeriesError ||
    supplierTotalsError ||
    topLowError ||
    topNeedMakeupError ||
    recentDailyError ||
    recentReceiptsError ||
    financialSummaryError ||
    financialSupplierError ||
    financialTypeError;

  if (hasError) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Tổng quan</h2>
          <p className="text-muted-foreground">Thống kê hoạt động nhập hàng và hóa đơn.</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <AlertTriangle className="size-8 text-destructive" />
            <p className="font-medium">Đã xảy ra lỗi khi tải dữ liệu tổng quan.</p>
            <p className="text-sm text-muted-foreground">Vui lòng tải lại trang để thử lại.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const maxDailyAmount = Math.max(1, ...(dailySeries ?? []).map((d) => d.total_amount));
  const maxSupplierAmount = Math.max(1, ...(supplierTotals ?? []).map((s) => s.total_amount));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Tổng quan</h2>
        <p className="text-muted-foreground">Thống kê hoạt động nhập hàng và hóa đơn.</p>
      </div>

      <Card>
        <CardHeader className="flex-col items-start gap-4 space-y-0">
          <CardTitle>Bộ lọc</CardTitle>
          <DashboardFilters
            range={range}
            customFrom={params.from ?? ""}
            customTo={params.to ?? ""}
            supplierId={supplierId}
            supplierType={supplierType ?? ""}
            suppliers={suppliers}
          />
        </CardHeader>
      </Card>

      {/* Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Số lượt tổng hợp hàng về"
          description="Số cặp (ngày, NCC) có hàng về — khác với số phiếu nhập thực tế bên dưới"
          value={String(summary?.daily_group_count ?? 0)}
          icon={CalendarDays}
        />
        <StatCard
          title="Số phiếu nhập"
          description="Số phiếu nhập (receipt) thực tế đã ghi nhận"
          value={String(summary?.receipt_count ?? 0)}
          icon={FileText}
        />
        <StatCard
          title="Tổng SL giao"
          description="Tổng SL giao theo phiếu nhập"
          value={String(summary?.total_delivered_qty ?? 0)}
          icon={PackageCheck}
        />
        <StatCard
          title="Tổng SL nhận"
          description="Tổng SL nhận theo phiếu nhập"
          value={String(summary?.total_received_qty ?? 0)}
          icon={PackageCheck}
        />
        <StatCard
          title="Tổng chênh lệch"
          description="SL nhận trừ SL giao"
          value={String(summary?.total_difference_qty ?? 0)}
          icon={ArrowLeftRight}
          emphasis={(summary?.total_difference_qty ?? 0) < 0}
        />
        <StatCard
          title="Tổng giá trị hàng nhận"
          description="Tổng thành tiền các phiếu nhập trong khoảng lọc"
          value={formatCurrency(summary?.total_amount ?? 0)}
          icon={Wallet}
        />
        <StatCard
          title="Hóa đơn đang theo dõi"
          description="Hóa đơn (theo ngày HĐ trong khoảng lọc) chưa nhận đủ hoặc nhận vượt"
          value={String(outstandingSummary?.watching_invoice_count ?? 0)}
          icon={FileClock}
        />
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">SKU sắp hết / cần xuất bù</CardTitle>
            <PackageX className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-4">
              <div>
                <div className="text-2xl font-bold">{outstandingSummary?.low_sku_count ?? 0}</div>
                <p className="text-xs text-muted-foreground">Sắp hết</p>
              </div>
              <div>
                <div className="text-2xl font-bold text-destructive">
                  {outstandingSummary?.need_makeup_sku_count ?? 0}
                </div>
                <p className="text-xs text-muted-foreground">Cần xuất bù</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* PHASE UP5: Financial report — invoice/discount/VAT/debt metrics,
          separate from the receipt-based cards above. Ưu tiên Tổng phải trả /
          Đã thanh toán / Còn nợ; chiết khấu + VAT xuống hàng phụ, cùng cách
          bố cục với /debts (Phase UP4). */}
      <div>
        <h3 className="text-lg font-semibold tracking-tight">Báo cáo tài chính hóa đơn</h3>
        <p className="text-sm text-muted-foreground">
          Số liệu hóa đơn/chiết khấu/VAT/công nợ theo bộ lọc ở trên (theo ngày hóa đơn).
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Tổng phải trả"
          description="Tổng final_amount các hóa đơn trong khoảng lọc"
          value={formatCurrency(financialSummary?.total_final_amount ?? 0)}
          icon={Wallet}
        />
        <StatCard
          title="Tổng đã thanh toán"
          description="Tổng số tiền đã thanh toán cho các hóa đơn trên"
          value={formatCurrency(financialSummary?.total_paid_amount ?? 0)}
          icon={Wallet}
        />
        <StatCard
          title="Tổng còn nợ"
          description="Tổng phải trả trừ đã thanh toán"
          value={formatCurrency(financialSummary?.total_remaining_amount ?? 0)}
          icon={Wallet}
          emphasis={(financialSummary?.total_remaining_amount ?? 0) > 0}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <SubStatCard
          title="Tổng giá trị trước điều chỉnh"
          value={formatCurrency(financialSummary?.total_subtotal_amount ?? 0)}
        />
        <SubStatCard
          title="Tổng chiết khấu được hưởng"
          value={formatCurrency(financialSummary?.total_discount_amount ?? 0)}
        />
        <SubStatCard title="Tổng VAT phải chịu" value={formatCurrency(financialSummary?.total_vat_amount ?? 0)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Theo nhà cung cấp</CardTitle>
        </CardHeader>
        <CardContent>
          {!financialSupplierRows || financialSupplierRows.length === 0 ? (
            <EmptyState text="Chưa có hóa đơn trong khoảng thời gian này." />
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {financialSupplierRows.map((s) => (
                    <TableRow key={s.supplier_id}>
                      <TableCell className="font-medium">
                        {s.supplier_code} — {s.supplier_name}
                      </TableCell>
                      <TableCell>{SUPPLIER_TYPE_LABELS[s.supplier_type] ?? s.supplier_type}</TableCell>
                      <TableCell>{formatCurrency(s.subtotal_total)}</TableCell>
                      <TableCell>{formatCurrency(s.discount_total)}</TableCell>
                      <TableCell>{formatCurrency(s.vat_total)}</TableCell>
                      <TableCell className="font-medium">{formatCurrency(s.final_total)}</TableCell>
                      <TableCell>{formatCurrency(s.paid_total)}</TableCell>
                      <TableCell className={s.remaining_total > 0 ? "font-medium text-destructive" : undefined}>
                        {formatCurrency(s.remaining_total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Theo loại nhà cung cấp</CardTitle>
        </CardHeader>
        <CardContent>
          {!financialTypeRows || financialTypeRows.length === 0 ? (
            <EmptyState text="Chưa có hóa đơn trong khoảng thời gian này." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Loại NCC</TableHead>
                    <TableHead>Tạm tính</TableHead>
                    <TableHead>Chiết khấu</TableHead>
                    <TableHead>VAT</TableHead>
                    <TableHead>Tổng phải trả</TableHead>
                    <TableHead>Đã thanh toán</TableHead>
                    <TableHead>Còn nợ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {financialTypeRows.map((t) => (
                    <TableRow key={t.supplier_type}>
                      <TableCell className="font-medium">
                        {SUPPLIER_TYPE_LABELS[t.supplier_type] ?? t.supplier_type}
                      </TableCell>
                      <TableCell>{formatCurrency(t.subtotal_total)}</TableCell>
                      <TableCell>{formatCurrency(t.discount_total)}</TableCell>
                      <TableCell>{formatCurrency(t.vat_total)}</TableCell>
                      <TableCell className="font-medium">{formatCurrency(t.final_total)}</TableCell>
                      <TableCell>{formatCurrency(t.paid_total)}</TableCell>
                      <TableCell className={t.remaining_total > 0 ? "font-medium text-destructive" : undefined}>
                        {formatCurrency(t.remaining_total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 1 + 2: side by side */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Hàng về theo ngày</CardTitle>
          </CardHeader>
          <CardContent>
            {!dailySeries || dailySeries.length === 0 ? (
              <EmptyState text="Chưa có hàng về trong khoảng thời gian này." />
            ) : (
              <div className="space-y-3">
                {dailySeries.map((d) => (
                  <div key={d.receipt_date} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{formatDateVN(d.receipt_date)}</span>
                      <span className="text-muted-foreground">
                        Giao {d.total_delivered_qty} · Nhận {d.total_received_qty} ·{" "}
                        {formatCurrency(d.total_amount)}
                      </span>
                    </div>
                    <Bar value={d.total_amount} max={maxDailyAmount} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Giá trị hàng về theo NCC</CardTitle>
          </CardHeader>
          <CardContent>
            {!supplierTotals || supplierTotals.length === 0 ? (
              <EmptyState text="Chưa có hàng về trong khoảng thời gian này." />
            ) : (
              <div className="space-y-3">
                {supplierTotals.map((s) => (
                  <div key={s.supplier_id} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">
                        {s.supplier_code} — {s.supplier_name}
                      </span>
                      <span className="text-muted-foreground">
                        Nhận {s.total_received_qty} · {formatCurrency(s.total_amount)}
                      </span>
                    </div>
                    <Bar value={s.total_amount} max={maxSupplierAmount} variant="secondary" />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Section 3: outstanding warnings */}
      <Card>
        <CardHeader>
          <CardTitle>Cảnh báo outstanding</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <OutstandingMiniList
            title="Sắp hết"
            rows={topLow ?? []}
          />
          <OutstandingMiniList
            title="Cần xuất bù"
            rows={topNeedMakeup ?? []}
          />
        </CardContent>
      </Card>

      {/* Section 4: recent daily summaries */}
      <Card>
        <CardHeader>
          <CardTitle>Lịch sử hàng về gần nhất</CardTitle>
        </CardHeader>
        <CardContent>
          {!recentDailySummaries || recentDailySummaries.length === 0 ? (
            <EmptyState text="Chưa có dữ liệu trong khoảng thời gian này." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>NCC</TableHead>
                    <TableHead>SL giao</TableHead>
                    <TableHead>SL nhận</TableHead>
                    <TableHead>Chênh lệch</TableHead>
                    <TableHead>Tổng tiền</TableHead>
                    <TableHead className="text-right">Xem</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentDailySummaries.map((row) => (
                    <TableRow key={`${row.receipt_date}-${row.supplier_id}`}>
                      <TableCell className="font-medium">{formatDateVN(row.receipt_date)}</TableCell>
                      <TableCell>{row.supplier_name}</TableCell>
                      <TableCell>{row.total_delivered_qty}</TableCell>
                      <TableCell>{row.total_received_qty}</TableCell>
                      <TableCell className={row.total_difference_qty < 0 ? "text-destructive" : undefined}>
                        {row.total_difference_qty}
                      </TableCell>
                      <TableCell>{formatCurrency(row.total_amount)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          nativeButton={false}
                          render={<Link href={`/receipts/daily/${row.receipt_date}/${row.supplier_id}`} />}
                        >
                          Xem
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 5: recent receipts (optional, receipt-level) */}
      <Card>
        <CardHeader>
          <CardTitle>Phiếu nhập gần nhất</CardTitle>
        </CardHeader>
        <CardContent>
          {!recentReceipts || recentReceipts.length === 0 ? (
            <EmptyState text="Chưa có phiếu nhập nào trong khoảng thời gian này." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mã phiếu</TableHead>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Ca</TableHead>
                    <TableHead>NCC</TableHead>
                    <TableHead>Người nhận</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentReceipts.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        <Link href={`/receipts/${r.id}`} className="hover:underline">
                          {r.receipt_no}
                        </Link>
                      </TableCell>
                      <TableCell>{formatDateVN(r.receipt_date)}</TableCell>
                      <TableCell>{SHIFT_LABELS[r.shift] ?? r.shift}</TableCell>
                      <TableCell>
                        {r.supplier_code} — {r.supplier_name}
                      </TableCell>
                      <TableCell>{r.receiver_name}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  title,
  description,
  value,
  icon: Icon,
  emphasis,
}: {
  title: string;
  description: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  emphasis?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className={emphasis ? "text-2xl font-bold text-destructive" : "text-2xl font-bold"}>
          {value}
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
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

function Bar({
  value,
  max,
  variant = "default",
}: {
  value: number;
  max: number;
  variant?: "default" | "secondary";
}) {
  const pct = Math.max(2, Math.round((value / max) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={variant === "default" ? "h-full bg-primary" : "h-full bg-secondary-foreground/60"}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function OutstandingMiniList({
  title,
  rows,
}: {
  title: string;
  rows: { invoice_item_id: string; invoice_no: string; sku: string; product_name: string; remaining_qty: number; status: "need_makeup" | "low" | "normal" }[];
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
      {rows.length === 0 ? (
        <EmptyState text="Không có mục nào." />
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.invoice_item_id} className="flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {row.sku} — {row.product_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {row.invoice_no} · còn lại {row.remaining_qty}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={STATUS_BADGE_VARIANT[row.status]}>{STATUS_LABELS[row.status]}</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href={`/outstanding/${row.invoice_item_id}`} />}
                >
                  Xem
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{text}</p>;
}
