"use client";

// SHOPEE-ADS-2: background Ads sync per shop (admins). Shows the rollout
// switch, the stagger offset inside each 15-minute window, campaign count and
// the HOT SLA of the last 24 h. The switch only decides whether the scheduler
// ENQUEUES read jobs for the shop (and only while ADS_AUTO_SYNC_ENABLED=true);
// it never touches campaigns on Shopee.
// ADS-3A.2: product metadata cache per shop (items enriched / referenced,
// pending) + its rollout switch and an admin re-read — READ ONLY, queue only.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { AdsShopSyncOverview } from "@/lib/channels/shopee/ads/schedule";
import type { AdsHourlyReconciliationStatus } from "@/lib/channels/shopee/ads/view-models";
import { refreshAdsProductInfoAction, toggleAdsAutoSyncAction, toggleAdsHourlySyncAction, toggleAdsProductEnrichmentAction } from "@/app/(authenticated)/shopee/ads/actions";
import { toast } from "@/components/patterns/toast";
import { Button } from "@/components/ui/button";

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const m = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
  return m < 1 ? "vừa xong" : m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.floor(m / 60)} giờ trước` : `${Math.floor(m / 1440)} ngày trước`;
}

const secs = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const RECON_LABEL: Record<AdsHourlyReconciliationStatus, { text: string; cls: string }> = {
  MATCH: { text: "Khớp", cls: "text-success-text" },
  ROUNDING_DIFFERENCE: { text: "Lệch làm tròn", cls: "text-success-text" },
  MISMATCH: { text: "Lệch", cls: "text-danger-text" },
  INSUFFICIENT_DATA: { text: "Thiếu dữ liệu", cls: "text-warning-text" },
  IN_PROGRESS: { text: "Đang cập nhật", cls: "text-muted-foreground" },
};

export function AdsAutoSyncPanel({
  rows,
  globalEnabled,
  hourlyGlobalEnabled,
  productGlobalEnabled = false,
  serverNow,
}: {
  rows: AdsShopSyncOverview[];
  globalEnabled: boolean;
  hourlyGlobalEnabled: boolean;
  productGlobalEnabled?: boolean;
  serverNow: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.parse(serverNow);

  const toggleHourly = (row: AdsShopSyncOverview) => {
    setBusy(`h:${row.shopId}`);
    start(async () => {
      const r = await toggleAdsHourlySyncAction({ shopId: row.shopId, enabled: !row.hourly.enabled });
      setBusy(null);
      if (r.ok) toast.success(r.message, hourlyGlobalEnabled ? "Dữ liệu theo giờ của hôm nay được đọc cùng nhịp HOT 15 phút (ưu tiên thấp hơn số liệu ngày)." : "ADS_HOURLY_SYNC_ENABLED đang tắt — chưa có job theo giờ nào được tạo.");
      else toast.error("Không đổi được cấu hình", r.message);
      router.refresh();
    });
  };

  const toggleProducts = (row: AdsShopSyncOverview) => {
    setBusy(`p:${row.shopId}`);
    start(async () => {
      const r = await toggleAdsProductEnrichmentAction({ shopId: row.shopId, enabled: !row.products?.enabled });
      setBusy(null);
      if (r.ok) toast.success(r.message, productGlobalEnabled ? "Chỉ sản phẩm đang được quảng cáo, chỉ khi chưa có hoặc đã cũ; ưu tiên thấp hơn mọi số liệu quảng cáo." : "ADS_PRODUCT_ENRICHMENT_ENABLED đang tắt — chưa có job nào được tạo.");
      else toast.error("Không đổi được cấu hình", r.message);
      router.refresh();
    });
  };

  const refreshProducts = (row: AdsShopSyncOverview) => {
    setBusy(`pr:${row.shopId}`);
    start(async () => {
      const r = await refreshAdsProductInfoAction({ shopId: row.shopId });
      setBusy(null);
      if (r.ok) toast.success(r.message, "Đọc lại tên / ảnh / SKU của mọi sản phẩm đang quảng cáo (chỉ đọc).");
      else toast.error("Không làm mới được", r.message);
      router.refresh();
    });
  };

  const toggle = (row: AdsShopSyncOverview) => {
    setBusy(row.shopId);
    start(async () => {
      const r = await toggleAdsAutoSyncAction({ shopId: row.shopId, enabled: !row.enabled });
      setBusy(null);
      if (r.ok) toast.success(r.message, globalEnabled ? "Lịch HOT 15 phút / WARM mỗi giờ / COLD 03:00 & 15:00 có hiệu lực từ nhịp kế tiếp." : "ADS_AUTO_SYNC_ENABLED đang tắt — chưa có job nền nào được tạo.");
      else toast.error("Không đổi được cấu hình", r.message);
      router.refresh();
    });
  };

  return (
    <div className="mt-4 space-y-2" data-slot="ads-auto-sync">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Đồng bộ nền (chỉ đọc)</p>
        <div className="flex flex-wrap gap-1.5">
          <span className={globalEnabled ? "rounded-full border border-success/30 bg-success-soft px-2.5 py-0.5 text-xs text-success-text" : "rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"}>
            {globalEnabled ? "Bộ lập lịch Ads: đang bật" : "Bộ lập lịch Ads: đang tắt (ADS_AUTO_SYNC_ENABLED)"}
          </span>
          <span data-slot="ads-hourly-global" className={hourlyGlobalEnabled ? "rounded-full border border-success/30 bg-success-soft px-2.5 py-0.5 text-xs text-success-text" : "rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"}>
            {hourlyGlobalEnabled ? "Theo giờ: đang bật" : "Theo giờ: đang tắt (ADS_HOURLY_SYNC_ENABLED)"}
          </span>
          <span data-slot="ads-products-global" className={productGlobalEnabled ? "rounded-full border border-success/30 bg-success-soft px-2.5 py-0.5 text-xs text-success-text" : "rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"}>
            {productGlobalEnabled ? "Thông tin SP: đang bật" : "Thông tin SP: đang tắt (ADS_PRODUCT_ENRICHMENT_ENABLED)"}
          </span>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-ads-border">
        <table className="w-full min-w-[1100px] text-xs">
          <thead className="bg-ads-surface text-left text-ads-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Shop</th>
              <th className="px-3 py-2 font-medium">Phút lệch</th>
              <th className="px-3 py-2 text-right font-medium">Chiến dịch</th>
              <th className="px-3 py-2 font-medium">Tổng shop hôm nay</th>
              <th className="px-3 py-2 font-medium">Chiến dịch hôm nay</th>
              <th className="px-3 py-2 text-right font-medium">HOT 24h (lỗi)</th>
              <th className="px-3 py-2 text-right font-medium">p95 chờ / tổng</th>
              <th className="px-3 py-2" />
              <th className="border-l border-ads-border px-3 py-2 font-medium">Theo giờ hôm nay</th>
              <th className="px-3 py-2 text-right font-medium">Giờ 24h (gọi API)</th>
              <th className="px-3 py-2 font-medium">Đối chiếu hôm qua</th>
              <th className="px-3 py-2" />
              <th className="border-l border-ads-border px-3 py-2 text-right font-medium">Thông tin SP (đủ / tổng · chờ)</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.shopId} className="border-t border-ads-border" data-shop={r.shopId} data-enabled={r.enabled}>
                <td className="px-3 py-2 font-medium">{r.shopName}</td>
                <td className="px-3 py-2 tabular-nums">{r.enabled && r.offsetMinutes !== null ? `:${String(r.offsetMinutes).padStart(2, "0")} +15′` : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.campaigns}</td>
                <td className="px-3 py-2 tabular-nums">{ago(r.shopTodayAt, now)}</td>
                <td className="px-3 py-2 tabular-nums">{ago(r.campaignTodayAt, now)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.hot.runs}
                  {r.hot.failed > 0 ? <span className="text-danger-text"> ({r.hot.failed})</span> : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {secs(r.hot.p95QueueWaitMs)} / {secs(r.hot.p95TotalMs)}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button type="button" size="sm" variant={r.enabled ? "outline" : "default"} disabled={pending} aria-busy={busy === r.shopId} onClick={() => toggle(r)}>
                    {r.enabled ? "Tắt tự động" : "Bật tự động"}
                  </Button>
                </td>
                <td className="border-l border-ads-border px-3 py-2 tabular-nums" data-hourly-enabled={r.hourly.enabled}>
                  {r.hourly.enabled ? ago(r.hourly.lastSyncedAt, now) : <span className="text-muted-foreground">Tắt</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.hourly.runs}
                  {r.hourly.failed > 0 ? <span className="text-danger-text"> ({r.hourly.failed})</span> : null} · {r.hourly.apiCalls} · {secs(r.hourly.p95TotalMs)}
                </td>
                <td className="px-3 py-2">{r.hourly.reconciliation ? <span className={RECON_LABEL[r.hourly.reconciliation].cls}>{RECON_LABEL[r.hourly.reconciliation].text}</span> : "—"}</td>
                <td className="px-3 py-2 text-right">
                  <Button type="button" size="sm" variant="outline" disabled={pending} aria-busy={busy === `h:${r.shopId}`} onClick={() => toggleHourly(r)} data-action="toggle-hourly">
                    {r.hourly.enabled ? "Tắt theo giờ" : "Bật theo giờ"}
                  </Button>
                </td>
                <td className="border-l border-ads-border px-3 py-2 text-right tabular-nums" data-products-enabled={r.products?.enabled ?? false} title={r.products ? `Ảnh: ${r.products.withImage} · SKU: ${r.products.withSku} · không trả về: ${r.products.notReturned} · cập nhật: ${ago(r.products.lastEnrichedAt, now)}` : undefined}>
                  {r.products ? (
                    <>
                      {r.products.enriched} / {r.products.referenced}
                      {r.products.missing + r.products.stale > 0 ? <span className="text-muted-foreground"> · {r.products.missing + r.products.stale}</span> : null}
                      {!r.products.enabled ? <span className="text-muted-foreground"> (tắt)</span> : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button type="button" size="sm" variant="outline" disabled={pending || !r.products} aria-busy={busy === `p:${r.shopId}`} onClick={() => toggleProducts(r)} data-action="toggle-products">
                      {r.products?.enabled ? "Tắt TT SP" : "Bật TT SP"}
                    </Button>
                    {r.products?.enabled ? (
                      <Button type="button" size="sm" variant="ghost" disabled={pending || !productGlobalEnabled} aria-busy={busy === `pr:${r.shopId}`} onClick={() => refreshProducts(r)} data-action="refresh-products">
                        Làm mới TT SP
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ads-muted">
        Mỗi shop chạy lệch vài phút trong mỗi khung 15 phút để không dồn request. Dữ liệu theo giờ chỉ đọc cho hôm nay, cùng nhịp HOT nhưng ưu tiên thấp hơn số liệu ngày; bật thử từng shop trước. Thông tin sản phẩm (tên / ảnh / SKU) chỉ đọc cho sản phẩm đang được quảng cáo, khi chưa có hoặc đã quá hạn lưu. Mở trang không bao giờ gọi Shopee — dữ liệu luôn đọc từ cơ sở dữ liệu.
      </p>
    </div>
  );
}
