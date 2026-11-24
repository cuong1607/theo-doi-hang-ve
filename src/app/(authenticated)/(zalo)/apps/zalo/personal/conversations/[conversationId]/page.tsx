import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, MessageSquareOff } from "lucide-react";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { MessageHistory } from "@/components/zalo-personal/message-history";
import { formatDateTime } from "@/lib/ui/format";
import { idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { requireZaloPersonal, unwrap } from "@/lib/zalo-personal/dashboard/server";
import { GROUP_MODE_LABEL, getConversation, listMessages } from "@/lib/zalo-personal/dashboard/service";

export const metadata: Metadata = { title: "Zalo cá nhân — Lịch sử tin nhắn" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

// ZP-28: one conversation, newest first, 30 at a time ("Tải thêm" fetches the next page).
// Out-of-scope or unknown id → 404 (no existence leak). Text is rendered as text only.
// Phase 04: ?focus=<message id>&at=<message time> (from an AI citation) starts the page at
// that message and highlights it; access is checked exactly as for the normal page.
const FOCUS_AFTER = "ffffffff-ffff-ffff-ffff-ffffffffffff";

export default async function ZaloPersonalConversationPage({ params, searchParams }: { params: Promise<{ conversationId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, deps } = await requireZaloPersonal();
  const id = idParam.safeParse((await params).conversationId);
  if (!id.success) notFound();
  const sp = await searchParams;
  const focusId = idParam.safeParse(sp.focus);
  const focusAt = typeof sp.at === "string" && Number.isFinite(Date.parse(sp.at)) ? new Date(Date.parse(sp.at) + 1).toISOString() : null;
  const focus = focusId.success && focusAt ? { id: focusId.data, beforeAt: focusAt } : null;
  const conversation = unwrap(await getConversation(deps, actor, id.data));
  const first = unwrap(await listMessages(deps, actor, conversation.id, focus ? { beforeAt: focus.beforeAt, beforeId: FOCUS_AFTER, limit: PAGE_SIZE } : { limit: PAGE_SIZE }));

  return (
    <PageContainer>
      <div>
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/apps/zalo/personal/conversations" />}>
          <ArrowLeft aria-hidden="true" />
          Hội thoại
        </Button>
      </div>
      <PageHeader
        title={conversation.title}
        description={`${conversation.type === "group" ? "Nhóm" : "Chat 1-1"} · ID ${conversation.externalIdMasked} · kết nối ${conversation.connectionKey}`}
        meta={
          <>
            <span>{conversation.messageCount.toLocaleString("vi-VN")} tin đã lưu</span>
            <span>Tin đầu tiên: {formatDateTime(conversation.firstMessageAt)}</span>
            <span>Tin gần nhất: {formatDateTime(conversation.lastMessageAt)}</span>
            {conversation.groupMode && <span>Chế độ nhóm: {GROUP_MODE_LABEL[conversation.groupMode]}</span>}
          </>
        }
      />
      {conversation.type === "group" && conversation.groupMode === "disabled" && <Callout tone="info">Nhóm đang tắt theo dõi: tin mới không được lưu. Tin đã lưu trước đó vẫn hiển thị.</Callout>}
      {focus && (
        <Callout tone="info">
          Đang xem từ tin được AI trích dẫn (tô sáng) trở về trước.{" "}
          <Link href={`/apps/zalo/personal/conversations/${conversation.id}`} className="underline underline-offset-2">
            Xem tin mới nhất
          </Link>
        </Callout>
      )}
      {first.rows.length === 0 ? (
        <EmptyState icon={MessageSquareOff} title="Chưa có tin nhắn nào được lưu" description="Hệ thống không có tin trước thời điểm worker bắt đầu nhận tin." />
      ) : (
        <MessageHistory conversationId={conversation.id} initial={first.rows} initialCursor={first.nextCursor} pageSize={PAGE_SIZE} highlightId={focus?.id} />
      )}
    </PageContainer>
  );
}
