import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardList, Sparkles, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TaskStatusBadge } from "@/components/ai-tasks/task-status";
import { Callout } from "@/components/patterns/callout";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { FilterBar, FilterSelect } from "@/components/patterns/filter-bar";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { listTasksQuery } from "@/lib/ai-tasks/contracts";
import { EXTRACTOR_LABEL, STATUS_LABEL, TASK_STATUSES } from "@/lib/ai-tasks/lifecycle";
import { requireTasksPage, unwrapTasks } from "@/lib/ai-tasks/server";
import { listTasks, taskCounts, type ListQuery } from "@/lib/ai-tasks/service";
import { formatDateTime } from "@/lib/ui/format";
import { listConversations } from "@/lib/zalo-personal/dashboard/service";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Zalo cá nhân — Công việc" };
export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "", label: "Tất cả", title: "Tất cả công việc", description: "Mọi việc phát hiện từ các hội thoại bạn được xem." },
  { key: "pending", label: "Chờ xác nhận", title: "Việc cần xác nhận", description: "Việc do AI / bộ quy tắc phát hiện. Chưa có nhắc việc nào cho đến khi người quản lý xác nhận." },
  { key: "mine", label: "Của tôi", title: "Việc của tôi", description: "Việc bạn được giao (theo tài khoản Zalo đã liên kết) hoặc bạn nhận nhắc việc." },
  { key: "overdue", label: "Quá hạn", title: "Việc quá hạn", description: "Việc đã nhận nhưng đã qua hạn và chưa hoàn thành." },
] as const;

// PHASE 06 — Task Inbox / Pending / My tasks / Overdue (one page, ?view=). Server-side paging
// inside the reader's Phase 03 scope; a task exists for the reader only if its SOURCE chat does.
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, deps, dashboard } = await requireTasksPage();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const parsed = listTasksQuery.safeParse({ view: one("view"), status: one("status"), conversation: one("conversation"), assignee: one("assignee"), due: one("due"), page: one("page"), size: one("size") });
  const q = parsed.success ? parsed.data : { page: 1, size: 25 };
  const query: ListQuery = { ...(q as ListQuery), conversationId: (q as { conversation?: string }).conversation };
  const [list, counts, groups] = await Promise.all([
    listTasks(deps, actor, query).then(unwrapTasks),
    taskCounts(deps, actor).then(unwrapTasks),
    listConversations(dashboard, actor, { type: "group", page: 1, size: 100 }).then((r) => (r.ok ? r.data.rows : [])),
  ]);
  const view = VIEWS.find((v) => v.key === (query.view ?? "")) ?? VIEWS[0];
  const keep = { status: one("status"), conversation: one("conversation"), assignee: one("assignee"), due: one("due") };
  const filtered = Boolean(keep.status || keep.conversation || keep.assignee || keep.due);
  const badge: Record<string, number> = { pending: counts.pending, mine: counts.mine, overdue: counts.overdue };

  return (
    <PageContainer>
      <PageHeader title={view.title} description={view.description} meta={<span>{counts.unread > 0 ? <Link className="underline underline-offset-2" href="/apps/zalo/personal/notifications">{counts.unread} thông báo chưa đọc</Link> : "Không có thông báo chưa đọc"}</span>} />
      <nav aria-label="Nhóm công việc" className="flex flex-wrap gap-1.5">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={v.key ? `/apps/zalo/personal/tasks?view=${v.key}` : "/apps/zalo/personal/tasks"}
            aria-current={v.key === (query.view ?? "") ? "page" : undefined}
            className={cn("inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm", v.key === (query.view ?? "") ? "border-primary bg-primary/10 font-medium" : "hover:bg-muted")}
          >
            {v.label}
            {v.key && badge[v.key] ? <Badge variant={v.key === "overdue" ? "destructive" : "secondary"}>{badge[v.key]}</Badge> : null}
          </Link>
        ))}
      </nav>
      <FilterBar filterKeys={["status", "conversation", "assignee", "due"]}>
        <FilterSelect paramKey="status" value={keep.status} label="Trạng thái" options={[{ value: "all", label: "Mọi trạng thái" }, ...TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]} />
        {groups.length > 0 && <FilterSelect paramKey="conversation" value={keep.conversation} label="Nhóm" options={[{ value: "all", label: "Mọi nhóm" }, ...groups.map((g) => ({ value: g.id, label: g.title }))]} />}
        <FilterSelect paramKey="assignee" value={keep.assignee} label="Người được giao" options={[{ value: "all", label: "Mọi người" }, { value: "me", label: "Tôi" }]} />
        <FilterSelect paramKey="due" value={keep.due} label="Hạn" options={[{ value: "all", label: "Mọi hạn" }, { value: "today", label: "Đến hết hôm nay" }, { value: "week", label: "Trong 7 ngày" }, { value: "none", label: "Chưa có hạn" }]} />
      </FilterBar>
      {query.view === "pending" && list.total > 0 && <Callout tone="info">Hãy kiểm tra người được giao và hạn trước khi xác nhận. Hạn có ghi “giả định” là do hệ thống tự hiểu từ câu chữ (ví dụ “chiều mai” → 17:00).</Callout>}

      {list.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} variant={filtered ? "no-results" : "no-data"} title={filtered ? "Không có việc khớp bộ lọc" : "Chưa có công việc nào"} description={filtered ? "Thử bỏ bớt bộ lọc." : "Việc xuất hiện khi tin nhắn trong nhóm đang theo dõi có dấu hiệu giao việc."} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Công việc</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Hạn</TableHead>
                <TableHead>Nhóm</TableHead>
                <TableHead>Phát hiện</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="min-w-64 max-w-md">
                    <Link href={`/apps/zalo/personal/tasks/${t.id}`} className="font-medium underline-offset-2 hover:underline">
                      {t.title}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {t.mine && <Badge variant="outline">Của tôi</Badge>}
                      <span className="inline-flex items-center gap-1">
                        <Sparkles aria-hidden="true" className="size-3" />
                        {EXTRACTOR_LABEL[t.extractor] ?? t.extractor}
                        {t.confidence !== null ? ` · ${Math.round(t.confidence * 100)}%` : ""}
                      </span>
                      {t.progress > 0 && t.status !== "completed" && <span>· {t.progress}%</span>}
                      {t.hasProposal && <Badge variant="secondary">Có đề xuất đổi hạn</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <TaskStatusBadge status={t.overdue && t.status !== "overdue" ? "overdue" : t.status} label={t.overdue && t.status !== "overdue" ? "Quá hạn" : t.statusLabel} />
                  </TableCell>
                  <TableCell className={cn("tabular-nums", t.overdue && "text-destructive")}>
                    {t.deadlineLabel}
                    {t.deadlineNeedsConfirmation && <div className="text-xs text-warning-text">cần xác nhận</div>}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <Users aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      {t.conversationTitle}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{formatDateTime(t.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <DataTablePagination pathname="/apps/zalo/personal/tasks" query={{ view: query.view, ...keep }} page={list.page} pageSize={list.size} total={list.total} />
    </PageContainer>
  );
}
