import { redirect } from "next/navigation";
import { UserX } from "lucide-react";

import { getAuthContext } from "@/lib/auth/session";
import { logout } from "@/lib/auth/actions";
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
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <UserX className="size-6" />
          </div>
          <CardTitle className="text-xl">Tài khoản đã bị vô hiệu hóa.</CardTitle>
          <CardDescription>
            Tài khoản {ctx.user.email} hiện không được phép sử dụng hệ thống. Vui lòng liên hệ quản trị
            viên để được kích hoạt lại.
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
