import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TaskActions } from "@/components/ai-tasks/task-actions";
import { ReminderStatusBadge, REMINDER_KIND_LABEL, REMINDER_REASON_LABEL, TaskStatusBadge } from "@/components/ai-tasks/task-status";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { idParam } from "@/lib/ai-tasks/contracts";
import { EXTRACTOR_LABEL, STATUS_LABEL, type TaskStatus } from "@/lib/ai-tasks/lifecycle";
import { requireTasksPage, unwrapTasks } from "@/lib/ai-tasks/server";
import { getTask } from "@/lib/ai-tasks/service";
import { formatDateTime } from "@/lib/ui/format";

export const metadata: Metadata = { title: "Zalo cá nhân — Chi tiết công việc" };
export const dynamic = "force-dynamic";

const MISSING_LABEL: Record<string, string> = { assignee: "chưa rõ người được giao", deadline: "chưa rõ hạn", details: "thiếu chi tiết", ai_not_used: "trích xuất theo quy tắc (không dùng AI)" };
const ROLE_LABEL: Record<string, string> = { manager: "Bạn là người quản lý việc này", assignee: "Bạn được giao việc này", reader: "Bạn chỉ có quyền xem" };

// PHASE 06 — Task Detail. Out-of-scope / unknown id → 404. Source messages are re-loaded
// and shown only because the reader can read the source chat (checked on every open).
export default async function TaskDetailPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { actor, deps } = await requireTasksPage();
  const id = idParam.safeParse((await params).taskId);
  if (!id.success) notFound();
  const t = unwrapTasks(await getTask(deps, actor, id.data));
  const label = (s: string | null) => (s ? STATUS_LABEL[s as TaskStatus] ?? s : "—");

  return (
    <PageContainer>
      <div>
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/apps/zalo/personal/tasks" />}>
          <ArrowLeft aria-hidden="true" />
          Công việc
        </Button>
      </div>
      <PageHeader
        title={t.title}
        description={`${t.conversation.type === "group" ? "Nhóm" : "Chat 1-1"} ${t.conversation.title} · ${ROLE_LABEL[t.role] ?? ""}`}
        meta={
          <>
            <TaskStatusBadge status={t.status} label={t.statusLabel} />
            <span>Hạn: {t.deadline.label}</span>
            <span>Nguồn: {EXTRACTOR_LABEL[t.extractor] ?? t.extractor}{t.confidence !== null ? ` · độ tin cậy ${Math.round(t.confidence * 100)}%` : ""}</span>
            {t.progress > 0 && <span>Tiến độ: {t.progress}%</span>}
          </>
        }
      />
      {t.status === "pending_confirmation" && <Callout tone="warning">Việc này do hệ thống đề xuất và CHƯA được xác nhận: chưa có nhắc việc nào. {t.missing.length ? `Lưu ý: ${t.missing.map((m) => MISSING_LABEL[m] ?? m).join(", ")}.` : ""}</Callout>}
      {t.deadline.at && !t.deadline.confirmed && t.deadline.assumed && <Callout tone="info">Hạn được hiểu từ cụm “{t.deadline.phrase}” và có phần giả định (ví dụ giờ cụ thể). Hãy xác nhận hoặc sửa hạn.</Callout>}
      {t.proposal && (
        <Callout tone="warning">
          Tin nhắn mới đề xuất đổi hạn thành <strong>{t.proposal.label}</strong>
          {t.proposal.phrase ? ` (“${t.proposal.phrase}”)` : ""}. Hạn chỉ thay đổi khi người quản lý áp dụng.
        </Callout>
      )}

      <TaskActions
        taskId={t.id}
        revision={t.revision}
        actions={t.actions}
        title={t.title}
        description={t.description}
        deadlineAt={t.deadline.at}
        deadlineAssumed={t.deadline.assumed && !t.deadline.confirmed}
        progress={t.progress}
        assignedUserIds={t.assignees.map((a) => a.userId).filter((x): x is string => Boolean(x))}
        assignable={t.assignable}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Thông tin</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {t.description && <p className="whitespace-pre-wrap">{t.description}</p>}
            <div>
              <span className="text-muted-foreground">Người được giao: </span>
              {t.assignees.length ? t.assignees.map((a) => a.label).join(", ") : <span className="italic">chưa rõ</span>}
            </div>
            {t.assignor && (
              <div>
                <span className="text-muted-foreground">Người giao: </span>
                {t.assignor}
              </div>
            )}
            {t.confirmedBy && (
              <div>
                <span className="text-muted-foreground">Xác nhận: </span>
                {t.confirmedBy} · {formatDateTime(t.confirmedAt)}
              </div>
            )}
            {t.completedBy && (
              <div>
                <span className="text-muted-foreground">Hoàn thành: </span>
                {t.completedBy} · {formatDateTime(t.completedAt)}
              </div>
            )}
            {t.progressNote && (
              <div>
                <span className="text-muted-foreground">Ghi chú tiến độ: </span>
                {t.progressNote}
              </div>
            )}
            {t.closedReason && (
              <div>
                <span className="text-muted-foreground">Lý do / ghi chú đóng: </span>
                {t.closedReason}
              </div>
            )}
            <div className="text-muted-foreground">Phát hiện lúc {formatDateTime(t.createdAt)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tin nhắn nguồn</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {t.evidence.length > 0 && (
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground uppercase">Bằng chứng</span>
                {t.evidence.map((e, i) => (
                  <blockquote key={i} className="border-l-2 pl-3 italic">
                    {e.quote}
                  </blockquote>
                ))}
              </div>
            )}
            {t.sources.map((s) => (
              <div key={s.id} className="rounded-md border p-2.5">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {s.sender} · {formatDateTime(s.at)} · {s.role === "primary" ? "tin chính" : s.role === "deadline_update" ? "đổi hạn" : "ngữ cảnh"}
                  </span>
                  <Link href={s.link} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                    Xem trong hội thoại <ExternalLink aria-hidden="true" className="size-3" />
                  </Link>
                </div>
                <p className="whitespace-pre-wrap">{s.text ?? <span className="italic text-muted-foreground">(không lưu nội dung)</span>}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nhắc việc</CardTitle>
        </CardHeader>
        <CardContent>
          {t.reminders.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.status === "pending_confirmation" ? "Chưa có lịch nhắc (chờ xác nhận)." : "Không có lịch nhắc (việc chưa có hạn, hoặc thời điểm nhắc đã qua)."}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Loại</TableHead>
                    <TableHead>Thời điểm</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Ghi chú</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.reminders.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{REMINDER_KIND_LABEL[r.kind] ?? r.kind}{r.mine ? " (cho bạn)" : ""}</TableCell>
                      <TableCell className="tabular-nums">{formatDateTime(r.scheduledFor)}</TableCell>
                      <TableCell>
                        <ReminderStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.reason ? REMINDER_REASON_LABEL[r.reason] ?? r.reason : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lịch sử thay đổi</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-2 text-sm">
            {t.activity.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-2">
                <span className="tabular-nums text-muted-foreground">{formatDateTime(a.at)}</span>
                <span className="font-medium">{a.actor}</span>
                <span>{a.action}</span>
                {a.fromStatus !== a.toStatus && a.toStatus && (
                  <span className="text-muted-foreground">
                    ({label(a.fromStatus)} → {label(a.toStatus)})
                  </span>
                )}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
