import { Download, PackageSearch } from "lucide-react";
import Link from "next/link";

import { defaultProductSort, getAnalyticsSummary, getAtomicConsumption, getProductAnalytics, isProductSort } from "@/lib/channels/core/analytics";
import { coverageText } from "@/lib/analytics/periods";
import { formatMoney, formatPct, formatSignedMoney, isNegative } from "@/lib/analytics/display";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatQuantity } from "@/lib/ui/format";
import { parsePage, parsePageSize } from "@/lib/ui/list-query";
import { AnalyticsFilters } from "@/components/analytics/analytics-filters";
import { getAnalyticsContext, periodText, type AnalyticsParams } from "@/components/analytics/context";
import { AnalyticsSection, loadSection, SectionFailed } from "@/components/analytics/section";
import { COST_FLAG_LABEL } from "@/components/analytics/labels";
import { SortHeader } from "@/components/analytics/sort-header";
import { Callout } from "@/components/patterns/callout";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

const PATH = "/shopee/analytics/products";

export default async function ProductAnalyticsPage({ searchParams }: { searchParams: Promise<AnalyticsParams & { type?: string; q?: string; sort?: string; dir?: string; page?: string; size?: string }> }) {
  const params = await searchParams;
  const ctx = await getAnalyticsContext(params, "30d");
  if (!ctx) return <EmptyState icon={PackageSearch} title="Chưa kết nối shop Shopee nào." />;
  const db = createAdminClient();
  const page = parsePage(params.page);
  const size = parsePageSize(params.size);
  const type = params.type === "atomic" || params.type === "combo" ? params.type : null;
  const res = await loadSection("products-page", async () => {
    const summary = await getAnalyticsSummary(db, ctx.scope, ctx.period);
    const sort = isProductSort(params.sort) ? params.sort : defaultProductSort(summary);
    const desc = params.dir !== "asc";
    const [list, consumption] = await Promise.all([
      getProductAnalytics(db, ctx.scope, ctx.period, { type, search: params.q, sort, desc, limit: size, offset: (page - 1) * size }),
      getAtomicConsumption(db, ctx.scope, ctx.period, 10),
    ]);
    return { summary, sort, desc, list, consumption };
  });
  const query: Record<string, string | undefined> = { ...ctx.query, type: type ?? undefined, q: params.q, sort: params.sort, dir: params.dir, size: params.size };
  const exportQs = new URLSearchParams(Object.entries({ kind: "products", ...query }).filter(([, v]) => v) as Array<[string, string]>);

  return (
    <>
      <PageHeader
        title="Phân tích sản phẩm"
        description={`${periodText(ctx.period)} · SKU bán (combo là một SKU riêng, không tách thành phần). Doanh thu / lợi nhuận đơn được phân bổ cho từng dòng theo tỷ lệ giá trị dòng trong đơn.`}
        actions={
          <Button size="sm" variant="outline" nativeButton={false} render={<a href={`/api/shopee/analytics/export?${exportQs}`} />}>
            <Download /> Xuất Excel
          </Button>
        }
      />
      <AnalyticsFilters query={query} shops={ctx.scope.shops.map((s) => ({ id: s.id, name: s.name }))} extraKeys={["type", "q"]} typeFilter search />
      {!res.ok ? (
        <SectionFailed title="Sản phẩm" />
      ) : (
        <>
          {res.data.summary.order_count > 0 && (
            <Callout tone="info">
              LN dự kiến có cho {coverageText(res.data.summary.estimated_profit_orders, res.data.summary.order_count)}; LN thực tế cho {coverageText(res.data.summary.actual_profit_orders, res.data.summary.order_count)}. Mặc định xếp theo{" "}
              {defaultProductSort(res.data.summary) === "actual_profit" ? "LN thực tế" : "LN dự kiến (dữ liệu thực tế chưa đủ 80%)"}. Đơn chưa ghép SKU không nằm trong bảng.
            </Callout>
          )}
          <AnalyticsSection title={`SKU (${res.data.list.total})`}>
            {res.data.list.rows.length === 0 ? (
              <EmptyState icon={PackageSearch} title="Không có SKU nào bán trong kỳ." />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead className="text-right">
                          <SortHeader label="SL" column="units" sort={res.data.sort} desc={res.data.desc} pathname={PATH} query={query} />
                        </TableHead>
                        <TableHead className="text-right">Đơn</TableHead>
                        <TableHead className="text-right">
                          <SortHeader label="Giá trị đơn" column="order_value" sort={res.data.sort} desc={res.data.desc} pathname={PATH} query={query} />
                        </TableHead>
                        <TableHead className="text-right">DT ước tính</TableHead>
                        <TableHead className="text-right">
                          <SortHeader label="Giá vốn" column="cogs" sort={res.data.sort} desc={res.data.desc} pathname={PATH} query={query} />
                        </TableHead>
                        <TableHead className="text-right">
                          <SortHeader label="LN dự kiến" column="estimated_profit" sort={res.data.sort} desc={res.data.desc} pathname={PATH} query={query} />
                        </TableHead>
                        <TableHead className="text-right">
                          <SortHeader label="LN thực tế" column="actual_profit" sort={res.data.sort} desc={res.data.desc} pathname={PATH} query={query} />
                        </TableHead>
                        <TableHead className="text-right">
                          <SortHeader label="Margin" column={res.data.sort === "actual_margin" || res.data.sort === "actual_profit" ? "actual_margin" : "estimated_margin"} sort={res.data.sort} desc={res.data.desc} pathname={PATH} query={query} />
                        </TableHead>
                        <TableHead className="text-right">
                          <SortHeader label="Trả hàng" column="return_rate" sort={res.data.sort} desc={res.data.desc} pathname={PATH} query={query} />
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {res.data.list.rows.map((r) => (
                        <TableRow key={r.product_id}>
                          <TableCell className="max-w-64">
                            <Link href={`${PATH}/${r.product_id}${ctx.qs}`} className="font-mono text-xs text-primary underline-offset-4 hover:underline">
                              {r.sku}
                            </Link>
                            <span className="ml-1.5">
                              <StatusBadge tone={r.product_type === "combo" ? "info" : "neutral"} icon={false}>
                                {r.product_type === "combo" ? "Combo" : "Sản phẩm"}
                              </StatusBadge>
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">{r.name}</span>
                            {r.cost_flag && <span className="block text-xs text-warning-text">{COST_FLAG_LABEL[r.cost_flag]}</span>}
                          </TableCell>
                          <TableCell className="text-right">{formatQuantity(r.units)}</TableCell>
                          <TableCell className="text-right">{r.orders}</TableCell>
                          <TableCell className="text-right">{formatMoney(r.order_value)}</TableCell>
                          <TableCell className="text-right">{formatMoney(r.estimated_revenue)}</TableCell>
                          <TableCell className="text-right">{formatMoney(r.cogs)}</TableCell>
                          <TableCell className={`text-right ${isNegative(r.estimated_profit) ? "text-danger-text" : ""}`}>
                            {formatSignedMoney(r.estimated_profit)}
                            {r.estimated_lines < r.lines && <span className="block text-xs text-muted-foreground">{r.estimated_lines}/{r.lines} dòng</span>}
                          </TableCell>
                          <TableCell className={`text-right ${isNegative(r.actual_profit) ? "text-danger-text" : ""}`}>
                            {formatSignedMoney(r.actual_profit)}
                            <span className="block text-xs text-muted-foreground">
                              {r.actual_lines}/{r.lines} dòng final
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            {formatPct(r.actual_margin ?? r.estimated_margin)}
                            <span className="block text-xs text-muted-foreground">{r.actual_margin ? "thực tế" : r.estimated_margin ? "dự kiến" : ""}</span>
                          </TableCell>
                          <TableCell className="text-right">
                            {formatPct(r.return_rate)}
                            <span className="block text-xs text-muted-foreground">
                              {formatQuantity(r.returned_units)}/{formatQuantity(r.units)} sp{r.small_sample ? " · mẫu nhỏ" : ""}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <DataTablePagination pathname={PATH} query={query} page={page} pageSize={size} total={res.data.list.total} />
              </>
            )}
          </AnalyticsSection>
          <AnalyticsSection title="SKU thật đã tiêu thụ" description="Thông tin phụ: số lượng sản phẩm thật đã xuất (bán lẻ + thành phần combo theo BOM lúc bán). Không dùng để xếp hạng bán hàng.">
            {res.data.consumption.length === 0 ? (
              <p className="text-sm text-muted-foreground">Chưa có.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Bán lẻ</TableHead>
                      <TableHead className="text-right">Qua combo</TableHead>
                      <TableHead className="text-right">Tổng tiêu thụ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {res.data.consumption.map((c) => (
                      <TableRow key={c.product_id}>
                        <TableCell>
                          <span className="font-mono text-xs">{c.sku}</span>
                          <span className="block text-xs text-muted-foreground">{c.name}</span>
                        </TableCell>
                        <TableCell className="text-right">{formatQuantity(c.direct_units)}</TableCell>
                        <TableCell className="text-right">{formatQuantity(c.via_combo_units)}</TableCell>
                        <TableCell className="text-right font-medium">{formatQuantity(c.total_units)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </AnalyticsSection>
        </>
      )}
    </>
  );
}
