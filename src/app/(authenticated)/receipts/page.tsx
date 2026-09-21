import Link from "next/link";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function ReceiptsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            Lịch sử hàng về
          </h2>
          <p className="text-muted-foreground">
            Danh sách các phiếu nhập hàng đã ghi nhận.
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/receipts/new" />}>
          <Plus className="mr-2 size-4" />
          Nhập hàng mới
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Phiếu nhập hàng</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mã phiếu</TableHead>
                <TableHead>Ngày nhập</TableHead>
                <TableHead>Nhà cung cấp</TableHead>
                <TableHead>Số mặt hàng</TableHead>
                <TableHead className="text-right">Tổng giá trị</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell
                  colSpan={5}
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
