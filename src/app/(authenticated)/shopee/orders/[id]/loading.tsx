import { CardSkeleton, PageHeaderSkeleton, TableSkeleton } from "@/components/patterns/skeletons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ShopeeOrderDetailLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <span className="sr-only">Đang tải chi tiết đơn…</span>
      <Skeleton className="h-4 w-36" />
      <PageHeaderSkeleton actions={0} />
      <CardSkeleton lines={4} />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <TableSkeleton rows={3} columns={8} />
        </CardContent>
      </Card>
      <CardSkeleton lines={6} />
    </div>
  );
}
