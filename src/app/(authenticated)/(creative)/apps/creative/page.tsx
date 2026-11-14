import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { ComingSoonLanding } from "@/components/app-shell/coming-soon";

export const metadata: Metadata = { title: "Thiết kế ảnh & video" };

// APP-SHELL-1: not built yet — a "Sắp có" landing, no data and no fake metrics.
export default async function CreativeAppPage() {
  await requirePermission("app:creative");
  return <ComingSoonLanding app="creative" />;
}