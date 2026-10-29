"use client";

// SHOPEE-ADS-2: background Ads sync per shop (admins). Shows the rollout
// switch, the stagger offset inside each 15-minute window, campaign count and
// the HOT SLA of the last 24 h. The switch only decides whether the scheduler
// ENQUEUES read jobs for the shop (and only while ADS_AUTO_SYNC_ENABLED=true);
// it never touches campaigns on Shopee.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { AdsShopSyncOverview } from "@/lib/channels/shopee/ads/schedule";
import { toggleAdsAutoSyncAction } from "@/app/(authenticated)/shopee/ads/actions";
import { toast } from "@/components/patterns/toast";
import { Button } from "@/components/ui/button";

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const m = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
  return m < 1 ? "vừa xong" : m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.floor(m / 60)} giờ trước` : `${Math.floor(m / 1440)} ngày trước`;
}

const secs = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function AdsAutoSyncPanel({ rows, globalEnabled, serverNow }: { rows: AdsShopSyncOverview[]; globalEnabled: boolean; serverNow: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.parse(serverNow);

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
        <span className={globalEnabled ? "rounded-full border border-success/30 bg-success-soft px-2.5 py-0.5 text-xs text-success-text" : "rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"}>
          {globalEnabled ? "Bộ lập lịch Ads: đang bật" : "Bộ lập lịch Ads: đang tắt (ADS_AUTO_SYNC_ENABLED)"}
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-ads-border">
        <table className="w-full min-w-[640px] text-xs">
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ads-muted">Mỗi shop chạy lệch vài phút trong mỗi khung 15 phút để không dồn request. Mở trang không bao giờ gọi Shopee — dữ liệu luôn đọc từ cơ sở dữ liệu.</p>
    </div>
  );
}
