import type { Metadata } from "next";
import Link from "next/link";
import { Activity, AlertTriangle, HeartPulse, MessageSquareText, MessagesSquare, Plug, Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { MetricCard, MetricGrid } from "@/components/patterns/metric-card";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { HealthBadge, HeartbeatAge } from "@/components/zalo-personal/health";
import { formatDateTime } from "@/lib/ui/format";
import { requireZaloPersonal, unwrap } from "@/lib/zalo-personal/dashboard/server";
import { getOverview } from "@/lib/zalo-personal/dashboard/service";
import { SITUATION_TEXT } from "@/lib/zalo-personal/dashboard/status";

export const metadata: Metadata = { title: "Zalo cá nhân — Tổng quan" };
export const dynamic = "force-dynamic";

// ZP-24: every number comes from the database, inside the reader's scope. "—" when the
// reader may not see that figure (e.g. groups for a sync-only grant), never a demo value.
export default async function ZaloPersonalOverviewPage() {
  const { actor, deps } = await requireZaloPersonal();
  const o = unwrap(await getOverview(deps, actor));
  const num = (v: number | null) => (v === null ? "—" : v.toLocaleString("vi-VN"));

  return (
    <PageContainer>
      <PageHeader title="Zalo cá nhân" description="Trạng thái kết nối, nhóm được phép theo dõi và tin nhắn đã đồng bộ từ worker trên máy Windows. Chỉ đọc dữ liệu đã lưu: không có AI, không gửi tin, không đồng bộ lịch sử cũ." />

      {o.connections === 0 ? (
        <EmptyState icon={Plug} title="Chưa có kết nối Zalo cá nhân nào bạn được xem" description="Kết nối được tạo bằng script quản trị (zalo-personal:admin connection:create) và worker trên máy Windows. Xem docs/zalo-ai/phase-02-integration.md." />
      ) : (
        <>
          <MetricGrid className="xl:grid-cols-4">
            <MetricCard icon={Plug} label="Tài khoản đã kết nối" value={num(o.connections)} hint={`${o.connectionStates.filter((c) => c.health.health === "connected").length} đang kết nối tốt`} />
            <MetricCard icon={Users} label="Nhóm được phép theo dõi" value={o.groupsTotal === null ? "—" : `${num(o.groupsMonitored)} / ${num(o.groupsTotal)}`} hint={o.groupsTotal === null ? "Bạn không có quyền xem nhóm" : "đang theo dõi / đã phát hiện"} />
            <MetricCard icon={MessagesSquare} label="Hội thoại đã lưu" value={num(o.conversations)} hint="trong phạm vi bạn được xem" />
            <MetricCard icon={MessageSquareText} label="Tin nhắn nhận hôm nay" value={num(o.messagesToday)} hint="từ 00:00 giờ Việt Nam" />
            <MetricCard icon={HeartPulse} label="Heartbeat cuối" value={<span className="text-base">{formatDateTime(o.lastHeartbeatAt)}</span>} hint={o.lastHeartbeatAt ? "worker gửi mỗi 60 giây" : "chưa nhận heartbeat"} />
            <MetricCard icon={Activity} label="Tin gần nhất" value={<span className="text-base">{formatDateTime(o.lastMessageAt)}</span>} hint={o.lastMessageAt ? "thời điểm tin mới nhất trong phạm vi" : "chưa có tin"} />
            <MetricCard icon={AlertTriangle} label="Lỗi đồng bộ chưa xử lý" value={num(o.unresolvedErrors)} tone={o.unresolvedErrors ? "danger" : "neutral"} hint={o.unresolvedErrors === null ? "Bạn không có quyền xem đồng bộ" : "dead-letter + sự kiện bị bỏ do outbox đầy"} />
          </MetricGrid>

          <Card>
            <CardHeader>
              <CardTitle>Trạng thái từng kết nối</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {o.connectionStates.map((c) => (
                  <li key={c.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-medium">{c.connectionKey}</p>
                      <p className="text-sm text-muted-foreground">{SITUATION_TEXT[c.health.situation].title}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
                      <HeartbeatAge health={c.health} />
                      <HealthBadge health={c.health} />
                      <Link className="underline underline-offset-2 hover:text-foreground" href={`/apps/zalo/personal/sync?connection=${c.id}`}>
                        Chi tiết
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {o.messagesToday === 0 && o.conversations === 0 && (
            <Callout tone="info" title="Chưa có tin nhắn nào được lưu">
              Tin chỉ được lưu khi nhóm đã bật theo dõi (có ghi nhận đồng ý) và nằm trong ZP_ALLOWED_GROUP_IDS của worker. Hệ thống không có tin trước thời điểm worker bắt đầu nhận.
            </Callout>
          )}
        </>
      )}
    </PageContainer>
  );
}
