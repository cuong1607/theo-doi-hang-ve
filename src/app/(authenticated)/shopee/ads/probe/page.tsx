import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/session";
import { ADS_PROBE_ENDPOINTS, ADS_PROBE_MAX_REQUESTS } from "@/lib/channels/shopee/ads/probe";
import { adsProbeEnvironment, listAdsProbeShops } from "@/lib/channels/shopee/ads/probe-server";
import { getShopeeFlags } from "@/lib/feature-flags";
import { Callout } from "@/components/patterns/callout";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";

import { AdsProbePanel } from "./probe-panel";

export const dynamic = "force-dynamic";
// baseline ~12, expansion up to 30 sequential provider calls with a 1 s gap.
export const maxDuration = 120;

// SHOPEE-ADS-1A: admin-only, explicitly triggered READ-ONLY probe of the
// Shopee Ads API for ONE connected shop. Not linked from the navigation.
export default async function AdsProbePage() {
  if (!getShopeeFlags().adsEnabled) notFound();
  await requirePermission("channel:manage");
  const shops = await listAdsProbeShops();
  const base = process.env.SHOPEE_API_BASE_URL?.trim() || "https://partner.shopeemobile.com";
  const environment = adsProbeEnvironment(base);

  return (
    <PageContainer>
      <PageHeader title="Probe Shopee Ads (chỉ đọc)" description="Gọi thử API Quảng cáo Shopee thật cho MỘT shop để lấy payload mẫu. Không lưu vào hệ thống, không đổi gì trên Shopee." />
      <Callout tone="warning" title={`Môi trường: ${environment === "production" ? "PRODUCTION" : "SANDBOX"} · Chế độ: CHỈ ĐỌC`}>
        Tối đa {ADS_PROBE_MAX_REQUESTS} request mỗi lượt, gọi tuần tự cách nhau 1 giây, tự dừng khi lỗi lặp lại. Chỉ {Object.keys(ADS_PROBE_ENDPOINTS).length} endpoint GET trong allowlist —
        chỉ ĐỌC chiến dịch, giá thầu và ngân sách; không ghi bất cứ thứ gì lên Shopee. Kết quả đã che token, tên chiến dịch / sản phẩm và ID.
      </Callout>
      <AdsProbePanel shops={shops.map((s) => ({ id: s.id, name: s.shopName, status: s.connectionStatus }))} />
    </PageContainer>
  );
}
