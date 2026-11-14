import Link from "next/link";
import { ShieldX } from "lucide-react";

import { APP_HUB_PATH } from "@/lib/apps/registry";
import { requireActiveUser } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// 403: signed in and active, but the role lacks the permission for the page
// (requirePermission) or the app (AppShell) that sent them here. Lives in the
// hub group — no app shell, no app check — so it can never loop.
export default async function ForbiddenPage() {
  await requireActiveUser();

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <ShieldX className="size-10 text-muted-foreground" />
        <p className="text-lg font-medium">Bạn không có quyền truy cập trang này.</p>
        <p className="text-sm text-muted-foreground">
          Tài khoản của bạn không được cấp quyền cho chức năng này. Liên hệ quản trị viên nếu cần.
        </p>
        <Button variant="outline" nativeButton={false} render={<Link href={APP_HUB_PATH} />}>
          Về trang ứng dụng
        </Button>
      </CardContent>
    </Card>
  );
}
