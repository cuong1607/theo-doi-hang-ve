// PRODUCT-ANALYTICS-3: product detail panels — signals with evidence, Ads
// metrics grid, current Shopee snapshot, friendly data-quality panel and the
// baseline comparison. Server components (tooltips are client islands).
// Wording is factual: "Doanh số và hiệu quả Ads cùng giảm", never "do Ads".
import { AlertTriangle, CheckCircle2, Clock, Database, Eye, Heart, MessageSquare, ShoppingCart, Star } from "lucide-react";
import { cn } from "cn";

import { formatAdsPercent, formatInt, formatRoas, formatVndFull } from "@/lib/channels/shopee/ads/metrics";
import { ATTRIBUTION_INDICATOR_LABEL, ATTRIBUTION_INDICATOR_LABEL_VI, ATTRIBUTION_INDICATOR_TOOLTIP, BROAD_GMV_TOOLTIP, formatAge, formatPct } from "@/lib/product-analytics/display";
import type { BaselineWindow, IntelDetail } from "@/lib/product-analytics/intelligence";
import { CONFIDENCE_TEXT, DATA_QUALITY_TEXT, describeSignal, healthRuleText, priorityExplain, signalTone, type ProductIntel } from "@/lib/product-analytics/signals";
import type { PaDelta, ProductSummary } from "@/lib/product-analytics/types";
import { formatDateTime } from "@/lib/ui/format";
import { DELTA_CLASS } from "@/components/ads/metric-style";

import { ConfidenceText, HealthBadge, PriorityPill } from "./pa-badges";
import { PaDeltaChip, PaInfoTip } from "./pa-kpi-card";

const METRIC_FMT: Record<string, (v: number | null) => string> = {
  sales_gmv: formatVndFull,
  orders: formatInt,
  units: formatInt,
  ads_spend: formatVndFull,
  ads_impressions: formatInt,
  ads_clicks: formatInt,
  ads_cpc: formatVndFull,
  ads_broad_roas: formatRoas,
  ads_broad_cvr: (v) => formatAdsPercent(v),
};

export function PaSignalPanel({ intel, ctx }: { intel: ProductIntel; ctx: IntelDetail["shop_context"] }) {
  const perf = intel.signals.filter((s) => s.direction !== "flat");
  const flat = intel.signals.filter((s) => s.direction === "flat");
  return (
    <div className="space-y-4" data-slot="pa-signal-panel">
      <div className="flex flex-wrap items-start gap-3 rounded-xl border border-ads-border bg-ads-surface p-3">
        <HealthBadge label={intel.health.label} size="md" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm">{healthRuleText(intel.health.rule)}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <ConfidenceText confidence={intel.health.confidence} />
            {intel.health.basis === "ads" && <span>Chỉ dựa trên Ads (chưa so sánh được doanh số)</span>}
            {intel.priority.level !== "NONE" && <span title={priorityExplain(intel.priority)}>{priorityExplain(intel.priority)}</span>}
          </p>
        </div>
        <PriorityPill priority={intel.priority} />
      </div>

      {perf.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 aria-hidden="true" className="size-4 text-success-text" />
          {flat.length ? `${describeSignal(flat[0])} — không có thay đổi vượt ngưỡng.` : "Không có thay đổi vượt ngưỡng (hoặc chưa đủ dữ liệu để so sánh)."}
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Tín hiệu đáng chú ý">
          {perf.map((s, i) => {
            const f = METRIC_FMT[s.metric] ?? formatInt;
            return (
              <li key={s.type} style={{ "--ads-delay": `${60 + i * 30}ms` } as React.CSSProperties} className={cn("animate-ads-rise flex items-start gap-3 rounded-xl border p-3", s.polarity === "negative" ? "border-ads-border" : "border-ads-border/70")} data-signal={s.type}>
                <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg", DELTA_CLASS[signalTone(s)])}>
                  {s.severity === "WARNING" ? <AlertTriangle aria-hidden="true" className="size-3.5" /> : <span aria-hidden="true" className="text-xs font-bold">{s.direction === "up" ? "↑" : "↓"}</span>}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{describeSignal(s)}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {f(s.previous)} → {f(s.current)}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span className={cn("rounded-full px-1.5", s.severity === "WARNING" ? "bg-danger-soft text-danger-text" : s.severity === "NOTICE" ? "bg-warning-soft text-warning-text" : "bg-muted")}>
                      {s.severity === "WARNING" ? "Cảnh báo" : s.severity === "NOTICE" ? "Lưu ý" : "Thông tin"}
                    </span>
                    <span>{CONFIDENCE_TEXT[s.confidence]}</span>
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {ctx.sales_comparable_products >= 5 && (
        <p className="text-xs text-muted-foreground" data-slot="pa-shop-baseline">
          Trong shop: {ctx.sales_down}/{ctx.sales_comparable_products} sản phẩm so sánh được có doanh số giảm; trung vị thay đổi doanh số {formatPct(ctx.median_gmv_pct)}
          {ctx.product_gmv_pct_minus_median !== null ? ` (sản phẩm này ${ctx.product_gmv_pct_minus_median >= 0 ? "cao hơn" : "thấp hơn"} ${Math.abs(ctx.product_gmv_pct_minus_median).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} điểm %)` : ""}
          {ctx.median_broad_roas !== null ? ` · ROAS Broad trung vị ${formatRoas(ctx.median_broad_roas)}` : ""}
          {ctx.product_roas_vs_median_pct !== null ? ` (sản phẩm này ${formatPct(ctx.product_roas_vs_median_pct)})` : ""}. So sánh trong shop — không phải thị trường.
        </p>
      )}
      <p className="text-xs text-muted-foreground">Tín hiệu là quan sát thực tế so với kỳ trước, không phải nguyên nhân. Khi nhiều chỉ số cùng đổi, hệ thống chỉ ghi nhận chúng cùng xảy ra.</p>
    </div>
  );
}

function Mini({ label, delta, f, metric, tooltip, comparable }: { label: string; delta: PaDelta; f: (v: number | null) => string; metric: string; tooltip?: string; comparable: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-ads-border bg-card p-3" data-metric={metric}>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        {tooltip && <PaInfoTip label={label} text={tooltip} />}
      </p>
      <p className="text-base font-semibold tabular-nums">{f(delta.current)}</p>
      {comparable && delta.pct !== null ? <PaDeltaChip metric={metric} pct={delta.pct} className="[&>span:last-child]:hidden" /> : <span className="text-[11px] text-muted-foreground">kỳ trước {f(delta.previous)}</span>}
    </div>
  );
}

export function PaAdsGrid({ ads, comparable, salesExact }: { ads: ProductSummary["ads"]; comparable: boolean; salesExact: boolean }) {
  return (
    <div className="space-y-3" data-slot="pa-ads-grid">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        <Mini label="Chi tiêu" delta={ads.spend} f={formatVndFull} metric="ads_spend" comparable={comparable} tooltip="Chi của các campaign chỉ quảng cáo sản phẩm này. Chi tăng/giảm không tự nó là tốt hay xấu." />
        <Mini label="Hiển thị" delta={ads.impressions} f={formatInt} metric="ads_impressions" comparable={comparable} />
        <Mini label="Click" delta={ads.clicks} f={formatInt} metric="ads_clicks" comparable={comparable} />
        <Mini label="CTR" delta={ads.ctr} f={(v) => formatAdsPercent(v)} metric="ads_ctr" comparable={comparable} tooltip="Click ÷ hiển thị (tổng / tổng)." />
        <Mini label="CPC thực" delta={ads.cpc} f={formatVndFull} metric="ads_cpc" comparable={comparable} tooltip="Chi ÷ click. CPC giảm là tốt." />
        <Mini label="Đơn Broad" delta={ads.broad_order} f={formatInt} metric="ads_broad_order" comparable={comparable} tooltip={BROAD_GMV_TOOLTIP} />
        <Mini label="Đơn Direct" delta={ads.direct_order} f={formatInt} metric="ads_direct_order" comparable={comparable} />
        <Mini label="CVR Broad" delta={ads.broad_cvr} f={(v) => formatAdsPercent(v)} metric="ads_broad_cvr" comparable={comparable} tooltip="Đơn Broad ÷ click." />
        <Mini label="Broad GMV" delta={ads.broad_gmv} f={formatVndFull} metric="ads_broad_gmv" comparable={comparable} tooltip={BROAD_GMV_TOOLTIP} />
        <Mini label="Direct GMV" delta={ads.direct_gmv} f={formatVndFull} metric="ads_direct_gmv" comparable={comparable} tooltip="Attribution trực tiếp của Shopee Ads." />
        <Mini label="ROAS Broad" delta={ads.broad_roas} f={formatRoas} metric="ads_broad_roas" comparable={comparable} tooltip="Broad GMV ÷ chi (tổng / tổng)." />
        <Mini label="ROAS Direct" delta={ads.direct_roas} f={formatRoas} metric="ads_direct_roas" comparable={comparable} />
      </div>
      <div className="flex flex-wrap items-start gap-3 rounded-xl border border-dashed border-ads-border bg-ads-surface p-3" data-slot="pa-attribution-indicator">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{ATTRIBUTION_INDICATOR_LABEL_VI}</span>
            <span className="sr-only">({ATTRIBUTION_INDICATOR_LABEL})</span>
            <PaInfoTip label={ATTRIBUTION_INDICATOR_LABEL} text={ATTRIBUTION_INDICATOR_TOOLTIP} />
          </p>
          <p className="text-base font-semibold tabular-nums">{salesExact ? formatAdsPercent(ads.broad_gmv_to_sales_indicator.current, 0) : "—"}</p>
          <p className="text-[11px] text-muted-foreground">
            {salesExact ? "Chỉ báo, có thể vượt 100% — KHÔNG phải tỷ trọng doanh số. Doanh số trừ Broad GMV không có ý nghĩa." : "Ẩn vì doanh số kỳ này chưa đầy đủ (mẫu số là mức tối thiểu)."}
          </p>
        </div>
      </div>
    </div>
  );
}

export function PaSnapshotPanel({ snapshot }: { snapshot: ProductSummary["snapshot"] }) {
  if (!snapshot) return <p className="text-sm text-muted-foreground">Chưa có ảnh chụp (snapshot sản phẩm đang tắt hoặc shop chưa bật).</p>;
  const items = [
    { label: "Đã bán (bộ đếm Shopee)", value: formatInt(snapshot.sale), icon: ShoppingCart },
    { label: "Lượt xem", value: formatInt(snapshot.views), icon: Eye },
    { label: "Lượt thích", value: formatInt(snapshot.likes), icon: Heart },
    { label: "Đánh giá", value: snapshot.rating_star === null ? "—" : `${snapshot.rating_star.toLocaleString("vi-VN", { maximumFractionDigits: 2 })} ★`, icon: Star },
    { label: "Bình luận", value: formatInt(snapshot.comment_count), icon: MessageSquare },
  ];
  return (
    <div className="space-y-2" data-slot="pa-snapshot">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {items.map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-xl border border-ads-border bg-card p-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon aria-hidden="true" className="size-3.5" />
              {label}
            </p>
            <p className="mt-1 text-base font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Đọc lúc {formatDateTime(snapshot.captured_at)} · giá trị tại thời điểm đọc, không có xu hướng theo kỳ.</p>
    </div>
  );
}

function DqItem({ icon: Icon, label, value, ok, hint }: { icon: typeof Clock; label: string; value: string; ok: boolean | null; hint?: string }) {
  return (
    <li className="flex items-start gap-2.5 rounded-xl border border-ads-border bg-card p-3">
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", ok === null ? "bg-muted text-muted-foreground" : ok ? "bg-success-soft text-success-text" : "bg-warning-soft text-warning-text")}>
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium">{value}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </li>
  );
}

export function PaDataQualityPanel({ intel, detail, partialToday, hourCutoff, snapshotAt }: { intel: ProductIntel; detail: IntelDetail; partialToday: boolean; hourCutoff: number | null; snapshotAt: string | null }) {
  const shop = detail.shop;
  const row = detail.row;
  const cov = row.sales_state === "no_data" ? "Chưa có dữ liệu đơn hàng" : !row.sales_exact ? `Chưa đủ (đầy đủ từ ${row.covered_from ?? "—"})` : row.sales_comparable ? "Đủ cho cả hai kỳ" : `Kỳ trước chưa đủ (đầy đủ từ ${row.covered_from})`;
  return (
    <div className="space-y-3" data-slot="pa-data-quality">
      <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
        <DqItem icon={Clock} label="Đơn hàng" value={shop.sales_last_success_at ? `Cập nhật ${formatAge(shop.sales_age_minutes)}` : "Chưa đồng bộ"} ok={shop.sales_last_success_at ? !shop.sales_stale : null} hint="Mục tiêu ≤ 45 phút" />
        <DqItem icon={Clock} label="Quảng cáo" value={row.campaigns === 0 ? "Không có campaign riêng" : shop.ads_today_at ? `Cập nhật ${formatAge(shop.ads_age_minutes)}` : "Chưa có"} ok={row.campaigns === 0 ? null : shop.ads_today_at ? !shop.ads_stale : false} />
        <DqItem icon={Database} label="Độ phủ để so sánh" value={cov} ok={row.sales_state === "no_data" ? null : row.sales_comparable} />
        <DqItem icon={AlertTriangle} label="Hôm nay" value={partialToday ? (hourCutoff ? `Chưa hết ngày · so đến ${hourCutoff}:00` : "Chưa có giờ hoàn tất") : "Kỳ đã hoàn tất"} ok={partialToday ? false : true} />
        <DqItem icon={Eye} label="Snapshot Shopee" value={snapshotAt ? "Có · ý nghĩa chưa xác minh" : "Chưa có"} ok={null} hint="Độ tin cậy thấp — không so sánh theo kỳ" />
      </ul>
      {intel.data_quality.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">Chi tiết kỹ thuật ({intel.data_quality.length})</summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {intel.data_quality.map((d, i) => (
              <li key={`${d.type}-${i}`}>
                {DATA_QUALITY_TEXT[d.type]} <code className="text-[10px] opacity-70">{d.type}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Current daily average vs the N days before the period: median, mean, volatility (CV). */
export function PaBaselinePanel({ windows, current, days, partial }: { windows: BaselineWindow[]; current: { sales_gmv: number | null; orders: number | null; ads_spend: number }; days: number; partial: boolean }) {
  const rows: Array<{ key: "sales_gmv" | "orders" | "ads_spend"; label: string; f: (v: number | null) => string; sales: boolean }> = [
    { key: "sales_gmv", label: "Doanh số / ngày", f: formatVndFull, sales: true },
    { key: "orders", label: "Đơn / ngày", f: (v) => (v === null ? "—" : v.toLocaleString("vi-VN", { maximumFractionDigits: 1 })), sales: true },
    { key: "ads_spend", label: "Chi Ads / ngày", f: formatVndFull, sales: false },
  ];
  return (
    <div className="space-y-2" data-slot="pa-baseline">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <caption className="sr-only">So sánh với nền lịch sử</caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1.5 font-medium">Chỉ số</th>
              <th scope="col" className="py-1.5 text-right font-medium">Kỳ này (TB/ngày)</th>
              {windows.map((w) => (
                <th key={w.days} scope="col" className="py-1.5 text-right font-medium">
                  {w.days} ngày trước: trung vị · TB · biến động
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cur = current[r.key];
              return (
                <tr key={r.key} className="border-t border-ads-border/70">
                  <th scope="row" className="py-2 text-left font-normal text-muted-foreground">{r.label}</th>
                  <td className="py-2 text-right font-medium tabular-nums">{partial ? "—" : cur === null ? "—" : r.f(cur / Math.max(1, days))}</td>
                  {windows.map((w) => {
                    const m = w.metrics[r.key];
                    if ((r.sales && !w.sales_complete) || !m) return <td key={w.days} className="py-2 text-right text-xs text-muted-foreground">chưa đủ dữ liệu</td>;
                    return (
                      <td key={w.days} className="py-2 text-right tabular-nums">
                        {r.f(m.median)} <span className="text-muted-foreground">· {r.f(m.mean)} · {m.cv === null ? "—" : `CV ${m.cv.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}`}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Nền = các ngày hoàn tất ngay trước kỳ đang xem. CV (độ lệch chuẩn ÷ trung bình) cho biết số liệu dao động mạnh hay ổn định theo ngày: CV cao → thay đổi % giữa các kỳ ít ý nghĩa hơn.
        {partial ? " Hôm nay chưa hết ngày nên không tính trung bình kỳ này." : ""}
      </p>
    </div>
  );
}
