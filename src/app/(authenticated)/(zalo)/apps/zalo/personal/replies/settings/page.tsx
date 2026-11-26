import type { Metadata } from "next";
import { MessageSquare, Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { AllowlistToggle, BlockForm, EmergencyControl, LinkCodeCard, PauseControl, ReplySettingsForm, UnblockButton } from "@/components/zalo-reply/reply-settings";
import { ERROR_LABEL } from "@/lib/zalo-reply/lifecycle";
import { requireReplyPage, unwrapReply } from "@/lib/zalo-reply/server";
import { getSettings } from "@/lib/zalo-reply/service";
import { formatDateTime } from "@/lib/ui/format";

export const metadata: Metadata = { title: "Zalo cá nhân — Cài đặt trả lời AI" };
export const dynamic = "force-dynamic";

const on = (b: boolean) => (b ? "BẬT" : "TẮT");

// PHASE 04.5 — Reply Settings: draft-only / auto, limits, allowlist, block list,
// pause, emergency stop, account linking. Enforced by the backend.
export default async function ReplySettingsPage() {
  // a staff member without Zalo data access may still link their own Zalo here
  const { actor, deps, linkOnly } = await requireReplyPage({ linkOnly: true });
  const s = unwrapReply(await getSettings(deps, actor));

  if (linkOnly) {
    return (
      <PageContainer>
        <PageHeader title="Liên kết Zalo với trợ lý" description="Liên kết tài khoản Zalo của bạn để nhắn hỏi trợ lý qua Zalo. Trợ lý trả lời theo đúng quyền của tài khoản CONGTRANGBEDDING này." />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Liên kết tài khoản Zalo của tôi</CardTitle>
          </CardHeader>
          <CardContent>{s.canLink ? <LinkCodeCard identities={s.identities} /> : <p className="text-sm text-muted-foreground">Vai trò của bạn chưa được dùng trợ lý nên không cần liên kết.</p>}</CardContent>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Cài đặt trả lời AI"
        description="Mặc định mọi câu trả lời chỉ là bản nháp chờ duyệt. Chỉ chủ kết nối đổi được cài đặt. Cờ hệ thống do quản trị cấu hình trên máy chủ."
        meta={
          <>
            <span>Trả lời AI: {on(s.flags.replyEnabled)}</span>
            <span>Gửi tin: {on(s.flags.sendEnabled)}</span>
            <span>Tự động gửi: {on(s.flags.autoReplyEnabled)}</span>
            <span>Giới hạn toàn hệ thống: {s.flags.globalDailyLimit} tin/ngày</span>
          </>
        }
      />
      <Callout tone="warning">
        Zalo cá nhân dùng thư viện không chính thức (không phải API của Zalo). Gửi tin tự động có thể khiến Zalo hạn chế hoặc khóa tài khoản. Khi Zalo từ chối, hệ thống tự tạm dừng gửi cho kết nối đó và không tìm cách vượt qua.
      </Callout>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dừng khẩn cấp</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {s.control.emergencyStop ? (
            <Callout tone="danger">
              Đang dừng khẩn cấp{s.control.changedAt ? ` từ ${formatDateTime(s.control.changedAt)}` : ""}
              {s.control.changedByName ? ` (${s.control.changedByName})` : ""}
              {s.control.reason ? `: ${s.control.reason}` : ""}.
            </Callout>
          ) : (
            <p className="text-muted-foreground">Dừng ngay mọi gửi tin của mọi kết nối. Ngoài ra có thể chạy `npm run stop` trên máy chạy worker, hoặc tắt ZP_SEND_ENABLED.</p>
          )}
          <div>
            <EmergencyControl stopped={s.control.emergencyStop} canResume={s.control.canResume} />
          </div>
        </CardContent>
      </Card>

      {s.connections.length === 0 && <Callout tone="info">Bạn không sở hữu kết nối Zalo cá nhân nào nên không có cài đặt để đổi.</Callout>}
      {s.connections.map((c) => (
        <Card key={c.connectionId}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
              <span>Kết nối {c.connectionKey}</span>
              <span className="text-sm font-normal text-muted-foreground">Đã gửi hôm nay: {c.sentToday}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-6">
            <div className="flex flex-wrap items-center gap-3">
              {c.settings.sendPaused ? (
                <Callout tone="warning">
                  Đang tạm dừng gửi ({ERROR_LABEL[c.settings.pausedReason ?? ""] ?? (c.settings.pausedReason === "owner_paused" ? "chủ tài khoản tạm dừng" : c.settings.pausedReason)}
                  {c.settings.pausedAt ? `, từ ${formatDateTime(c.settings.pausedAt)}` : ""}). Kiểm tra tài khoản Zalo trên điện thoại trước khi cho phép gửi lại.
                </Callout>
              ) : (
                <span className="text-sm text-muted-foreground">Gửi tin cho kết nối này: đang cho phép.</span>
              )}
              <PauseControl connectionId={c.connectionId} paused={c.settings.sendPaused} />
            </div>

            <ReplySettingsForm connectionId={c.connectionId} autoAvailable={s.flags.autoReplyEnabled} initial={{ replyMode: c.settings.replyMode, directEnabled: c.settings.directEnabled, unlinkedHelp: c.settings.unlinkedHelp, cooldownSeconds: c.settings.cooldownSeconds, perUserPerHour: c.settings.perUserPerHour, perGroupPerHour: c.settings.perGroupPerHour, dailySendLimit: c.settings.dailySendLimit, maxPerConversationPerDay: c.settings.maxPerConversationPerDay, draftTtlMinutes: c.settings.draftTtlMinutes }} />

            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">Nhóm được tự động trả lời</h3>
              <p className="text-sm text-muted-foreground">Danh sách này chỉ áp dụng cho nhóm: cần chế độ Tương tác (chỉ mở được sau khi một tin duyệt tay đã gửi thành công vào nhóm). Chat 1-1 với người đã liên kết được tự động trả lời mà không cần thêm vào đây, sau khi kết nối đã gửi thành công một tin duyệt tay.</p>
              {c.conversations.length === 0 ? (
                <p className="text-sm text-muted-foreground">Chưa có hội thoại nào.</p>
              ) : (
                <ul className="grid gap-1">
                  {c.conversations.slice(0, 50).map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                      <span className="inline-flex items-center gap-1.5">
                        {v.conversationType === "group" ? <Users aria-hidden="true" className="size-3.5 text-muted-foreground" /> : <MessageSquare aria-hidden="true" className="size-3.5 text-muted-foreground" />}
                        {v.title}
                        {v.conversationType === "group" && <span className="text-xs text-muted-foreground">· {v.groupMode === "interactive" ? "Tương tác" : v.groupMode === "mention_only" ? "Chỉ khi nhắc tên" : v.groupMode === "monitor" ? "Theo dõi" : "Tắt"}{v.groupSendVerified ? " · đã xác minh gửi" : ""}</span>}
                        {v.allowlisted && v.allowNote && <span className="text-xs text-muted-foreground">· {v.allowNote}</span>}
                      </span>
                      <AllowlistToggle connectionId={c.connectionId} conversationId={v.id} allowlisted={v.allowlisted} available={s.flags.autoReplyEnabled} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">Người gửi bị chặn (kể cả bot khác)</h3>
              <BlockForm connectionId={c.connectionId} />
              {c.blocks.length > 0 && (
                <ul className="grid gap-1">
                  {c.blocks.map((b) => (
                    <li key={b.externalUserId} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                      <span>
                        Zalo {b.label}
                        {b.note ? <span className="text-muted-foreground"> · {b.note}</span> : null}
                      </span>
                      <UnblockButton connectionId={c.connectionId} externalUserId={b.externalUserId} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Liên kết tài khoản Zalo của tôi</CardTitle>
        </CardHeader>
        <CardContent>{s.canLink ? <LinkCodeCard identities={s.identities} /> : <p className="text-sm text-muted-foreground">Vai trò của bạn chưa được dùng trợ lý nên không cần liên kết.</p>}</CardContent>
      </Card>
    </PageContainer>
  );
}
