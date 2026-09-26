import { redirect } from "next/navigation";
import { UserX } from "lucide-react";

import { getAuthContext } from "@/lib/auth/session";
import { logout } from "@/lib/auth/actions";
import { displayLogin } from "@/lib/auth/login-identifier";
import { BRAND_NAME } from "@/lib/brand";
import { BrandLogo } from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Where the proxy / requireActiveUser() send a signed-in user whose profile
// is inactive (or missing). Outside the (authenticated) layout on purpose:
// no sidebar, no business data — just the message and a way out.
export default async function AccountDisabledPage() {
  const ctx = await getAuthContext();
  if (ctx.status === "unauthenticated") redirect("/login");
  if (ctx.status === "active") redirect("/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-accent/60 to-background p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader className="items-center">
          <BrandLogo size={72} className="mx-auto" />
          <p className="text-sm font-bold tracking-wide text-heading">{BRAND_NAME}</p>
          <div className="mx-auto mt-2 flex items-center gap-2 text-destructive">
            <UserX className="size-5" />
            <CardTitle className="text-lg">Tài khoản đã bị vô hiệu hóa.</CardTitle>
          </div>
          <CardDescription>
            Tài khoản {displayLogin(ctx.user.email ?? "")} hiện không được phép sử dụng hệ thống. Vui lòng liên
            hệ quản trị viên để được kích hoạt lại.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={logout}>
            <Button type="submit" variant="outline" className="w-full">
              Đăng xuất
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
