import { AlertTriangle, CheckCircle2, Store } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { listShops } from "@/lib/channels/core/queries";
import type { ConnectionStatus } from "@/lib/channels/core/types";
import { getShopeeConfig, ShopeeConfigError } from "@/lib/channels/shopee/config";
import { getShopeeConnectionHealth, type ShopeeConnectionHealth, type TokenStatus } from "@/lib/channels/shopee/token";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { DisconnectButton } from "./disconnect-button";
import { TestConnectionButton } from "./test-connection-button";

// Connection state is read fresh on every visit and the ?shopee=… banner
// comes from the OAuth callback redirect — never cache this page.
export const dynamic = "force-dynamic";

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connected: "Đã kết nối",
  disconnected: "Chưa kết nối",
  expired: "Hết hạn — cần kết nối lại",
  revoked: "Đã bị thu hồi — cần kết nối lại",
  error: "Lỗi",
};

const CONNECTION_VARIANT: Record<ConnectionStatus, "default" | "secondary" | "destructive" | "outline"> = {
  connected: "outline",
  disconnected: "secondary",
  expired: "destructive",
  revoked: "destructive",
  error: "destructive",
};

const TOKEN_LABELS: Record<TokenStatus, string> = {
  valid: "Còn hạn",
  expiring_soon: "Sắp hết hạn (tự làm mới khi gọi API)",
  expired: "Đã hết hạn (tự làm mới khi gọi API)",
  missing: "Chưa có",
};

const REASON_LABELS: Record<string, string> = {
  forbidden: "Bạn không có quyền kết nối Shopee.",
  state_mismatch: "Phiên kết nối không hợp lệ hoặc đã hết hạn (state không khớp) — hãy bấm kết nối lại từ đầu.",
  missing_code_or_shop: "Shopee không trả về code / shop_id.",
  main_account_not_supported: "Bạn đã ủy quyền bằng tài khoản chính (main account) — phase thí điểm chỉ hỗ trợ ủy quyền từng shop.",
  config: "Thiếu hoặc sai cấu hình Shopee trên server (xem mục Cấu hình bên dưới).",
  start_failed: "Không khởi tạo được liên kết ủy quyền Shopee.",
  save_failed: "Đổi token thành công nhưng không lưu được — vui lòng thử lại.",
};

function reasonLabel(reason: string | undefined): string {
  if (!reason) return "Kết nối Shopee thất bại.";
  if (reason.startsWith("exchange_failed_")) {
    return `Shopee từ chối đổi token (mã lỗi: ${reason.slice("exchange_failed_".length)}).`;
  }
  return REASON_LABELS[reason] ?? "Kết nối Shopee thất bại.";
}

const dateTimeFormat = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDateTime(iso: string | null): string {
  return iso ? dateTimeFormat.format(new Date(iso)) : "—";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[220px_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export default async function ShopeeSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ shopee?: string; reason?: string }>;
}) {
  await requirePermission("channel:manage");
  const params = await searchParams;

  let configProblems: string[] = [];
  try {
    getShopeeConfig();
  } catch (err) {
    configProblems = err instanceof ShopeeConfigError ? err.problems : ["Cấu hình Shopee không hợp lệ."];
  }

  const shops = (await listShops()).filter((shop) => shop.channel === "shopee");
  const db = createAdminClient();
  const healths = new Map<string, ShopeeConnectionHealth>(
    await Promise.all(shops.map(async (shop) => [shop.id, await getShopeeConnectionHealth(db, shop.id)] as const)),
  );
  const canConnect = configProblems.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Tích hợp Shopee</h1>
        <p className="text-sm text-muted-foreground">
          Kết nối / kết nối lại / ngắt kết nối các shop Shopee. Kết nối này được dùng cho module Quảng cáo Shopee; token được tự làm mới định kỳ.
        </p>
        {shops.length > 0 && (
          <div className="mt-3">
            <ConnectButton disabled={!canConnect} label="Kết nối thêm shop" variant="outline" />
          </div>
        )}
      </div>

      {params.shopee === "connected" || params.shopee === "reconnected" ? (
        <p className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          <CheckCircle2 className="size-4" />
          {params.shopee === "connected" ? "Đã kết nối shop Shopee." : "Đã kết nối lại shop Shopee."}
        </p>
      ) : null}
      {params.shopee === "error" ? (
        <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="size-4" />
          {reasonLabel(params.reason)}
        </p>
      ) : null}

      {configProblems.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-destructive" /> Cấu hình chưa đầy đủ
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="list-disc pl-5">
              {configProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
            <p className="text-muted-foreground">Xem docs/shopee-auth-runbook.md để cấu hình biến môi trường.</p>
          </CardContent>
        </Card>
      ) : null}

      {shops.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Store className="size-4" /> Shop: <Badge variant="secondary">Chưa kết nối</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ConnectButton disabled={!canConnect} label="Kết nối shop Shopee" />
          </CardContent>
        </Card>
      ) : (
        shops.map((shop) => {
          const health = healths.get(shop.id)!;
          const needsReconnect = health.connectionStatus !== "connected";
          return (
            <Card key={shop.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  <Store className="size-4" /> {shop.shopName}
                  <Badge variant={CONNECTION_VARIANT[health.connectionStatus]}>
                    {CONNECTION_LABELS[health.connectionStatus]}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="space-y-2">
                  <Row label="External Shop ID">{shop.externalShopId}</Row>
                  <Row label="Khu vực">{shop.region ?? "—"}</Row>
                  <Row label="Access token hết hạn lúc">
                    {formatDateTime(health.expiresAt)} · {TOKEN_LABELS[health.tokenStatus]}
                  </Row>
                  <Row label="Làm mới token gần nhất">{formatDateTime(health.lastRefreshAt)}</Row>
                  <Row label="Gọi API thành công gần nhất">{formatDateTime(health.lastSuccessfulApiCallAt)}</Row>
                  {health.lastError ? (
                    <Row label="Lỗi gần nhất">
                      <span className="text-destructive">
                        [{health.lastError.code ?? "?"}] {health.lastError.message ?? ""}
                      </span>{" "}
                      <span className="text-muted-foreground">({formatDateTime(health.lastError.at)})</span>
                    </Row>
                  ) : null}
                </dl>
                <div className="flex flex-wrap items-start gap-3">
                  <ConnectButton
                    disabled={!canConnect}
                    label={needsReconnect ? "Kết nối lại" : "Kết nối lại (ủy quyền lại)"}
                    variant={needsReconnect ? "primary" : "outline"}
                  />
                  <TestConnectionButton shopId={shop.id} disabled={!canConnect || health.tokenStatus === "missing"} />
                  {health.connectionStatus !== "disconnected" && <DisconnectButton shopId={shop.id} shopName={shop.shopName} />}
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      <p className="text-xs text-muted-foreground">
        Token truy cập được mã hóa và chỉ dùng phía server; trang này không bao giờ hiển thị token, partner key hay khóa mã hóa.
      </p>
    </div>
  );
}

// A plain link (full navigation) — the route handler answers with a redirect to Shopee.
function ConnectButton({
  disabled,
  label,
  variant = "primary",
}: {
  disabled: boolean;
  label: string;
  variant?: "primary" | "outline";
}) {
  const base = "inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors";
  const style =
    variant === "primary"
      ? "bg-primary text-primary-foreground hover:bg-primary/90"
      : "border border-input bg-background hover:bg-accent";
  if (disabled) {
    return <span className={`${base} ${style} pointer-events-none opacity-50`}>{label}</span>;
  }
  return (
    <a href="/api/shopee/auth/start" className={`${base} ${style}`}>
      {label}
    </a>
  );
}
