import { MetricSkeleton, PageHeaderSkeleton, TableSkeleton } from "@/components/patterns/skeletons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProductCostLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <span className="sr-only">Đang tải sổ giá vốn…</span>
      <Skeleton className="h-4 w-36" />
      <PageHeaderSkeleton />
      <MetricSkeleton count={3} className="xl:grid-cols-3" />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <TableSkeleton rows={8} columns={9} />
        </CardContent>
      </Card>
    </div>
  );
}
