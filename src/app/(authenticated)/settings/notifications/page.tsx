import { AlertTriangle, CheckCircle2, MessageCircle, Users } from "lucide-react";

import { canManageIntegrations, canManageNotificationRecipients, getCurrentRole } from "@/lib/auth/role";
import { getZaloConnectionStatus } from "@/lib/zalo/token";
import { getAllNotificationRecipients } from "@/lib/notifications/recipients";
import { getRecentNotificationLogs } from "@/lib/notifications/logs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { SendTestMessageButton } from "./send-test-message-button";
import { CreateRecipientButton } from "./create-recipient-button";
import { RecipientRowActions } from "./recipient-row-actions";
import { SendTestAllButton } from "./send-test-all-button";
import { SendDailySummaryButton } from "./send-daily-summary-button";

const RECENT_LOGS_LIMIT = 20;

const LOG_STATUS_LABELS: Record<string, string> = {
  pending: "Đang gửi",
  sent: "Thành công",
  failed: "Thất bại",
  skipped: "Bỏ qua",
};

const LOG_STATUS_BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  sent: "outline",
  failed: "destructive",
  skipped: "secondary",
};

function formatDateTimeVN(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Shows enough of an OA id to recognize it without fully exposing it —
// e.g. an id like "1234567890123" renders as "12•••••••123". Never renders
// the raw ZALO_APP_SECRET/tokens anywhere on this page.
function maskId(id: string): string {
  if (id.length <= 6) return "••••••";
  return `${id.slice(0, 2)}${"•".repeat(Math.max(3, id.length - 5))}${id.slice(-3)}`;
}

const ERROR_REASON_LABELS: Record<string, string> = {
  forbidden: "Bạn không có quyền kết nối Zalo OA.",
  missing_code_or_state: "Thiếu authorization code hoặc state từ Zalo.",
  state_mismatch: "State không khớp — vui lòng thử kết nối lại từ đầu.",
  save_failed: "Lấy token thành công nhưng không lưu được — vui lòng thử lại.",
};

function errorLabel(reason: string | undefined): string {
  if (!reason) return "Kết nối Zalo thất bại.";
  if (reason.startsWith("zalo_")) return `Zalo từ chối cấp quyền (${reason.slice("zalo_".length)}).`;
  if (reason.startsWith("exchange_failed_")) {
    return `Không đổi được token (mã lỗi Zalo: ${reason.slice("exchange_failed_".length)}).`;
  }
  return ERROR_REASON_LABELS[reason] ?? "Kết nối Zalo thất bại.";
}

// force-dynamic: the connection status is read fresh from the DB and the
// `?zalo=connected|error` banner is driven by the OAuth callback's redirect
// query params — this must never be statically cached.
export const dynamic = "force-dynamic";

export default async function NotificationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ zalo?: string; reason?: string }>;
}) {
  const params = await searchParams;
  const role = getCurrentRole();
  const canManage = canManageIntegrations(role);
  const canManageRecipients = canManageNotificationRecipients(role);
  const status = await getZaloConnectionStatus();
  // A manual ZALO_ACCESS_TOKEN (Phần 3/6 test bootstrap) also lets the test
  // button work even before OAuth has ever completed — see
  // getValidZaloAccessToken()'s fallback in src/lib/zalo/token.ts.
  const canSendTest = status.connected || !!process.env.ZALO_ACCESS_TOKEN;

  const [{ rows: recipients, error: recipientsError }, { rows: logs, error: logsError }] = await Promise.all([
    getAllNotificationRecipients(),
    getRecentNotificationLogs(RECENT_LOGS_LIMIT),
  ]);
  const hasActiveRecipient = recipients.some((r) => r.isActive);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Cài đặt thông báo</h2>
        <p className="text-muted-foreground">Kết nối Zalo Official Account để gửi thông báo hệ thống.</p>
      </div>

      {params.zalo === "connected" && (
        <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <span>Đã kết nối Zalo OA thành công.</span>
        </div>
      )}
      {params.zalo === "error" && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{errorLabel(params.reason)}</span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            Kết nối Zalo OA
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div className="space-y-0.5">
              <p className="text-muted-foreground">Trạng thái kết nối</p>
              <Badge variant={status.connected ? "outline" : "destructive"}>
                {status.connected ? "Đã kết nối" : "Chưa kết nối"}
              </Badge>
            </div>
            <div className="space-y-0.5">
              <p className="text-muted-foreground">OA ID</p>
              <p className="font-mono font-medium">{status.oaId ? maskId(status.oaId) : "—"}</p>
            </div>
          </div>

          {!canManage && (
            <p className="text-sm text-muted-foreground">
              Chỉ admin mới có thể kết nối hoặc gửi tin nhắn thử qua Zalo OA.
            </p>
          )}

          {canManage && (
            <div className="space-y-1">
              <div className="flex flex-wrap gap-2">
                <Button nativeButton={false} render={<a href="/api/zalo/oauth/start" />}>
                  Kết nối Zalo
                </Button>
                <SendTestMessageButton disabled={!canSendTest} />
              </div>
              <p className="text-xs text-muted-foreground">
                &quot;Gửi tin nhắn thử&quot; ở trên chỉ kiểm tra kết nối OA (gửi tới{" "}
                <code className="font-mono">ZALO_TEST_RECIPIENT_ID</code>). Để gửi cho danh sách người nhận thật, dùng
                &quot;Gửi tin thử cho tất cả&quot; ở mục bên dưới.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4" />
            Người nhận thông báo Zalo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              Tất cả người nhận đang hoạt động sẽ nhận cùng một thông báo khi hệ thống gửi tin.
            </p>
            {canManageRecipients && <CreateRecipientButton />}
          </div>

          {recipientsError ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <AlertTriangle className="size-6 text-destructive" />
              <p className="text-sm">Đã xảy ra lỗi khi tải danh sách người nhận.</p>
            </div>
          ) : recipients.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Chưa có người nhận nào.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tên</TableHead>
                    <TableHead>Zalo UID</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    {canManageRecipients && <TableHead className="text-right">Thao tác</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recipients.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="font-mono text-xs">{r.zaloUid}</TableCell>
                      <TableCell>
                        <Badge variant={r.isActive ? "outline" : "secondary"}>
                          {r.isActive ? "Đang hoạt động" : "Đã tắt"}
                        </Badge>
                      </TableCell>
                      {canManageRecipients && (
                        <TableCell className="text-right">
                          <RecipientRowActions recipient={r} />
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {canManageRecipients && (
            <div className="space-y-4 border-t pt-4">
              <div>
                <SendTestAllButton disabled={!hasActiveRecipient} />
                {!hasActiveRecipient && (
                  <p className="mt-1 text-xs text-muted-foreground">Thêm ít nhất 1 người nhận đang hoạt động để gửi thử.</p>
                )}
              </div>
              <div>
                <SendDailySummaryButton disabled={!hasActiveRecipient} />
                <p className="mt-1 text-xs text-muted-foreground">
                  Tổng hợp hàng về hôm nay (theo giờ Việt Nam) và gửi cho tất cả người nhận đang hoạt động — dùng để
                  test thủ công trước khi có cron tự động.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lịch sử gửi gần đây</CardTitle>
        </CardHeader>
        <CardContent>
          {logsError ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <AlertTriangle className="size-6 text-destructive" />
              <p className="text-sm">Đã xảy ra lỗi khi tải lịch sử gửi.</p>
            </div>
          ) : logs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Chưa có thông báo nào được gửi.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Thời gian</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Người nhận</TableHead>
                    <TableHead>Nội dung</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Lỗi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap text-sm">{formatDateTimeVN(log.createdAt)}</TableCell>
                      <TableCell className="text-sm">{log.eventType}</TableCell>
                      <TableCell className="text-sm">{log.recipientName ?? log.recipientZaloUid}</TableCell>
                      <TableCell className="max-w-[240px] text-sm">{truncate(log.messageText, 60)}</TableCell>
                      <TableCell>
                        <Badge variant={LOG_STATUS_BADGE_VARIANT[log.status]}>
                          {LOG_STATUS_LABELS[log.status] ?? log.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[200px] text-xs text-destructive">
                        {log.providerErrorMessage ? truncate(log.providerErrorMessage, 60) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
