import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import type { Tone } from "@/lib/ui/status";
import { EmergencyControl, PauseControl } from "@/components/zalo-reply/reply-settings";
import { hasPermission } from "@/lib/auth/permissions";
import { formatDateTime } from "@/lib/ui/format";
import { CLAIM_REASON_LABEL } from "@/lib/zalo-reply/lifecycle";
import { AI_HEALTH_LABEL, HEALTH_LABEL, REASON_LABEL, REMINDER_HEALTH_LABEL, type HealthState } from "@/lib/zalo-reply/ops";
import { getOpsDeps, requireReplyPage, unwrapReply } from "@/lib/zalo-reply/server";
import { getOperations } from "@/lib/zalo-reply/service";

export const metadata: Metadata = { title: "Zalo cá nhân — Vận hành" };
export const dynamic = "force-dynamic";

const MODE_LABEL: Record<string, string> = { disabled: "Tắt", draft_only: "Chỉ bản nháp", manual_approval: "Duyệt tay rồi gửi", auto_reply_allowlist: "Tự động trong phạm vi" };
const AUTO_DIRECT_LABEL: Record<string, string> = { off: "không", allowlist: "chat trong danh sách", all_linked: "mọi người đã liên kết" };
const DM_LABEL: Record<string, string> = { off: "tắt", metadata: "chỉ metadata", linked: "chỉ người đã liên kết", content: "mọi người" };
const DELIVERY_LABEL: Record<string, string> = { pending: "chờ gửi", sending: "đang gửi", sent: "đã gửi", failed: "lỗi", unknown: "chưa rõ", skipped: "bỏ qua" };
const TONE: Record<HealthState, Tone> = {
  healthy: "success",
  degraded: "warning",
  disconnected: "danger",
  authentication_required: "danger",
  stopped: "neutral",
  unknown: "neutral",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 border-b py-1.5 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}
const when = (iso: string | null | undefined) => (iso ? formatDateTime(iso) : "—");

// PHASE 07 — OPS-11: one page to see whether the Zalo bot is actually working and
// to stop it. Admin only (zalo_personal:operate), connections the admin owns.
// Every control reuses an existing, server-authorized API; nothing here is decorative.
export default async function OperationsPage() {
  const { actor } = await requireReplyPage();
  if (!hasPermission(actor.role, "zalo_personal:operate")) notFound();
  const v = unwrapReply(await getOperations(getOpsDeps(), actor));

  return (
    <PageContainer>
      <PageHeader
        title="Vận hành Zalo cá nhân"
        description="Trạng thái thật của worker, hàng gửi, AI và nhắc việc. Một kết nối chỉ được coi là hoạt động tốt khi có heartbeat mới, phiên đã đăng nhập và listener đang chạy."
        meta={
          <>
            <span>Trả lời AI: {v.flags.replyEnabled ? "bật" : "tắt"}</span>
            <span>Gửi tin: {v.flags.sendEnabled ? "bật" : "tắt"}</span>
            <span>Tự động: {v.flags.autoReplyEnabled ? "bật" : "tắt"}</span>
            <span>Cập nhật: {formatDateTime(v.generatedAt)}</span>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">An toàn</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {v.control.emergencyStop ? <Callout tone="danger">Đang DỪNG KHẨN CẤP: không tin nào được gửi (trả lời và nhắc việc).</Callout> : <p className="text-muted-foreground">Dừng ngay mọi gửi tin của mọi kết nối. Trên máy worker: `npm run stop`.</p>}
          <div>
            <EmergencyControl stopped={v.control.emergencyStop} canResume={v.control.canResume} />
          </div>
          <Row label="Bộ xử lý trả lời (cron mỗi phút) — lần chạy gần nhất">
            {when(v.control.lastTickAt)} {v.control.lastTickStatus ? `· ${v.control.lastTickStatus}` : ""}
          </Row>
        </CardContent>
      </Card>

      {v.connections.length === 0 && <Callout tone="info">Bạn không sở hữu kết nối Zalo cá nhân nào.</Callout>}
      {v.connections.map((c) => (
        <Card key={c.id}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
              <span>Kết nối {c.key}</span>
              <StatusBadge tone={TONE[c.health.state]}>{HEALTH_LABEL[c.health.state]}</StatusBadge>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {c.health.reasons.length > 0 && (
              <ul className="grid gap-0.5 text-sm">
                {c.health.reasons.map((r) => (
                  <li key={r}>• {REASON_LABEL[r] ?? r}</li>
                ))}
              </ul>
            )}
            {c.health.state === "authentication_required" && (
              <Callout tone="danger">Zalo đã từ chối / đá phiên. Worker không tự đăng nhập lại. Kiểm tra tài khoản trên điện thoại, đóng Zalo Web / PC của tài khoản này, rồi chạy `npm run login` trên máy worker.</Callout>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <section>
                <h3 className="mb-1 text-sm font-semibold">Worker</h3>
                <Row label="Heartbeat gần nhất">{when(c.sync?.lastHeartbeatAt ?? c.lastHeartbeatAt)}</Row>
                <Row label="Phiên Zalo / listener">
                  {c.sync ? `${c.sync.sessionState} / ${c.sync.listenerState}` : "—"}
                </Row>
                <Row label="Tin Zalo gần nhất (worker nhận)">{when(c.sync?.lastMessageReceivedAt)}</Row>
                <Row label="Lưu vào hệ thống gần nhất">{when(c.sync?.lastIngestedAt)}</Row>
                <Row label="Hàng chờ về backend / dead letter">
                  {c.sync?.outboxDepth ?? "—"} / {c.sync?.deadLetters ?? "—"}
                </Row>
                <Row label="Lỗi gần nhất">{c.sync?.lastErrorCategory ?? c.lastErrorCategory ?? "—"}</Row>
                <Row label="Phiên bản worker">{c.sync?.workerVersion ?? "—"}</Row>
                <Row label="Nội dung chat 1-1 được lưu">{DM_LABEL[c.directMessageMode] ?? c.directMessageMode}</Row>
              </section>
              <section>
                <h3 className="mb-1 text-sm font-semibold">Trả lời & gửi</h3>
                <Row label="Chế độ">{MODE_LABEL[c.settings?.replyMode ?? ""] ?? "—"}</Row>
                <Row label="Gửi tin từ kết nối">{c.settings?.sendEnabled ? (c.settings.sendPaused ? `tạm dừng (${CLAIM_REASON_LABEL.send_paused})` : "bật") : "tắt"}</Row>
                <Row label="Tự động 1-1 / nhóm">
                  {AUTO_DIRECT_LABEL[c.settings?.autoDirect ?? "off"]} / {c.settings?.autoGroups ? "bật" : "tắt"}
                </Row>
                <Row label="Người đã liên kết">{c.linkedUsers}</Row>
                <Row label="Nhóm (nhắc tên / tương tác / cho phép tự động)">
                  {c.groups ? `${c.groups.mentionOnly} / ${c.groups.interactive} / ${c.groups.allowlisted}` : "—"}
                </Row>
                <Row label="Chờ duyệt / chờ gửi / đang gửi">
                  {c.outbound?.pendingApproval ?? 0} / {c.outbound?.queued ?? 0} / {c.outbound?.sending ?? 0}
                </Row>
                <Row label="Chưa rõ đã gửi / lỗi 24h">
                  {c.outbound?.unknown ?? 0} / {c.outbound?.failed24h ?? 0}
                </Row>
                <Row label="Đã gửi hôm nay / giới hạn">
                  {c.outbound?.sentToday ?? 0} / {c.settings?.dailySendLimit ?? "—"}
                </Row>
                <Row label="Nhắc việc chờ gửi">{c.outbound?.remindersQueued ?? 0}</Row>
                <Row label="Gửi thành công gần nhất">{when(c.outbound?.lastSentAt)}</Row>
                <Row label="Câu hỏi tới bot gần nhất">{when(c.lastInboundAt)}</Row>
              </section>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <PauseControl connectionId={c.id} paused={c.settings?.sendPaused === true} />
              <Link href="/apps/zalo/personal/replies/settings" className="underline underline-offset-2">Cài đặt trả lời</Link>
              <Link href="/apps/zalo/personal/replies?status=delivery_unknown" className="underline underline-offset-2">Tin chưa rõ đã gửi</Link>
              <Link href="/apps/zalo/personal/replies/outbound" className="underline underline-offset-2">Lịch sử gửi</Link>
              <Link href="/apps/zalo/personal/groups" className="underline underline-offset-2">Nhóm</Link>
            </div>
          </CardContent>
        </Card>
      ))}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI trả lời</CardTitle>
          </CardHeader>
          <CardContent>
            <Row label="Trạng thái">{AI_HEALTH_LABEL[v.ai.health]}</Row>
            <Row label="Nhà cung cấp / model">
              {v.ai.provider} / {v.ai.model ?? "—"}
            </Row>
            <Row label="Gói / chính sách dữ liệu">
              {v.ai.tier} / {v.ai.dataSharing}
            </Row>
            <Row label="Lần gọi 24h (thành công)">
              {v.ai.snapshot?.requests24h ?? 0} ({v.ai.snapshot?.completed24h ?? 0})
            </Row>
            <Row label="Lỗi hạn mức / lỗi khác / bị chặn trước khi gọi">
              {v.ai.snapshot?.quotaErrors24h ?? 0} / {v.ai.snapshot?.otherErrors24h ?? 0} / {v.ai.snapshot?.refused24h ?? 0}
            </Row>
            <Row label="Token vào / ra 24h">
              {v.ai.snapshot?.inputTokens24h ?? 0} / {v.ai.snapshot?.outputTokens24h ?? 0}
            </Row>
            <Row label="Thành công gần nhất">{when(v.ai.snapshot?.lastOkAt)}</Row>
            <Row label="Lỗi gần nhất">
              {when(v.ai.snapshot?.lastErrorAt)} {v.ai.snapshot?.lastErrorReason ? `· ${v.ai.snapshot.lastErrorReason}` : ""}
            </Row>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nhắc việc</CardTitle>
          </CardHeader>
          <CardContent>
            <Row label="Bộ lập lịch">{REMINDER_HEALTH_LABEL[v.reminders.health]}</Row>
            <Row label="Lần chạy tốt gần nhất">{when(v.reminders.snapshot?.lastOkAt)}</Row>
            <Row label="Quá giờ chưa xử lý / lỗi 24h">
              {v.reminders.snapshot?.pendingDue ?? 0} / {v.reminders.snapshot?.failed ?? 0}
            </Row>
            <Row label="Kênh Zalo cá nhân">{v.reminders.killSwitch ? "tắt (kill switch)" : v.reminders.zaloChannelEnabled ? "bật" : "tắt"}</Row>
            <Row label="Gửi qua Zalo 24h">
              {Object.keys(v.reminders.zaloDeliveries24h).length === 0
                ? "—"
                : Object.entries(v.reminders.zaloDeliveries24h)
                    .map(([k, n]) => `${DELIVERY_LABEL[k] ?? k}: ${n}`)
                    .join(" · ")}
            </Row>
            <p className="mt-2 text-xs text-muted-foreground">
              Thông báo web luôn hoạt động độc lập với Zalo. <Link href="/apps/zalo/personal/tasks/reminders" className="underline underline-offset-2">Lịch sử nhắc việc</Link>
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nhật ký thao tác gần đây</CardTitle>
        </CardHeader>
        <CardContent>
          {v.audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có thao tác.</p>
          ) : (
            <ol className="grid gap-1 text-sm">
              {v.audit.map((a) => (
                <li key={a.id} className="flex flex-wrap gap-x-2">
                  <span className="tabular-nums text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                  <span className="font-medium">{a.actorName ?? (a.actorKind === "worker" ? "Worker" : "Hệ thống")}</span>
                  <span>{a.action}</span>
                  {a.connectionKey && <span className="text-muted-foreground">· {a.connectionKey}</span>}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
