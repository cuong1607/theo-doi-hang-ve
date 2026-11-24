import type { Metadata } from "next";
import { Activity } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { EmptyState } from "@/components/patterns/empty-state";
import { FilterBar, FilterSelect } from "@/components/patterns/filter-bar";
import { MetricCard, MetricGrid } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader, SectionHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { HealthBadge, HeartbeatAge, LISTENER_LABEL, SESSION_LABEL, SituationCallout } from "@/components/zalo-personal/health";
import { formatDateTime } from "@/lib/ui/format";
import { parsePage, parsePageSize } from "@/lib/ui/list-query";
import { idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { requireZaloPersonal, unwrap } from "@/lib/zalo-personal/dashboard/server";
import { getSync, listConnections, type IngestionSummaryRow } from "@/lib/zalo-personal/dashboard/service";

export const metadata: Metadata = { title: "Zalo cá nhân — Nhật ký đồng bộ" };
export const dynamic = "force-dynamic";

const OUTCOME: Record<string, { label: string; tone: "success" | "info" | "neutral" | "warning" }> = {
  stored: { label: "Đã lưu", tone: "success" },
  recorded: { label: "Đã ghi nhận", tone: "info" },
  rejected_group: { label: "Từ chối (nhóm)", tone: "neutral" },
  rejected_direct: { label: "Từ chối (1-1)", tone: "neutral" },
  ignored: { label: "Bỏ qua", tone: "neutral" },
};
const REASON: Record<string, string> = {
  group_disabled: "nhóm chưa bật theo dõi",
  direct_disabled: "chat 1-1 đang tắt",
  not_mentioned: "chế độ chỉ-khi-nhắc, tin không nhắc tới",
  not_a_group: "không phải nhóm",
  group_registered: "đăng ký nhóm (mã phát hiện)",
  message_already_stored: "tin đã có (trùng)",
};
const KIND: Record<string, string> = { message: "Tin nhắn", undo: "Thu hồi", reaction: "Cảm xúc", group_event: "Sự kiện nhóm", group_discovery: "Phát hiện nhóm" };
const STATUS_KIND: Record<string, string> = { first_seen: "Heartbeat đầu tiên", state_changed: "Đổi trạng thái", resumed: "Có lại heartbeat sau khi gián đoạn" };

function SummaryTable({ rows }: { rows: IngestionSummaryRow[] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Không có sự kiện.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Kết quả</TableHead>
            <TableHead>Lý do</TableHead>
            <TableHead className="text-right">Sự kiện</TableHead>
            <TableHead className="text-right">Gửi lại (retry)</TableHead>
            <TableHead>Gần nhất</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.outcome}:${r.reason}`}>
              <TableCell>
                <StatusBadge tone={OUTCOME[r.outcome]?.tone ?? "neutral"}>{OUTCOME[r.outcome]?.label ?? r.outcome}</StatusBadge>
              </TableCell>
              <TableCell className="text-sm">{r.reason ? (REASON[r.reason] ?? r.reason) : "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{r.events.toLocaleString("vi-VN")}</TableCell>
              <TableCell className="text-right tabular-nums" title="Số sự kiện server nhận nhiều hơn một lần / tổng số lần gửi thêm">
                {r.redeliveredEvents} / +{r.extraDeliveries}
              </TableCell>
              <TableCell className="tabular-nums">{formatDateTime(r.lastReceivedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ZP-30: worker health from separate signals (never "OK because the backend is up"),
// status history (state changes only), ingestion outcomes with retries the server saw,
// worker-reported outbox / dead-letter counts. Categories only — no stack, no secret.
export default async function ZaloPersonalSyncPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, deps } = await requireZaloPersonal();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const connections = unwrap(await listConnections(deps, actor)).filter((c) => c.capabilities.viewSync);
  if (!connections.length)
    return (
      <PageContainer>
        <PageHeader title="Nhật ký đồng bộ" />
        <EmptyState icon={Activity} title="Bạn không có quyền xem đồng bộ" description="Chủ sở hữu kết nối có thể cấp quyền “Xem đồng bộ” cho bạn." />
      </PageContainer>
    );
  const requested = idParam.safeParse(one("connection"));
  const selected = connections.find((c) => requested.success && c.id === requested.data) ?? connections[0]!;
  const page = Math.min(1000, parsePage(one("page")));
  const size = parsePageSize(one("size"));
  const sync = unwrap(await getSync(deps, actor, selected.id, { page, size }));
  const c = sync.connection;
  const w = c.workers.find((x) => x.status === "active");

  return (
    <PageContainer>
      <PageHeader title="Nhật ký đồng bộ" description="Theo dõi worker: heartbeat, phiên Zalo, listener, outbox và kết quả ghi nhận từng sự kiện. Backend online không có nghĩa Zalo đang hoạt động." meta={<span className="inline-flex items-center gap-2">Heartbeat: <HeartbeatAge health={c.health} /> <HealthBadge health={c.health} /></span>} />
      {connections.length > 1 && (
        <FilterBar filterKeys={["connection"]}>
          <FilterSelect paramKey="connection" value={selected.id} label="Kết nối" options={connections.map((x) => ({ value: x.id, label: x.connectionKey }))} />
        </FilterBar>
      )}
      <SituationCallout health={c.health} />

      <MetricGrid className="xl:grid-cols-4">
        <MetricCard label="Phiên Zalo" value={<span className="text-base">{w ? (SESSION_LABEL[w.sessionState] ?? w.sessionState) : "—"}</span>} hint={`Listener: ${w ? (LISTENER_LABEL[w.listenerState] ?? w.listenerState) : "—"}`} />
        <MetricCard label="Ingest thành công cuối" value={<span className="text-base">{formatDateTime(c.lastIngestedAt)}</span>} hint={`Tin worker nhận cuối: ${formatDateTime(w?.lastMessageReceivedAt)}`} />
        <MetricCard label="Outbox đang chờ" value={w?.outboxDepth ?? "—"} tone={(w?.outboxDepth ?? 0) > 0 ? "warning" : "neutral"} hint={`Gửi tới backend OK cuối: ${formatDateTime(w?.lastDeliveryOkAt)}`} />
        <MetricCard label="Dead-letter / bỏ do outbox đầy" value={w ? `${w.deadLetterCount ?? 0} / ${w.outboxFullDrops ?? 0}` : "—"} tone={(w?.deadLetterCount ?? 0) + (w?.outboxFullDrops ?? 0) > 0 ? "danger" : "neutral"} hint={`Nhóm lỗi: ${w?.lastErrorCategory ?? c.lastErrorCategory ?? "—"}`} />
      </MetricGrid>
      <p className="text-xs text-muted-foreground">Outbox, dead-letter và nhóm lỗi do worker tự báo trong heartbeat gần nhất. Xử lý dead-letter trên máy Windows: <code>npm run ingest:status</code>, <code>npm run outbox:retry-dead</code>.</p>

      <Card>
        <CardHeader>
          <SectionHeader title="Kết quả ghi nhận sự kiện" description="“Từ chối” theo chính sách (nhóm chưa bật, 1-1 tắt) là bình thường, không phải lỗi. “Gửi lại” = số sự kiện server nhận nhiều lần do worker retry." />
        </CardHeader>
        <CardContent className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium">24 giờ qua</p>
            <SummaryTable rows={sync.summary24h} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">7 ngày qua</p>
            <SummaryTable rows={sync.summary7d} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <SectionHeader title="Lịch sử trạng thái worker" description="Chỉ lưu khi trạng thái đổi hoặc có lại heartbeat sau gián đoạn > 5 phút (giữ 30 ngày, 50 mục gần nhất)." />
        </CardHeader>
        <CardContent>
          {sync.statusEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có lịch sử (bắt đầu ghi từ khi áp migration 00074).</p>
          ) : (
            <ol className="divide-y text-sm">
              {sync.statusEvents.map((e) => (
                <li key={e.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between">
                  <span>
                    <span className="font-medium">{STATUS_KIND[e.kind] ?? e.kind}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · phiên {SESSION_LABEL[e.sessionState] ?? e.sessionState} · listener {LISTENER_LABEL[e.listenerState] ?? e.listenerState}
                      {e.lastErrorCategory ? ` · lỗi ${e.lastErrorCategory}` : ""}
                      {e.kind === "resumed" && e.previousHeartbeatAt ? ` · heartbeat trước: ${formatDateTime(e.previousHeartbeatAt)}` : ""}
                    </span>
                  </span>
                  <time className="text-muted-foreground tabular-nums" dateTime={e.observedAt}>
                    {formatDateTime(e.observedAt)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <SectionHeader title="Sự kiện gần đây" description="Mỗi sự kiện một dòng (không lưu nội dung tin ở đây)." />
        </CardHeader>
        <CardContent>
          {sync.events.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa nhận sự kiện nào.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nhận lúc</TableHead>
                    <TableHead>Loại</TableHead>
                    <TableHead>Kết quả</TableHead>
                    <TableHead className="text-right">Số lần nhận</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sync.events.rows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="tabular-nums">{formatDateTime(e.firstReceivedAt)}</TableCell>
                      <TableCell>
                        {KIND[e.kind] ?? e.kind}
                        {e.conversationType && <span className="text-muted-foreground"> · {e.conversationType === "group" ? "nhóm" : "1-1"}</span>}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={OUTCOME[e.outcome]?.tone ?? "neutral"}>{OUTCOME[e.outcome]?.label ?? e.outcome}</StatusBadge>
                        {e.reason && <span className="ml-2 text-xs text-muted-foreground">{REASON[e.reason] ?? e.reason}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{e.deliveryCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <DataTablePagination pathname="/apps/zalo/personal/sync" query={{ connection: connections.length > 1 ? selected.id : undefined }} page={sync.events.page} pageSize={sync.events.size} total={sync.events.total} />
        </CardContent>
      </Card>
    </PageContainer>
  );
}
