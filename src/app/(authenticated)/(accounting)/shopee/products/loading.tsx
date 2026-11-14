import { CardSkeleton, FilterBarSkeleton, MetricSkeleton, PageHeaderSkeleton, TableSkeleton } from "@/components/patterns/skeletons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** Same order as the page: header, shop/sync card, KPI row, filters + table. */
export default function ShopeeProductsLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <span className="sr-only">Đang tải sản phẩm Shopee…</span>
      <PageHeaderSkeleton actions={0} />
      <CardSkeleton lines={2} />
      <MetricSkeleton count={6} />
      <Card>
        <CardHeader>
          <FilterBarSkeleton controls={5} />
        </CardHeader>
        <CardContent>
          <TableSkeleton rows={8} columns={7} />
        </CardContent>
      </Card>
    </div>
  );
}
