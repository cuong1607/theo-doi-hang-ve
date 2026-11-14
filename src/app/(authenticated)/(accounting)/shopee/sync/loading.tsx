import { CardSkeleton, MetricSkeleton, PageHeaderSkeleton, TableSkeleton } from "@/components/patterns/skeletons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ShopeeSyncLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <span className="sr-only">Đang tải trạng thái đồng bộ…</span>
      <PageHeaderSkeleton actions={0} />
      <MetricSkeleton count={4} />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <TableSkeleton rows={2} columns={4} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent>
          <TableSkeleton rows={6} columns={8} />
        </CardContent>
      </Card>
      <CardSkeleton lines={2} />
    </div>
  );
}
