import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Callout } from "@/components/patterns/callout";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { FilterBar, FilterSelect } from "@/components/patterns/filter-bar";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { GroupActions } from "@/components/zalo-personal/group-actions";
import { formatDateTime } from "@/lib/ui/format";
import { parsePage, parsePageSize } from "@/lib/ui/list-query";
import { listGroupsQuery } from "@/lib/zalo-personal/dashboard/contracts";
import { requireZaloPersonal, unwrap } from "@/lib/zalo-personal/dashboard/server";
import { listConnections, listGroups, type GroupView } from "@/lib/zalo-personal/dashboard/service";

export const metadata: Metadata = { title: "Zalo cá nhân — Nhóm" };
export const dynamic = "force-dynamic";

const MODE_TONE: Record<GroupView["mode"], "neutral" | "success" | "info" | "warning"> = { disabled: "neutral", monitor: "success", mention_only: "info", interactive: "warning" };
const CONSENT_TONE: Record<GroupView["consentStatus"], "neutral" | "success" | "warning"> = { none: "neutral", granted: "success", withdrawn: "warning" };
const DISCOVERED: Record<GroupView["discoveredVia"], string> = { discovery_token: "mã phát hiện", event: "tin nhắn", admin: "quản trị" };

// ZP-26: groups of the connections the reader may see (read / manage grant or owner).
// New groups are "Tắt" (database default). Mode changes go through the API: owner or
// manage grant only, consent required for monitoring, "interactive" not available.
export default async function ZaloPersonalGroupsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, deps } = await requireZaloPersonal();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const parsed = listGroupsQuery.safeParse({ connectionId: one("connection"), mode: one("mode"), page: String(parsePage(one("page"))), size: String(parsePageSize(one("size"))) });
  const q = parsed.success ? parsed.data : { page: 1, size: 25 };
  const [connections, groups] = await Promise.all([listConnections(deps, actor).then(unwrap), listGroups(deps, actor, q).then(unwrap)]);
  const groupConnections = connections.filter((c) => c.capabilities.viewGroups);
  const query = { connection: one("connection"), mode: one("mode") };

  return (
    <PageContainer>
      <PageHeader title="Nhóm Zalo" description="Nhóm đã được phát hiện qua worker. Chỉ nhóm đã ghi nhận đồng ý mới bật theo dõi được; có thể tắt bất cứ lúc nào." />

      {groupConnections.length === 0 ? (
        <EmptyState icon={Users} title="Bạn không có quyền xem nhóm" description="Quyền xem nhóm do chủ sở hữu kết nối cấp (mức “Xem nhóm & tin nhắn nhóm” trở lên)." />
      ) : (
        <>
          <Callout tone="info" title="Hai lớp kiểm soát">
            Worker trên máy Windows chỉ gửi tin của nhóm có trong <code>ZP_ALLOWED_GROUP_IDS</code>; server chỉ lưu khi nhóm ở đây đã bật và có đồng ý. Đổi chế độ ở đây không thay đổi cấu hình của worker.
          </Callout>
          <FilterBar filterKeys={["connection", "mode"]}>
            <FilterSelect paramKey="connection" value={query.connection} label="Kết nối" options={[{ value: "all", label: "Mọi kết nối" }, ...groupConnections.map((c) => ({ value: c.id, label: c.connectionKey }))]} />
            <FilterSelect
              paramKey="mode"
              value={query.mode}
              label="Chế độ"
              options={[
                { value: "all", label: "Mọi chế độ" },
                { value: "disabled", label: "Tắt" },
                { value: "monitor", label: "Theo dõi" },
                { value: "mention_only", label: "Chỉ khi được nhắc" },
              ]}
            />
          </FilterBar>

          {groups.rows.length === 0 ? (
            <EmptyState variant={query.mode || query.connection ? "no-results" : "no-data"} title={query.mode || query.connection ? "Không có nhóm khớp bộ lọc" : "Chưa phát hiện nhóm nào"} description="Nhóm xuất hiện khi worker nhận sự kiện của nhóm hoặc khi bạn gửi mã phát hiện (ZP_DISCOVERY_TOKEN) trong nhóm." />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nhóm</TableHead>
                    <TableHead>Kết nối</TableHead>
                    <TableHead>Chế độ</TableHead>
                    <TableHead>Đồng ý</TableHead>
                    <TableHead className="text-right">Tin đã lưu</TableHead>
                    <TableHead>Tin gần nhất</TableHead>
                    <TableHead>Đồng bộ cuối</TableHead>
                    <TableHead className="text-right">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.rows.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell>
                        {g.conversationId ? (
                          <Link href={`/apps/zalo/personal/conversations/${g.conversationId}`} className="font-medium underline-offset-2 hover:underline">
                            {g.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{g.name}</span>
                        )}
                        <div className="text-xs text-muted-foreground">
                          ID {g.externalIdMasked} · phát hiện qua {DISCOVERED[g.discoveredVia]}
                        </div>
                      </TableCell>
                      <TableCell>{g.connectionKey}</TableCell>
                      <TableCell>
                        <StatusBadge tone={MODE_TONE[g.mode]}>{g.modeLabel}</StatusBadge>
                        {g.modeChangedAt && <div className="text-xs text-muted-foreground">đổi lúc {formatDateTime(g.modeChangedAt)}</div>}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={CONSENT_TONE[g.consentStatus]}>{g.consentLabel}</StatusBadge>
                        {g.consentRecordedAt && <div className="text-xs text-muted-foreground">{formatDateTime(g.consentRecordedAt)}</div>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{g.messageCount.toLocaleString("vi-VN")}</TableCell>
                      <TableCell className="tabular-nums">{formatDateTime(g.lastMessageAt)}</TableCell>
                      <TableCell className="tabular-nums">{formatDateTime(g.lastSeenAt)}</TableCell>
                      <TableCell className="text-right">
                        {g.canManage ? <GroupActions group={{ id: g.id, name: g.name, mode: g.mode, consentStatus: g.consentStatus, interactiveAvailable: g.interactiveAvailable }} /> : <span className="text-xs text-muted-foreground">Chỉ xem</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <DataTablePagination pathname="/apps/zalo/personal/groups" query={query} page={groups.page} pageSize={groups.size} total={groups.total} />
        </>
      )}
    </PageContainer>
  );
}
