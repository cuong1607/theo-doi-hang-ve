import { PackageSearch } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <PackageSearch className="size-6" />
          </div>
          <CardTitle className="text-xl">Theo Dõi Hàng Về</CardTitle>
          <CardDescription>Đăng nhập để tiếp tục sử dụng hệ thống.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={next ?? ""} />
        </CardContent>
      </Card>
    </div>
  );
}
