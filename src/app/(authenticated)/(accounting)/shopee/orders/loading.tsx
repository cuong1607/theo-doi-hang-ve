import { CardSkeleton, FilterBarSkeleton, MetricSkeleton, PageHeaderSkeleton, TableSkeleton } from "@/components/patterns/skeletons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** Same order as the page: header, sync card, KPI row, filters + table. */
export default function ShopeeOrdersLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <span className="sr-only">Đang tải đơn hàng…</span>
      <PageHeaderSkeleton actions={0} />
      <CardSkeleton lines={3} />
      <MetricSkeleton count={6} />
      <Card>
        <CardHeader>
          <FilterBarSkeleton controls={7} />
        </CardHeader>
        <CardContent>
          <TableSkeleton rows={8} columns={9} />
        </CardContent>
      </Card>
    </div>
  );
}
