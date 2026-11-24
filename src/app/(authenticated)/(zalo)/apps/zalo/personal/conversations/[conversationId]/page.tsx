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
export default async function ZaloPersonalConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { actor, deps } = await requireZaloPersonal();
  const id = idParam.safeParse((await params).conversationId);
  if (!id.success) notFound();
  const conversation = unwrap(await getConversation(deps, actor, id.data));
  const first = unwrap(await listMessages(deps, actor, conversation.id, { limit: PAGE_SIZE }));

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
      {first.rows.length === 0 ? (
        <EmptyState icon={MessageSquareOff} title="Chưa có tin nhắn nào được lưu" description="Hệ thống không có tin trước thời điểm worker bắt đầu nhận tin." />
      ) : (
        <MessageHistory conversationId={conversation.id} initial={first.rows} initialCursor={first.nextCursor} pageSize={PAGE_SIZE} />
      )}
    </PageContainer>
  );
}
