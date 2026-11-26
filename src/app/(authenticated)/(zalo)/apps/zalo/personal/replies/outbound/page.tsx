import type { Metadata } from "next";
import Link from "next/link";
import { Send } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { DraftStatusBadge } from "@/components/zalo-reply/reply-status";
import { requireReplyPage, unwrapReply } from "@/lib/zalo-reply/server";
import { listDrafts } from "@/lib/zalo-reply/service";
import { formatDateTime } from "@/lib/ui/format";

export const metadata: Metadata = { title: "Zalo cá nhân — Lịch sử gửi trả lời" };
export const dynamic = "force-dynamic";

// PHASE 04.5 — Outbound History: every approved reply and what happened to it.
export default async function OutboundHistoryPage() {
  const { actor, deps } = await requireReplyPage();
  const list = unwrapReply(await listDrafts(deps, actor, { status: "outbound" }));
  return (
    <PageContainer>
      <PageHeader title="Lịch sử gửi trả lời" description="Tin đã duyệt và kết quả gửi. “Chưa rõ đã gửi” nghĩa là yêu cầu đã tới Zalo nhưng không nhận được kết quả: hệ thống không tự gửi lại." />
      {list.rows.length === 0 ? (
        <EmptyState icon={Send} variant="no-data" title="Chưa có tin nào được duyệt gửi" description="Tin xuất hiện ở đây sau khi được duyệt trong Hộp duyệt trả lời." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hội thoại</TableHead>
                <TableHead>Người nhận</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Tạo</TableHead>
                <TableHead>Duyệt</TableHead>
                <TableHead>Gửi</TableHead>
                <TableHead>Lỗi / ghi chú</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="min-w-48">
                    <Link href={`/apps/zalo/personal/replies/${d.id}`} className="font-medium underline-offset-2 hover:underline">
                      {d.conversation.title}
                    </Link>
                  </TableCell>
                  <TableCell>{d.conversation.type === "group" ? "Cả nhóm" : "Riêng người hỏi"}</TableCell>
                  <TableCell>
                    <DraftStatusBadge status={d.status} label={d.statusLabel} />
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{formatDateTime(d.createdAt)}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {d.approvedAt ? formatDateTime(d.approvedAt) : "—"}
                    {d.approvedByName && <div className="text-xs">{d.approvedByName}</div>}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{d.sentAt ? formatDateTime(d.sentAt) : d.sendingStartedAt ? `thử lúc ${formatDateTime(d.sendingStartedAt)}` : "—"}</TableCell>
                  <TableCell className="max-w-xs text-sm text-muted-foreground">{d.error?.label ?? d.hold?.label ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageContainer>
  );
}
