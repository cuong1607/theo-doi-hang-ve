import { requirePermission } from "@/lib/auth/session";
import { adsProbeEnvironment, listAdsProbeShops } from "@/lib/channels/shopee/ads/probe-server";
import { PRODUCT_ANALYTICS_DISCOVERY_MAX_ITEMS, PRODUCT_ANALYTICS_DISCOVERY_MAX_REQUESTS } from "@/lib/channels/shopee/product-analytics/read-only-policy";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";

import { ProductAnalyticsProbePanel } from "./probe-panel";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// SHOPEE-PRODUCT-ANALYTICS-1: admin-only, explicitly triggered READ-ONLY probe
// of the Shopee product counters for ≤ 10 items of ONE shop. Not linked from
// the navigation.
export default async function ProductAnalyticsProbePage() {
  await requirePermission("channel:manage");
  const shops = await listAdsProbeShops();
  const environment = adsProbeEnvironment(process.env.SHOPEE_API_BASE_URL?.trim() || "https://partner.shopeemobile.com");

  return (
    <PageContainer>
      <PageHeader title="Probe chỉ số sản phẩm Shopee (chỉ đọc)" description="Gọi thử get_item_extra_info cho vài sản phẩm và đặt cạnh số liệu đơn hàng / quảng cáo nội bộ. Không đổi gì trên Shopee." />
      <Callout tone="warning" title={`Môi trường: ${environment === "production" ? "PRODUCTION" : "SANDBOX"} · Chế độ: CHỈ ĐỌC`}>
        Tối đa {PRODUCT_ANALYTICS_DISCOVERY_MAX_ITEMS} sản phẩm, {PRODUCT_ANALYTICS_DISCOVERY_MAX_REQUESTS} request mỗi lượt (thực tế 2: 1 đường kiểm soát + 1 lần đọc), chỉ GET. Kết quả được lưu 1 bản ghi
        snapshot để đối chiếu; không ghi gì lên Shopee.
      </Callout>
      <ProductAnalyticsProbePanel shops={shops.map((s) => ({ id: s.id, name: s.shopName, status: s.connectionStatus }))} />
    </PageContainer>
  );
}
