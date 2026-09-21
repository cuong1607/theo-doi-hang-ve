import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PackageSearch } from "lucide-react";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <PackageSearch className="size-6" />
          </div>
          <CardTitle className="text-xl">Theo Dõi Hàng Về</CardTitle>
          <CardDescription>
            Đăng nhập để tiếp tục sử dụng hệ thống.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <Input
              id="email"
              type="email"
              placeholder="email@example.com"
              disabled
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Mật khẩu
            </label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              disabled
            />
          </div>
          <Button className="w-full" disabled>
            Đăng nhập
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Chức năng đăng nhập sẽ được xây dựng trong phase tiếp theo.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
