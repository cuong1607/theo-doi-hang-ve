import { redirect } from "next/navigation";

import { requireZaloPersonal } from "@/lib/zalo-personal/dashboard/server";

export const dynamic = "force-dynamic";

// "Trợ lý Zalo AI" landing: Zalo cá nhân is its only module in Phase 03.
export default async function ZaloAppPage() {
  await requireZaloPersonal();
  redirect("/apps/zalo/personal");
}
