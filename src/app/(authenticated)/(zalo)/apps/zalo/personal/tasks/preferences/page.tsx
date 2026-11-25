import type { Metadata } from "next";

import { PreferencesForm } from "@/components/ai-tasks/preferences-form";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { requireTasksPage, unwrapTasks } from "@/lib/ai-tasks/server";
import { getPreferences } from "@/lib/ai-tasks/service";

export const metadata: Metadata = { title: "Zalo cá nhân — Cài đặt nhắc việc" };
export const dynamic = "force-dynamic";

// PHASE 06 — Notification Preferences (own settings only).
export default async function ReminderPreferencesPage() {
  const { actor, deps } = await requireTasksPage();
  const prefs = unwrapTasks(await getPreferences(deps, actor));
  return (
    <PageContainer>
      <PageHeader title="Cài đặt nhắc việc" description="Chọn loại nhắc việc bạn muốn nhận. Thông báo hiển thị trong mục Thông báo (Web Inbox)." />
      <Callout tone="info">Nhắc việc chạy trên máy chủ (Supabase pg_cron + Vercel), không phụ thuộc máy tính Windows đang bật. Nếu toàn bộ hệ thống gián đoạn, nhắc việc trễ được xử lý theo chính sách gửi bù ở mỗi mục.</Callout>
      <PreferencesForm initial={prefs} />
    </PageContainer>
  );
}
