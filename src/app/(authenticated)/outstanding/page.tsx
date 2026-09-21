import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function OutstandingPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            Theo dõi hàng còn phải về
          </h2>
          <p className="text-muted-foreground">
            Danh sách các mặt hàng đã có hóa đơn nhưng chưa nhận đủ.
          </p>
        </div>
        <Badge variant="outline">Tất cả</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Hàng còn thiếu</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hóa đơn</TableHead>
                <TableHead>Sản phẩm</TableHead>
                <TableHead>Nhà cung cấp</TableHead>
                <TableHead className="text-right">SL đặt</TableHead>
                <TableHead className="text-right">SL đã nhận</TableHead>
                <TableHead className="text-right">SL còn thiếu</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-24 text-center text-muted-foreground"
                >
                  Chưa có dữ liệu.
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
