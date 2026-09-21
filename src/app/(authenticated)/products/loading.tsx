import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProductsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">Sản phẩm</h2>
          <p className="text-muted-foreground">Quản lý danh mục sản phẩm trong hệ thống.</p>
        </div>
        <Skeleton className="h-8 w-36" />
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-4 space-y-0">
          <CardTitle>Danh sách sản phẩm</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-8 w-[180px]" />
            <Skeleton className="h-8 w-[200px]" />
            <Skeleton className="h-8 w-[220px]" />
            <Skeleton className="h-8 w-[180px]" />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
