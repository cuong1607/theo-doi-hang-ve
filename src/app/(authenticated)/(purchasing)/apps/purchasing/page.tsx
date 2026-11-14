import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { ComingSoonLanding } from "@/components/app-shell/coming-soon";

export const metadata: Metadata = { title: "Gọi hàng" };

// APP-SHELL-1: not built yet — a "Sắp có" landing, no data and no fake metrics.
export default async function PurchasingAppPage() {
  await requirePermission("app:purchasing");
  return <ComingSoonLanding app="purchasing" />;
}