import type { Metadata } from "next";
import Link from "next/link";
import { History } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReminderStatusBadge, REMINDER_KIND_LABEL, REMINDER_REASON_LABEL } from "@/components/ai-tasks/task-status";
import { Callout } from "@/components/patterns/callout";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { historyQuery } from "@/lib/ai-tasks/contracts";
import { requireTasksPage, unwrapTasks } from "@/lib/ai-tasks/server";
import { reminderHistory } from "@/lib/ai-tasks/service";
import { formatAge, formatDateTime } from "@/lib/ui/format";

export const metadata: Metadata = { title: "Zalo cá nhân — Lịch sử nhắc việc" };
export const dynamic = "force-dynamic";

// PHASE 06 — Reminder History: the reader's OWN occurrences (sent, sent late, skipped,
// cancelled, failed) + the engine's health (counts only, no content).
export default async function ReminderHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, deps } = await requireTasksPage();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const parsed = historyQuery.safeParse({ page: one("page"), size: one("size") });
  const q = parsed.success ? parsed.data : { page: 1, size: 30 };
  const h = unwrapTasks(await reminderHistory(deps, actor, q));
  const health = h.health as { pendingDue?: number; failed?: number; candidatesPending?: number; lastOkAt?: string | null };
  const neverRan = !health.lastOkAt;

  return (
    <PageContainer>
      <PageHeader
        title="Lịch sử nhắc việc"
        description="Các lần nhắc của bạn và kết quả: đã gửi, gửi bù, bỏ qua (kèm lý do), đã hủy hoặc lỗi."
        meta={
          <>
            <span>Bộ nhắc việc chạy lần cuối: {health.lastOkAt ? formatAge(String(health.lastOkAt)) : "chưa chạy"}</span>
            <span>Đang trễ: {health.pendingDue ?? 0}</span>
            <span>Lỗi 24h: {health.failed ?? 0}</span>
            <span>Tin chờ phân tích: {health.candidatesPending ?? 0}</span>
          </>
        }
      />
      {neverRan && <Callout tone="warning">Bộ nhắc việc chưa chạy lần nào. Nhắc việc cần lịch chạy mỗi phút (pg_cron → /api/internal/ai-tasks/tick) đã được cấu hình.</Callout>}
      {(health.pendingDue ?? 0) > 0 && <Callout tone="warning">Có {health.pendingDue} nhắc việc đến giờ mà chưa được xử lý: bộ nhắc việc có thể đang gián đoạn. Khi chạy lại, hệ thống gửi bù theo chính sách (không gửi hàng loạt).</Callout>}
      {h.rows.length === 0 ? (
        <EmptyState icon={History} title="Chưa có lần nhắc nào" description="Lịch nhắc được tạo khi việc của bạn được xác nhận và có hạn." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Loại</TableHead>
                <TableHead>Công việc</TableHead>
                <TableHead>Lịch</TableHead>
                <TableHead>Kết quả</TableHead>
                <TableHead>Xử lý lúc</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {h.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{REMINDER_KIND_LABEL[r.kind] ?? r.kind}</TableCell>
                  <TableCell className="max-w-md">
                    {r.taskId ? (
                      <Link className="underline-offset-2 hover:underline" href={`/apps/zalo/personal/tasks/${r.taskId}`}>
                        {r.taskTitle}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{r.taskTitle ?? "Bản tin tổng hợp"}</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatDateTime(r.scheduledFor)}</TableCell>
                  <TableCell>
                    <ReminderStatusBadge status={r.status} />
                    {r.reason && <div className="text-xs text-muted-foreground">{REMINDER_REASON_LABEL[r.reason] ?? r.reason}</div>}
                    {r.attempts > 0 && <div className="text-xs text-muted-foreground">{r.attempts} lần thử lại</div>}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{formatDateTime(r.processedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <DataTablePagination pathname="/apps/zalo/personal/tasks/reminders" query={{}} page={h.page} pageSize={h.size} total={h.total} />
    </PageContainer>
  );
}
