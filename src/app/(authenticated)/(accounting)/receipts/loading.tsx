import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ReceiptsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">Lịch sử hàng về</h2>
          <p className="text-muted-foreground">
            Tổng hợp theo ngày và nhà cung cấp. Bấm &quot;Xem&quot; để xem chi tiết từng phiếu.
          </p>
        </div>
        <Skeleton className="h-8 w-40" />
      </div>

      <Card>
        <CardHeader className="flex-col items-start gap-4 space-y-0">
          <CardTitle>Bộ lọc</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-8 w-[160px]" />
            <Skeleton className="h-8 w-[160px]" />
            <Skeleton className="h-8 w-[220px]" />
            <Skeleton className="h-8 w-[160px]" />
            <Skeleton className="h-8 w-[220px]" />
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Phiếu nhập hàng theo ngày</CardTitle>
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
