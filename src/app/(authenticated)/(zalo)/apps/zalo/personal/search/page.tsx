import type { Metadata } from "next";

import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { SearchPanel } from "@/components/zalo-personal/search-panel";
import { SEARCH_MAX_DAYS, vnDate } from "@/lib/zalo-personal/dashboard/contracts";
import { requireZaloPersonal, unwrap } from "@/lib/zalo-personal/dashboard/server";
import { listConversations } from "@/lib/zalo-personal/dashboard/service";

export const metadata: Metadata = { title: "Zalo cá nhân — Tìm tin nhắn" };
export const dynamic = "force-dynamic";

// ZP-29: search in the current database (no embeddings, no AI). The form POSTs to
// /api/zalo-personal/messages/search — the search text never goes into the URL.
export default async function ZaloPersonalSearchPage() {
  const { actor, deps } = await requireZaloPersonal();
  const conversations = unwrap(await listConversations(deps, actor, { page: 1, size: 100 }));
  const today = new Date();

  return (
    <PageContainer>
      <PageHeader title="Tìm tin nhắn" description="Tìm theo nội dung, hội thoại, người gửi, loại tin và khoảng thời gian (giờ Việt Nam) trong các hội thoại bạn được cấp quyền." />
      <SearchPanel conversations={conversations.rows.map((c) => ({ id: c.id, title: c.title }))} defaultFrom={vnDate(new Date(today.getTime() - 6 * 86_400_000))} defaultTo={vnDate(today)} maxDays={SEARCH_MAX_DAYS} />
    </PageContainer>
  );
}
