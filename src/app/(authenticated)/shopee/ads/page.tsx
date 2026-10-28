import { Megaphone, Settings, Store } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { hasPermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { ADS_METRICS } from "@/lib/channels/shopee/ads/types";
import { getShopeeFlags } from "@/lib/feature-flags";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/ui/format";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const CONNECTION: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  connected: { label: "Đã kết nối", tone: "success" },
  error: { label: "Lỗi gần đây", tone: "warning" },
  expired: { label: "Cần kết nối lại", tone: "danger" },
  revoked: { label: "Cần kết nối lại", tone: "danger" },
  disconnected: { label: "Chưa kết nối", tone: "neutral" },
};

// SHOPEE-ADS-0: module shell only — no Ads API call, no Ads data yet.
export default async function ShopeeAdsPage() {
  if (!getShopeeFlags().adsEnabled) notFound();
  const auth = await requirePermission("channel:view");
  const { data } = await createAdminClient()
    .from("shops")
    .select("id, shop_name, is_active, shop_connections(connection_status, access_token_expires_at, last_token_refresh_at)")
    .eq("channel", "shopee")
    .eq("data_source", "live")
    .order("shop_name");
  const shops = (data ?? []) as Array<{ id: string; shop_name: string; is_active: boolean; shop_connections: Array<{ connection_status: string; access_token_expires_at: string | null; last_token_refresh_at: string | null }> | null }>;
  const canManage = hasPermission(auth.profile.role, "channel:manage");

  return (
    <PageContainer>
      <PageHeader
        title="Quảng cáo Shopee"
        description="Theo dõi chi phí và hiệu quả quảng cáo Shopee theo shop."
        actions={
          canManage ? (
            <Link href="/settings/shopee" className={buttonVariants({ variant: "outline" })}>
              <Settings aria-hidden="true" /> Kết nối shop
            </Link>
          ) : undefined
        }
      />
      <Callout tone="info" title="Đang chuẩn bị">
        Module quảng cáo đang được xây dựng — chưa đồng bộ dữ liệu quảng cáo từ Shopee. Kết nối shop bên dưới được giữ và tự làm mới để sẵn sàng.
      </Callout>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Store aria-hidden="true" className="size-4" /> Shop đã kết nối
          </CardTitle>
          <CardDescription>Dùng chung kết nối OAuth của Shopee (Cài đặt → Tích hợp Shopee).</CardDescription>
        </CardHeader>
        <CardContent>
          {shops.length === 0 ? (
            <EmptyState icon={Store} title="Chưa có shop Shopee nào được kết nối." />
          ) : (
            <ul className="divide-y">
              {shops.map((s) => {
                const conn = s.shop_connections?.[0];
                const info = CONNECTION[conn?.connection_status ?? "disconnected"] ?? CONNECTION.disconnected;
                return (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span className="font-medium">{s.shop_name}</span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      {conn?.last_token_refresh_at && <span>token làm mới {formatDateTime(conn.last_token_refresh_at)}</span>}
                      <StatusBadge tone={info.tone} icon={false}>
                        {info.label}
                      </StatusBadge>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone aria-hidden="true" className="size-4" /> Chỉ số sẽ theo dõi
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {ADS_METRICS.map((m) => (
              <li key={m.key}>
                <span className="font-medium">{m.label}</span> <span className="text-muted-foreground">— {m.note}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
