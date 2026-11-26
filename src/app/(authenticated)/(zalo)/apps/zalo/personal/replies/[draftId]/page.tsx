import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { DraftActions } from "@/components/zalo-reply/draft-actions";
import { DraftStatusBadge, KIND_LABEL, PIPELINE_LABEL } from "@/components/zalo-reply/reply-status";
import { idParam } from "@/lib/zalo-reply/contracts";
import { STATUS_LABEL, type DraftStatus } from "@/lib/zalo-reply/lifecycle";
import { requireReplyPage, unwrapReply } from "@/lib/zalo-reply/server";
import { getDraft } from "@/lib/zalo-reply/service";
import { formatDateTime } from "@/lib/ui/format";

export const metadata: Metadata = { title: "Zalo cá nhân — Chi tiết trả lời AI" };
export const dynamic = "force-dynamic";

// PHASE 04.5 — one AI reply: source message, proposal, citations, audit, actions.
// Out-of-scope / unknown id → 404.
export default async function ReplyDetailPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { actor, deps } = await requireReplyPage();
  const id = idParam.safeParse((await params).draftId);
  if (!id.success) notFound();
  const d = unwrapReply(await getDraft(deps, actor, id.data));
  const label = (s: string | null) => (s ? STATUS_LABEL[s as DraftStatus] ?? s : "—");

  return (
    <PageContainer>
      <div>
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/apps/zalo/personal/replies" />}>
          <ArrowLeft aria-hidden="true" />
          Hộp duyệt
        </Button>
      </div>
      <PageHeader
        title={KIND_LABEL[d.kind] ?? "Trả lời AI"}
        description={`${d.conversation.type === "group" ? `Nhóm ${d.conversation.title}` : d.conversation.title} · người đọc: ${d.conversation.type === "group" ? "mọi thành viên nhóm" : "chỉ người hỏi"}`}
        meta={
          <>
            <DraftStatusBadge status={d.status} label={d.statusLabel} />
            <span>Nguồn dữ liệu: {PIPELINE_LABEL[d.pipeline] ?? d.pipeline}</span>
            <span>Hạn duyệt/gửi: {formatDateTime(d.expiresAt)}</span>
          </>
        }
      />
      {d.status === "pending_approval" && d.expired && <Callout tone="warning">Bản nháp đã quá hạn: câu trả lời có thể đã lỗi thời nên không thể duyệt nữa.</Callout>}
      {d.status === "delivery_unknown" && <Callout tone="danger">Không rõ tin đã đến người nhận chưa ({d.error?.label ?? "không rõ"}). Hệ thống không tự gửi lại. Kiểm tra cuộc trò chuyện trên điện thoại rồi xác nhận.</Callout>}
      {d.hold && <Callout tone="info">Đang chờ gửi: {d.hold.label}.</Callout>}
      {d.status === "failed" && d.error && <Callout tone="danger">Gửi thất bại: {d.error.label}.</Callout>}
      {d.status === "cancelled" && d.error && <Callout tone="info">Đã hủy trước khi gửi: {d.error.label}.</Callout>}

      <DraftActions draftId={d.id} version={d.version} text={d.text} actions={d.actions} sendEnabled={deps.config.sendEnabled} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tin nhắn nguồn</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {d.asker.linkedName ? `${d.asker.linkedName} (đã liên kết) · ` : ""}
                {d.asker.label} · {formatDateTime(d.source.at)}
              </span>
              <Link href={d.source.href} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                Xem trong hội thoại <ExternalLink aria-hidden="true" className="size-3" />
              </Link>
            </div>
            <p className="whitespace-pre-wrap">{d.source.text ?? <span className="italic text-muted-foreground">(không lưu nội dung)</span>}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Trả lời {d.status === "sent" ? "đã gửi" : "đề xuất"}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3">{d.text}</p>
            {d.edited && (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">Nội dung gốc do AI đề xuất</summary>
                <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{d.originalText}</p>
              </details>
            )}
            {d.citations.length > 0 && (
              <div className="grid gap-1">
                <span className="text-xs font-medium uppercase text-muted-foreground">Nguồn</span>
                <ul className="grid gap-1">
                  {d.citations.map((c, i) => (
                    <li key={i} className="text-xs">
                      <span className="font-medium">[{c.ref}]</span> {c.label}
                      {c.detail ? <span className="text-muted-foreground"> — {c.detail}</span> : null}
                      {c.href ? (
                        <Link href={c.href} className="ml-1 underline underline-offset-2">
                          xem
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {d.caveats.length > 0 && (
              <ul className="grid gap-0.5 text-xs text-muted-foreground">
                {d.caveats.map((c, i) => (
                  <li key={i}>Lưu ý: {c}</li>
                ))}
              </ul>
            )}
            <div className="grid gap-0.5 text-xs text-muted-foreground">
              {d.approvedAt && <span>Duyệt: {d.approvedByName ?? "—"} · {formatDateTime(d.approvedAt)}</span>}
              {d.sendingStartedAt && <span>Bắt đầu gửi: {formatDateTime(d.sendingStartedAt)} · lần thử {d.attempts}</span>}
              {d.sentAt && <span>Đã gửi: {formatDateTime(d.sentAt)}</span>}
              {d.model && <span>Model: {d.model}</span>}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nhật ký</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-2 text-sm">
            {d.audit.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-2">
                <span className="tabular-nums text-muted-foreground">{formatDateTime(a.at)}</span>
                <span className="font-medium">{a.actor}</span>
                <span>{a.action}</span>
                {a.fromStatus !== a.toStatus && a.toStatus && (
                  <span className="text-muted-foreground">
                    ({label(a.fromStatus)} → {label(a.toStatus)})
                  </span>
                )}
                {a.detail && <span className="text-muted-foreground">· {a.detail}</span>}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
