import Link from "next/link";
import { requirePermission } from "@/lib/auth/session";
import { AlertTriangle, Plus, PackageSearch } from "lucide-react";

import { canCreateInvoices, canCreateReceipts } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getReceiptDailyGroups } from "@/lib/receipts/history";
import { ListPagination } from "@/components/list-pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { ReceiptHistoryFilters } from "./receipt-history-filters";
import { ReceiptHistoryTable } from "./receipt-history-table";

const PAGE_SIZE = 10;

async function getAllSuppliers() {
  const supabase = createAdminClient();
  const { data } = await supabase.from("suppliers").select("id, code, name").order("code");
  return data ?? [];
}

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    supplier?: string;
    sku?: string;
    name?: string;
    page?: string;
  }>;
}) {
  const auth = await requirePermission("receipt:view");
  const params = await searchParams;
  const fromDate = (params.from ?? "").trim();
  const toDate = (params.to ?? "").trim();
  const supplierId = (params.supplier ?? "").trim();
  const sku = (params.sku ?? "").trim();
  const productName = (params.name ?? "").trim();
  const page = Math.max(1, Number(params.page) || 1);
  const isProductFiltered = !!(sku || productName);

  const [suppliers, { groups, totalGroups, error }] = await Promise.all([
    getAllSuppliers(),
    getReceiptDailyGroups({ fromDate, toDate, supplierId, sku, productName }, page, PAGE_SIZE),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalGroups / PAGE_SIZE));
  const hasFilter = !!(fromDate || toDate || supplierId || sku || productName);
  const canCreateInvoice = canCreateInvoices(auth.profile.role);
  // New filters/page => new set of visible rows => fresh selection.
  const selectionResetKey = [fromDate, toDate, supplierId, sku, productName, page].join("|");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Lịch sử hàng về</h2>
          <p className="text-muted-foreground">
            Tổng hợp theo ngày và nhà cung cấp. Bấm &quot;Xem&quot; để xem chi tiết từng phiếu.
          </p>
        </div>
        {canCreateReceipts(auth.profile.role) && (
          <Button nativeButton={false} render={<Link href="/receipts/new" />}>
            <Plus className="mr-2 size-4" />
            Nhập hàng mới
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="flex-col items-start gap-4 space-y-0">
          <CardTitle>Bộ lọc</CardTitle>
          <ReceiptHistoryFilters
            fromDate={fromDate}
            toDate={toDate}
            supplierId={supplierId}
            sku={sku}
            productName={productName}
            suppliers={suppliers}
          />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Phiếu nhập hàng theo ngày</CardTitle>
        </CardHeader>
        <CardContent>
          {isProductFiltered && (
            <p className="mb-4 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              Đang lọc theo SKU/tên sản phẩm — số liệu mỗi dòng chỉ tính riêng sản phẩm phù hợp,
              không phải tổng cả ngày.
            </p>
          )}
          {error ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <AlertTriangle className="size-8 text-destructive" />
              <p className="font-medium">Đã xảy ra lỗi khi tải dữ liệu.</p>
              <p className="text-sm text-muted-foreground">Vui lòng tải lại trang để thử lại.</p>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <PackageSearch className="size-8 text-muted-foreground" />
              <p className="font-medium">
                {hasFilter ? "Không tìm thấy dữ liệu phù hợp." : "Chưa có phiếu nhập nào."}
              </p>
            </div>
          ) : (
            <>
              {canCreateInvoice && (
                <p className="mb-4 text-sm text-muted-foreground">
                  Chọn các ngày hàng về của cùng một nhà cung cấp để tạo hóa đơn từ hàng đã nhận. Mẹo: lọc
                  theo nhà cung cấp để thấy nhiều ngày hơn.
                  {isProductFiltered &&
                    " Lưu ý: hóa đơn luôn lấy toàn bộ hàng của ngày đã chọn, không chỉ các SKU đang lọc."}
                </p>
              )}
              <ReceiptHistoryTable
                key={selectionResetKey}
                groups={groups}
                canCreateInvoice={canCreateInvoice}
              />
              <ListPagination
                page={page}
                totalPages={totalPages}
                buildHref={(p) => {
                  const qp = new URLSearchParams();
                  if (fromDate) qp.set("from", fromDate);
                  if (toDate) qp.set("to", toDate);
                  if (supplierId) qp.set("supplier", supplierId);
                  if (sku) qp.set("sku", sku);
                  if (productName) qp.set("name", productName);
                  if (p > 1) qp.set("page", String(p));
                  const qs = qp.toString();
                  return qs ? `/receipts?${qs}` : "/receipts";
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
