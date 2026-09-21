import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function NewReceiptPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Nhập hàng mới</h2>
        <p className="text-muted-foreground">
          Ghi nhận phiếu nhập hàng từ nhà cung cấp.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Thông tin phiếu nhập</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Form nhập hàng sẽ được xây dựng trong phase tiếp theo.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled>
          Hủy
        </Button>
        <Button disabled>Lưu phiếu nhập</Button>
      </div>
    </div>
  );
}
