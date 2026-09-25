import { AlertTriangle, CheckCircle2, MessageCircle } from "lucide-react";

import { canManageIntegrations, getCurrentRole } from "@/lib/auth/role";
import { getZaloConnectionStatus } from "@/lib/zalo/token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { SendTestMessageButton } from "./send-test-message-button";

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
  const canManage = canManageIntegrations(getCurrentRole());
  const status = await getZaloConnectionStatus();
  // A manual ZALO_ACCESS_TOKEN (Phần 3/6 test bootstrap) also lets the test
  // button work even before OAuth has ever completed — see
  // getValidZaloAccessToken()'s fallback in src/lib/zalo/token.ts.
  const canSendTest = status.connected || !!process.env.ZALO_ACCESS_TOKEN;

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
            <div className="flex flex-wrap gap-2">
              <Button nativeButton={false} render={<a href="/api/zalo/oauth/start" />}>
                Kết nối Zalo
              </Button>
              <SendTestMessageButton disabled={!canSendTest} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
