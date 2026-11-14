import { Undo2 } from "lucide-react";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/session";
import { listShops } from "@/lib/channels/core/queries";
import { listReturns, type ReturnListFilters } from "@/lib/channels/core/returns";
import { DISPOSITION_INFO, isReturnDisposition, returnStatusInfo } from "@/lib/channels/shopee/return-status";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCurrency, formatDateTime, formatQuantity } from "@/lib/ui/format";
import { activeFilterCount, parsePage, parsePageSize } from "@/lib/ui/list-query";
import { AutoRefresh } from "@/components/patterns/auto-refresh";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { ReturnFilters } from "./return-filters";

export const dynamic = "force-dynamic";

type Params = { shop?: string; status?: string; disposition?: string; from?: string; to?: string; q?: string; page?: string; size?: string };
const FILTER_KEYS = ["shop", "status", "disposition", "from", "to", "q"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ShopeeReturnsPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requirePermission("channel:view");
  const params = await searchParams;
  const pageSize = parsePageSize(params.size);
  const page = parsePage(params.page);
  const filters: ReturnListFilters = {
    shopId: params.shop || undefined,
    status: params.status || undefined,
    disposition: isReturnDisposition(params.disposition) ? params.disposition : undefined,
    dateFrom: params.from && DATE.test(params.from) ? params.from : undefined,
    dateTo: params.to && DATE.test(params.to) ? params.to : undefined,
    search: params.q?.trim() || undefined,
  };
  const db = createAdminClient();
  const [shops, { rows, total }, active] = await Promise.all([
    listShops(),
    listReturns(db, filters, page, pageSize),
    db.from("channel_sync_jobs").select("id", { count: "exact", head: true }).eq("sync_type", "return").in("status", ["pending", "running", "retry"]),
  ]);
  const query: Record<string, string | undefined> = { shop: params.shop, status: params.status, disposition: params.disposition, from: params.from, to: params.to, q: params.q, size: params.size };
  const filtered = activeFilterCount(query, FILTER_KEYS) > 0;

  return (
    <PageContainer>
      <PageHeader
        title="Trả hàng Shopee"
        description="Yêu cầu trả hàng / hoàn tiền đồng bộ tự động từ Shopee. Hoàn tiền KHÔNG tự nhập lại kho — chỉ khi chọn cách xử lý “Nhập lại kho” hàng mới về tồn kho và giá vốn mới được hoàn lại."
        meta={<AutoRefresh active={(active.count ?? 0) > 0} />}
      />
      <Card>
        <CardContent className="space-y-4 pt-6">
          <ReturnFilters query={query} shops={shops.filter((s) => s.channel === "shopee").map((s) => ({ id: s.id, name: s.shopName }))} />
          {rows.length === 0 ? (
            <EmptyState
              icon={Undo2}
              title={filtered ? "Không có yêu cầu trả hàng phù hợp." : "Chưa có yêu cầu trả hàng nào."}
              description={filtered ? undefined : "Trả hàng được đồng bộ tự động mỗi 15 phút."}
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Mã trả hàng</TableHead>
                    <TableHead>Đơn</TableHead>
                    {shops.length > 1 && <TableHead>Shop</TableHead>}
                    <TableHead>Trạng thái</TableHead>
                    <TableHead className="text-right">SL</TableHead>
                    <TableHead className="text-right">Hoàn tiền</TableHead>
                    <TableHead>Cách xử lý</TableHead>
                    <TableHead className="text-right">Tồn kho / giá vốn</TableHead>
                    <TableHead>Tài chính</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const st = returnStatusInfo(r.status);
                    return (
                      <TableRow key={r.returnId}>
                        <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.createdAtChannel)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          <Link href={`/shopee/returns/${r.returnId}`} className="text-primary underline-offset-4 hover:underline">
                            {r.externalReturnSn}
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          <Link href={`/shopee/orders/${r.orderId}`} className="underline-offset-4 hover:underline">
                            {r.externalOrderSn}
                          </Link>
                        </TableCell>
                        {shops.length > 1 && <TableCell className="max-w-32 truncate text-xs">{r.shopName}</TableCell>}
                        <TableCell>
                          <StatusBadge tone={st.tone} icon={false}>
                            {st.label}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="text-right">
                          {r.totalQuantity === null ? "—" : formatQuantity(r.totalQuantity)}
                          {r.unmatchedRows > 0 && <span className="block text-xs text-warning-text">{r.unmatchedRows} dòng không khớp đơn</span>}
                        </TableCell>
                        <TableCell className="text-right">{r.refundAmount === null ? <span className="text-muted-foreground">—</span> : formatCurrency(r.refundAmount)}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {r.dispositions.map((d) => (
                              <StatusBadge key={d} tone={DISPOSITION_INFO[d].tone} icon={false}>
                                {DISPOSITION_INFO[d].label}
                              </StatusBadge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {r.restockRows > 0 ? (
                            <span className="text-success-text">hoàn giá vốn {formatCurrency(r.reversedCogs)}</span>
                          ) : r.pendingRows > 0 ? (
                            <span className="text-warning-text">chờ quyết định</span>
                          ) : (
                            <span className="text-muted-foreground">không nhập kho</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.actualShopeeIncome === null ? (
                            <span className="text-muted-foreground">chưa quyết toán</span>
                          ) : (
                            <>
                              thực nhận {formatCurrency(r.actualShopeeIncome)}
                              {r.financialStatus === "return_adjusted" && <span className="block text-muted-foreground">đã điều chỉnh theo trả hàng</span>}
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <DataTablePagination pathname="/shopee/returns" query={query} page={page} pageSize={pageSize} total={total} />
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
