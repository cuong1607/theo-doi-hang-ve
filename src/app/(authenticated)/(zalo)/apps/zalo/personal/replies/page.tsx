import type { Metadata } from "next";
import Link from "next/link";
import { Bot, MessageSquare, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { DraftStatusBadge, KIND_LABEL } from "@/components/zalo-reply/reply-status";
import { listQuery } from "@/lib/zalo-reply/contracts";
import { requireReplyPage, unwrapReply } from "@/lib/zalo-reply/server";
import { listDrafts, recentInbound } from "@/lib/zalo-reply/service";
import { formatDateTime } from "@/lib/ui/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Zalo cá nhân — Hộp duyệt trả lời AI" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "review", label: "Cần xử lý" },
  { key: "pending_approval", label: "Chờ duyệt" },
  { key: "delivery_unknown", label: "Chưa rõ đã gửi" },
  { key: "all", label: "Tất cả" },
] as const;

// PHASE 04.5 — AI Reply Inbox: drafts the reader may review (owner: group + 1-1;
// manage grant: group only; plus the data permissions of each answer).
export default async function RepliesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, deps } = await requireReplyPage();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const q = listQuery.safeParse({ status: one("status") });
  const status = q.success ? q.data.status : "review";
  const [inbox, inbound] = await Promise.all([listDrafts(deps, actor, { status }).then(unwrapReply), recentInbound(deps, actor).then(unwrapReply)]);
  const skipped = inbound.filter((i) => i.status === "skipped" || i.status === "failed").slice(0, 10);

  return (
    <PageContainer>
      <PageHeader
        title="Hộp duyệt trả lời AI"
        description="Câu trả lời AI đề xuất cho tin nhắn gọi bot (chat 1-1, @nhắc bot, /bot). Không tin nào được gửi khi chưa duyệt, trừ hội thoại thử nghiệm đã bật tự động."
        meta={
          <>
            <span>Chờ duyệt: {inbox.counts.pending_approval ?? 0}</span>
            <span>Chờ gửi: {inbox.counts.queued ?? 0}</span>
            {(inbox.counts.delivery_unknown ?? 0) > 0 && <span className="text-destructive">Chưa rõ đã gửi: {inbox.counts.delivery_unknown}</span>}
          </>
        }
      />
      {inbox.emergencyStop && <Callout tone="danger">ĐANG DỪNG KHẨN CẤP: không tin nào được gửi. Xem Cài đặt trả lời.</Callout>}
      {!inbox.flags.sendEnabled && <Callout tone="info">Gửi tin đang tắt ở cấp hệ thống (PERSONAL_SEND_ENABLED). Có thể duyệt, nhưng tin chỉ nằm trong hàng chờ và sẽ hết hạn.</Callout>}
      {inbox.pausedConnections > 0 && <Callout tone="warning">{inbox.pausedConnections} kết nối đang tạm dừng gửi (Zalo từ chối hoặc chủ tài khoản tạm dừng). Kiểm tra tài khoản trước khi cho phép gửi lại.</Callout>}
      {(inbox.counts.delivery_unknown ?? 0) > 0 && <Callout tone="warning">Có tin chưa rõ đã đến người nhận hay chưa. Hệ thống KHÔNG tự gửi lại: hãy kiểm tra trên điện thoại rồi xác nhận.</Callout>}

      <nav aria-label="Lọc bản nháp" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key === "review" ? "/apps/zalo/personal/replies" : `/apps/zalo/personal/replies?status=${t.key}`} aria-current={t.key === status ? "page" : undefined} className={cn("inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm", t.key === status ? "border-primary bg-primary/10 font-medium" : "hover:bg-muted")}>
            {t.label}
          </Link>
        ))}
      </nav>

      {inbox.rows.length === 0 ? (
        <EmptyState icon={Bot} variant="no-data" title="Không có bản nháp nào" description="Bản nháp xuất hiện khi có người gọi bot trong nhóm đã bật (chế độ Chỉ khi nhắc tên / Tương tác) hoặc nhắn 1-1 (khi kết nối lưu nội dung 1-1)." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tin nhắn nguồn</TableHead>
                <TableHead>Trả lời đề xuất</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Hội thoại</TableHead>
                <TableHead>Lúc</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inbox.rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="min-w-56 max-w-xs">
                    <Link href={`/apps/zalo/personal/replies/${d.id}`} className="line-clamp-2 font-medium underline-offset-2 hover:underline">
                      {d.source.text ?? "(không lưu nội dung)"}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {d.asker.linkedName ? `${d.asker.linkedName} · ` : ""}
                      {d.asker.label}
                    </div>
                  </TableCell>
                  <TableCell className="min-w-64 max-w-md">
                    <p className="line-clamp-3 whitespace-pre-wrap text-sm">{d.text}</p>
                    <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                      <span>{KIND_LABEL[d.kind] ?? d.kind}</span>
                      {d.citations.length > 0 && <span>· {d.citations.length} nguồn</span>}
                      {d.edited && <Badge variant="outline">Đã sửa</Badge>}
                      {d.approval === "auto" && <Badge variant="secondary">Tự động</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <DraftStatusBadge status={d.status} label={d.statusLabel} />
                    {d.hold && <div className="mt-1 text-xs text-muted-foreground">{d.hold.label}</div>}
                    {d.status === "pending_approval" && d.expired && <div className="mt-1 text-xs text-warning-text">đã quá hạn duyệt</div>}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      {d.conversation.type === "group" ? <Users aria-hidden="true" className="size-3.5 text-muted-foreground" /> : <MessageSquare aria-hidden="true" className="size-3.5 text-muted-foreground" />}
                      {d.conversation.title}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{formatDateTime(d.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {skipped.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-base font-semibold">Tin gọi bot không được trả lời gần đây</h2>
          <ul className="grid gap-1 text-sm">
            {skipped.map((i) => (
              <li key={i.id} className="flex flex-wrap gap-x-2 text-muted-foreground">
                <span className="tabular-nums">{formatDateTime(i.createdAt)}</span>
                <span>{i.conversationTitle}</span>
                <span>· {i.trigger}</span>
                <span>· {i.reason ?? i.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}
