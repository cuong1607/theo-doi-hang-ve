import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function OutstandingLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold tracking-tight">Theo dõi hàng còn phải về</h2>
        <p className="text-muted-foreground">
          Đối chiếu hóa đơn với hàng đã nhận theo logic của bảng Excel hiện tại.
        </p>
      </div>

      <Card>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-col items-start gap-4 space-y-0">
          <CardTitle>Bộ lọc</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-8 w-[220px]" />
            <Skeleton className="h-8 w-[160px]" />
            <Skeleton className="h-8 w-[160px]" />
            <Skeleton className="h-8 w-[180px]" />
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hàng còn phải về</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
