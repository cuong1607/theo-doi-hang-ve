import { AlertTriangle, CheckCircle2, Eye, MessageCircle, Users } from "lucide-react";
import { requirePermission } from "@/lib/auth/session";

import { canManageIntegrations, canManageNotificationRecipients } from "@/lib/auth/role";
import { getZaloConnectionStatus, type ZaloTokenStatus } from "@/lib/zalo/token";
import { categorizeZaloError, ZALO_ERROR_CATEGORY_LABELS } from "@/lib/zalo/error-category";
import { getAllNotificationRecipients } from "@/lib/notifications/recipients";
import { getNotificationLogs, type NotificationLogStatus } from "@/lib/notifications/logs";
import { previewLowStockAlerts } from "@/lib/notifications/outstanding-alert-preview";
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
import { SendDailyPaymentSummaryButton } from "./send-daily-payment-summary-button";
import { LogFilters } from "./log-filters";
import { RetryLogButton } from "./retry-log-button";

const RECENT_LOGS_LIMIT = 50;

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

const TOKEN_STATUS_LABELS: Record<ZaloTokenStatus, string> = {
  valid: "Valid",
  expired: "Expired",
  refresh_failed: "Refresh failed",
  not_connected: "—",
};

const TOKEN_STATUS_BADGE_VARIANT: Record<ZaloTokenStatus, "default" | "secondary" | "destructive" | "outline"> = {
  valid: "outline",
  expired: "destructive",
  refresh_failed: "destructive",
  not_connected: "secondary",
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
  searchParams: Promise<{
    zalo?: string;
    reason?: string;
    logDate?: string;
    logEvent?: string;
    logRecipient?: string;
    logStatus?: string;
  }>;
}) {
  const auth = await requirePermission("notification:manage");
  const params = await searchParams;
  const role = auth.profile.role;
  const canManage = canManageIntegrations(role);
  const canManageRecipients = canManageNotificationRecipients(role);
  const status = await getZaloConnectionStatus();
  // A manual ZALO_ACCESS_TOKEN (Phần 3/6 test bootstrap) also lets the test
  // button work even before OAuth has ever completed — see
  // getValidZaloAccessToken()'s fallback in src/lib/zalo/token.ts.
  const canSendTest = status.connected || !!process.env.ZALO_ACCESS_TOKEN;

  const [{ rows: recipients, error: recipientsError }, { rows: logs, error: logsError }, lowStockPreview] = await Promise.all([
    getAllNotificationRecipients(),
    getNotificationLogs(
      {
        date: params.logDate,
        eventType: params.logEvent,
        recipientId: params.logRecipient,
        status: params.logStatus as NotificationLogStatus | undefined,
      },
      RECENT_LOGS_LIMIT
    ),
    previewLowStockAlerts(),
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
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-0.5">
              <p className="text-muted-foreground">Zalo OA</p>
              <Badge variant={status.connectionHealth === "connected" ? "outline" : "destructive"}>
                {status.connectionHealth === "not_connected" ? "Chưa kết nối" : status.connectionHealth === "connected" ? "Đã kết nối" : "Cần kết nối lại"}
              </Badge>
            </div>
            <div className="space-y-0.5">
              <p className="text-muted-foreground">Token</p>
              <Badge variant={TOKEN_STATUS_BADGE_VARIANT[status.tokenStatus]}>{TOKEN_STATUS_LABELS[status.tokenStatus]}</Badge>
            </div>
            <div className="space-y-0.5">
              <p className="text-muted-foreground">OA ID</p>
              <p className="font-mono font-medium">{status.oaId ? maskId(status.oaId) : "—"}</p>
            </div>
            <div className="space-y-0.5">
              <p className="text-muted-foreground">Lần làm mới token gần nhất</p>
              <p className="font-medium">{status.lastRefreshAt ? formatDateTimeVN(status.lastRefreshAt) : "—"}</p>
            </div>
          </div>

          {status.tokenStatus === "refresh_failed" && status.lastRefreshErrorMessage && (
            <p className="text-xs text-destructive">
              Lần làm mới token gần nhất thất bại{status.lastRefreshErrorCode ? ` (mã lỗi: ${status.lastRefreshErrorCode})` : ""}:{" "}
              {status.lastRefreshErrorMessage}
            </p>
          )}

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
              Tất cả người nhận đang hoạt động sẽ nhận cùng một thông báo khi hệ thống gửi tin. Dùng &quot;Gửi
              thử&quot; ở menu thao tác để test riêng 1 người.
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
              <div>
                <SendDailyPaymentSummaryButton disabled={!hasActiveRecipient} />
                <p className="mt-1 text-xs text-muted-foreground">
                  Tổng hợp thanh toán hôm nay (theo giờ Việt Nam) và gửi cho tất cả người nhận đang hoạt động — dùng để
                  test thủ công trước khi có cron tự động.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {canManageRecipients && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="size-4" />
              Xem trước cảnh báo hàng còn phải về
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Xem trước nội dung sẽ được gửi nếu có SKU đang ở trạng thái &quot;Sắp hết&quot;/&quot;Cần xuất bù&quot;
              ngay bây giờ — chỉ đọc, không gửi tin thật và không thay đổi dữ liệu.
            </p>
            {lowStockPreview.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Hiện không có SKU nào cần cảnh báo (mọi SKU đang ở trạng thái bình thường).
              </p>
            ) : (
              <div className="space-y-3">
                {lowStockPreview.map((p) => (
                  <div key={p.supplierId} className="rounded-md border p-3">
                    <p className="mb-2 text-xs text-muted-foreground">
                      {p.supplierName} — {p.itemCount} SKU
                    </p>
                    <pre className="overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{p.message}</pre>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Lịch sử gửi gần đây</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <LogFilters
            date={params.logDate ?? ""}
            eventType={params.logEvent ?? ""}
            recipientId={params.logRecipient ?? ""}
            status={params.logStatus ?? ""}
            recipients={recipients.map((r) => ({ id: r.id, name: r.name }))}
          />

          {logsError ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <AlertTriangle className="size-6 text-destructive" />
              <p className="text-sm">Đã xảy ra lỗi khi tải lịch sử gửi.</p>
            </div>
          ) : logs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Không có thông báo nào khớp bộ lọc.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Thời gian</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Người nhận</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Nội dung</TableHead>
                    <TableHead>Error code</TableHead>
                    <TableHead>Error message</TableHead>
                    {canManageRecipients && <TableHead className="text-right">Thao tác</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap text-sm">{formatDateTimeVN(log.createdAt)}</TableCell>
                      <TableCell className="text-sm">{log.eventType}</TableCell>
                      <TableCell className="text-sm">{log.recipientName ?? log.recipientZaloUid}</TableCell>
                      <TableCell>
                        <Badge variant={LOG_STATUS_BADGE_VARIANT[log.status]}>
                          {LOG_STATUS_LABELS[log.status] ?? log.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[240px] text-sm">{truncate(log.messageText, 60)}</TableCell>
                      <TableCell className="text-xs">
                        {log.providerErrorCode ? (
                          <span title={ZALO_ERROR_CATEGORY_LABELS[categorizeZaloError(log.providerErrorCode)]}>
                            {log.providerErrorCode}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px] text-xs text-destructive">
                        {log.providerErrorMessage ? truncate(log.providerErrorMessage, 60) : "—"}
                      </TableCell>
                      {canManageRecipients && (
                        <TableCell className="text-right">{log.status === "failed" && <RetryLogButton logId={log.id} />}</TableCell>
                      )}
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
