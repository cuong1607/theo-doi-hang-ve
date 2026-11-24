import type { Metadata } from "next";
import Link from "next/link";
import { MessagesSquare, User, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { FilterBar, FilterSelect, SearchInput } from "@/components/patterns/filter-bar";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { formatDateTime } from "@/lib/ui/format";
import { parsePage, parsePageSize } from "@/lib/ui/list-query";
import { listConversationsQuery } from "@/lib/zalo-personal/dashboard/contracts";
import { requireZaloPersonal, unwrap } from "@/lib/zalo-personal/dashboard/server";
import { listConnections, listConversations } from "@/lib/zalo-personal/dashboard/service";

export const metadata: Metadata = { title: "Zalo cá nhân — Hội thoại" };
export const dynamic = "force-dynamic";

// ZP-27: Zalo PERSONAL conversations only (own tables) — never mixed with the Web
// assistant or Zalo OA threads. Server-side paging inside the reader's scope; 1-1 chats
// only for the owner (or an explicit per-conversation grant).
export default async function ZaloPersonalConversationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, deps } = await requireZaloPersonal();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const parsed = listConversationsQuery.safeParse({ connectionId: one("connection"), type: one("type"), groupId: one("group"), name: one("name"), page: String(parsePage(one("page"))), size: String(parsePageSize(one("size"))) });
  const q = parsed.success ? parsed.data : { page: 1, size: 25 };
  const [connections, list] = await Promise.all([listConnections(deps, actor).then(unwrap), listConversations(deps, actor, q).then(unwrap)]);
  const query = { connection: one("connection"), type: one("type"), group: one("group"), name: one("name") };
  const filtered = Boolean(query.connection || query.type || query.group || query.name);

  return (
    <PageContainer>
      <PageHeader title="Hội thoại Zalo cá nhân" description="Hội thoại có tin đã lưu, mới nhất trước. Chỉ gồm tin nhận sau khi worker bắt đầu chạy; không có lịch sử cũ." />
      <FilterBar filterKeys={["connection", "type", "group", "name"]}>
        <SearchInput paramKey="name" defaultValue={query.name} placeholder="Tên nhóm hoặc ID hội thoại" label="Tìm theo tên hội thoại" />
        {connections.length > 1 && <FilterSelect paramKey="connection" value={query.connection} label="Kết nối" options={[{ value: "all", label: "Mọi kết nối" }, ...connections.map((c) => ({ value: c.id, label: c.connectionKey }))]} />}
        <FilterSelect
          paramKey="type"
          value={query.type}
          label="Loại"
          options={[
            { value: "all", label: "Nhóm và 1-1" },
            { value: "group", label: "Nhóm" },
            { value: "user", label: "Chat 1-1" },
          ]}
        />
      </FilterBar>

      {list.rows.length === 0 ? (
        <EmptyState icon={MessagesSquare} variant={filtered ? "no-results" : "no-data"} title={filtered ? "Không có hội thoại khớp bộ lọc" : "Chưa có hội thoại nào trong phạm vi bạn được xem"} description={filtered ? "Thử bỏ bớt bộ lọc." : "Hội thoại xuất hiện khi có tin được lưu (nhóm đã bật theo dõi, hoặc chat 1-1 theo chính sách của kết nối)."} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hội thoại</TableHead>
                <TableHead>Tin gần nhất</TableHead>
                <TableHead className="text-right">Tin đã lưu</TableHead>
                <TableHead>Cập nhật</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="min-w-56">
                    <Link href={`/apps/zalo/personal/conversations/${c.id}`} className="inline-flex items-center gap-1.5 font-medium underline-offset-2 hover:underline">
                      {c.type === "group" ? <Users aria-hidden="true" className="size-4" /> : <User aria-hidden="true" className="size-4" />}
                      {c.title}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap gap-1 text-xs text-muted-foreground">
                      <Badge variant="outline">{c.type === "group" ? "Nhóm" : "Chat 1-1"}</Badge>
                      {connections.length > 1 && <span>{c.connectionKey}</span>}
                      {c.type === "group" && c.groupMode === "disabled" && <span>· nhóm đang tắt theo dõi</span>}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-md">
                    {c.last ? (
                      <p className="truncate text-sm" title={c.last.preview ?? undefined}>
                        {c.last.isSelf && <span className="text-muted-foreground">Bạn: </span>}
                        {c.last.preview ?? <span className="text-muted-foreground italic">{c.last.typeLabel} (không lưu nội dung)</span>}
                      </p>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.messageCount.toLocaleString("vi-VN")}</TableCell>
                  <TableCell className="tabular-nums">{formatDateTime(c.lastMessageAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <DataTablePagination pathname="/apps/zalo/personal/conversations" query={query} page={list.page} pageSize={list.size} total={list.total} />
    </PageContainer>
  );
}
