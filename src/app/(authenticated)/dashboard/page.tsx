import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  PackagePlus,
  FileText,
  PackageSearch,
  TrendingUp,
} from "lucide-react";

const stats = [
  {
    title: "Hàng về hôm nay",
    value: "—",
    icon: PackagePlus,
    description: "Chưa có dữ liệu",
  },
  {
    title: "Hóa đơn đang xử lý",
    value: "—",
    icon: FileText,
    description: "Chưa có dữ liệu",
  },
  {
    title: "Hàng còn phải về",
    value: "—",
    icon: PackageSearch,
    description: "Chưa có dữ liệu",
  },
  {
    title: "Tổng giá trị nhập",
    value: "—",
    icon: TrendingUp,
    description: "Chưa có dữ liệu",
  },
];

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            Tổng quan
          </h2>
          <p className="text-muted-foreground">
            Thống kê hoạt động nhập hàng và hóa đơn.
          </p>
        </div>
        <Badge variant="outline">Hôm nay</Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">
                {stat.title}
              </CardTitle>
              <stat.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground">
                {stat.description}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Hàng về gần đây</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Chưa có dữ liệu nhập hàng.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Hóa đơn gần đây</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Chưa có dữ liệu hóa đơn.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
