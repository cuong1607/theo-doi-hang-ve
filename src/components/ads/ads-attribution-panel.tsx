// SHOPEE-ADS-1B: Broad vs Direct + "Ngoài chiến dịch sản phẩm" (real data).
// Server-safe (no client hooks). Broad / Direct are Shopee's own attributed
// metrics — never shown as the shop's revenue or order count. The outside
// delta is shop total − Σ product campaigns; its source is not identified by
// Shopee, so it is labelled cautiously and explained in a tooltip text.
import { CircleHelp, Layers } from "lucide-react";

import { formatInt, formatMetric } from "@/lib/channels/shopee/ads/metrics";
import type { AdsMetricValues } from "@/lib/channels/shopee/ads/view-models";

export const OUTSIDE_LABEL = "Ngoài chiến dịch sản phẩm";
export const OUTSIDE_TOOLTIP =
  "Phần chênh lệch giữa tổng quảng cáo CPC cấp shop và tổng các chiến dịch sản phẩm. Shopee chưa cung cấp đủ thông tin để xác định chính xác nguồn.";

function Row({ label, broad, direct }: { label: string; broad: string; direct: string }) {
  return (
    <tr className="border-t border-ads-border">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">
        {label}
      </th>
      <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{broad}</td>
      <td className="py-1.5 text-right tabular-nums">{direct}</td>
    </tr>
  );
}

export function AdsAttributionPanel({ current, outside }: { current: AdsMetricValues; outside: AdsMetricValues | null | undefined }) {
  return (
    <div className="space-y-4" data-slot="ads-attribution">
      <table className="w-full text-sm">
        <caption className="sr-only">So sánh chỉ số Broad và Direct</caption>
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th scope="col" className="pb-1 text-left font-medium">Chỉ số</th>
            <th scope="col" className="pb-1 text-right font-medium">Broad</th>
            <th scope="col" className="pb-1 text-right font-medium">Direct</th>
          </tr>
        </thead>
        <tbody>
          <Row label="Doanh số" broad={formatMetric("revenue", current.revenue)} direct={formatMetric("directRevenue", current.directRevenue)} />
          <Row label="Đơn" broad={formatInt(current.orders)} direct={formatInt(current.directOrders)} />
          <Row label="ROAS" broad={formatMetric("roas", current.roas)} direct={formatMetric("directRoas", current.directRoas)} />
          <Row label="ACOS" broad={formatMetric("acos", current.acos)} direct={formatMetric("directAcos", current.directAcos)} />
          <Row label="CVR" broad={formatMetric("conversionRate", current.conversionRate)} direct={formatMetric("directConversionRate", current.directConversionRate)} />
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">Broad và Direct là cách Shopee quy đơn cho quảng cáo — không phải doanh thu hay tổng đơn của shop.</p>

      <div className="rounded-xl border border-dashed border-ads-border bg-ads-surface p-3" data-slot="ads-outside-campaigns">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Layers aria-hidden="true" className="size-4 text-ads-accent" />
          {OUTSIDE_LABEL}
          <span title={OUTSIDE_TOOLTIP} aria-label={OUTSIDE_TOOLTIP} className="inline-flex text-muted-foreground">
            <CircleHelp aria-hidden="true" className="size-3.5" />
          </span>
        </p>
        {outside ? (
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Chi tiêu</dt>
              <dd className="font-semibold tabular-nums">{formatMetric("spend", outside.spend)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Lượt hiển thị</dt>
              <dd className="font-semibold tabular-nums">{formatInt(outside.impressions)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Lượt nhấp</dt>
              <dd className="font-semibold tabular-nums">{formatInt(outside.clicks)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Doanh số Broad</dt>
              <dd className="font-semibold tabular-nums">{formatMetric("revenue", outside.revenue)}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">—</p>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">{OUTSIDE_TOOLTIP}</p>
      </div>
    </div>
  );
}
