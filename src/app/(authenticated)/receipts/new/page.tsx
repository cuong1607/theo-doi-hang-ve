import { Lock } from "lucide-react";

import { canCreateReceipts, getCurrentRole } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";

import { ReceiptForm } from "./receipt-form";

// No dynamic API (cookies/headers/searchParams) is used here, so Next.js
// would otherwise prerender this route once at build time and freeze the
// supplier list — force per-request rendering so newly added/deactivated
// suppliers show up immediately.
export const dynamic = "force-dynamic";

async function getActiveSuppliers() {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("suppliers")
    .select("id, code, name")
    .eq("is_active", true)
    .order("code", { ascending: true });
  return data ?? [];
}

export default async function NewReceiptPage() {
  const role = getCurrentRole();
  const canCreate = canCreateReceipts(role);

  if (!canCreate) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Nhập hàng mới</h2>
          <p className="text-muted-foreground">Ghi nhận phiếu nhập hàng từ nhà cung cấp.</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Lock className="size-8 text-muted-foreground" />
            <p className="font-medium">Bạn chỉ có quyền xem.</p>
            <p className="text-sm text-muted-foreground">
              Tài khoản của bạn không có quyền tạo phiếu nhập hàng.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const suppliers = await getActiveSuppliers();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Nhập hàng mới</h2>
        <p className="text-muted-foreground">Ghi nhận phiếu nhập hàng từ nhà cung cấp.</p>
      </div>

      <ReceiptForm suppliers={suppliers} />
    </div>
  );
}
