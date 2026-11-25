import type { Metadata } from "next";
import { Bell } from "lucide-react";

import { NotificationList } from "@/components/ai-tasks/notification-list";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { FilterBar, FilterSelect } from "@/components/patterns/filter-bar";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { notificationsQuery } from "@/lib/ai-tasks/contracts";
import { requireTasksPage, unwrapTasks } from "@/lib/ai-tasks/server";
import { listNotifications } from "@/lib/ai-tasks/service";
import { formatDateTime } from "@/lib/ui/format";

export const metadata: Metadata = { title: "Zalo cá nhân — Thông báo" };
export const dynamic = "force-dynamic";

// PHASE 06 — Notification Inbox (Web Inbox = the standard channel of this phase).
// Own notifications only; each one is re-checked against the CURRENT scope.
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, deps } = await requireTasksPage();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const parsed = notificationsQuery.safeParse({ unread: one("unread"), page: one("page"), size: one("size") });
  const q = parsed.success ? parsed.data : { unread: false, page: 1, size: 30 };
  const list = unwrapTasks(await listNotifications(deps, actor, q));

  return (
    <PageContainer>
      <PageHeader title="Thông báo" description="Được nhắc tên, việc cần xác nhận, sắp đến hạn, quá hạn và bản tin 08:00. Thông báo không chứa nội dung tin nhắn nhóm." />
      <FilterBar filterKeys={["unread"]}>
        <FilterSelect paramKey="unread" value={one("unread")} label="Hiển thị" options={[{ value: "all", label: "Tất cả" }, { value: "1", label: "Chưa đọc" }]} />
      </FilterBar>
      {list.rows.length === 0 ? (
        <EmptyState icon={Bell} title={q.unread ? "Không có thông báo chưa đọc" : "Chưa có thông báo nào"} description="Thông báo xuất hiện khi bạn được nhắc tên theo tài khoản Zalo đã liên kết, hoặc khi có việc cần xử lý." />
      ) : (
        <NotificationList unread={list.unread} items={list.rows.map((n) => ({ id: n.id, kindLabel: n.kindLabel, title: n.title, body: n.body, link: n.link, read: n.read, hidden: n.hidden, createdLabel: formatDateTime(n.createdAt) }))} />
      )}
      <DataTablePagination pathname="/apps/zalo/personal/notifications" query={{ unread: one("unread") }} page={list.page} pageSize={list.size} total={list.total} />
    </PageContainer>
  );
}
