import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function NewInvoicePage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">
          Tạo hóa đơn mới
        </h2>
        <p className="text-muted-foreground">
          Nhập thông tin hóa đơn từ nhà cung cấp.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Thông tin hóa đơn</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Form tạo hóa đơn sẽ được xây dựng trong phase tiếp theo.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled>
          Hủy
        </Button>
        <Button disabled>Lưu hóa đơn</Button>
      </div>
    </div>
  );
}
