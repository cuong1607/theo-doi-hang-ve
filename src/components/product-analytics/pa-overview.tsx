// PRODUCT-ANALYTICS-3: health distribution chips + "Sản phẩm cần chú ý" cards.
// Server components; every number comes from product_intelligence_list.summary.
import Link from "next/link";
import { cn } from "cn";

import { fmt, formatPct, formatSalesValue, salesAvailability } from "@/lib/product-analytics/display";
import type { IntelListRow, IntelSummary, ShopSignalContext } from "@/lib/product-analytics/intelligence";
import { HEALTH_LABELS, HEALTH_TEXT, healthRuleText, type HealthLabel } from "@/lib/product-analytics/signals";
import { AdsProductThumb } from "@/components/ads/ads-product-thumb";

import { HEALTH_STYLE, HealthBadge, PriorityPill, SignalChip } from "./pa-badges";
import { PaDeltaChip } from "./pa-kpi-card";

export function PaHealthSummary({ summary, active, hrefFor }: { summary: IntelSummary; active: string; hrefFor: (health: string | undefined) => string }) {
  const total = summary.products;
  return (
    <div className="space-y-3" data-slot="pa-health-summary">
      <div role="group" aria-label="Lọc theo sức khỏe sản phẩm" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {HEALTH_LABELS.map((h, i) => {
          const n = summary.health_counts[h] ?? 0;
          const on = active === h;
          const s = HEALTH_STYLE[h];
          const Icon = s.icon;
          return (
            <Link
              key={h}
              href={hrefFor(on ? undefined : h)}
              scroll={false}
              aria-pressed={on}
              data-health={h}
              style={{ "--ads-delay": `${60 + i * 30}ms` } as React.CSSProperties}
              className={cn(
                "ads-card animate-ads-rise group flex min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                on ? cn("ring-2 ring-offset-0", s.cls) : "border-ads-border",
              )}
            >
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg border", s.cls)}>
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-muted-foreground group-aria-pressed:text-current">{HEALTH_TEXT[h]}</span>
                <span className="text-lg leading-6 font-semibold tabular-nums">{n.toLocaleString("vi-VN")}</span>
                {total > 0 && <span className="ml-1 text-[11px] text-muted-foreground tabular-nums">{Math.round((n / total) * 100)}%</span>}
              </span>
            </Link>
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Tổng hợp tín hiệu">
        <li>
          <span className="font-semibold text-foreground tabular-nums">{summary.sales_declining}</span> sản phẩm doanh số / đơn giảm
        </li>
        <li>
          <span className="font-semibold text-foreground tabular-nums">{summary.sales_growing}</span> sản phẩm doanh số / đơn tăng
        </li>
        <li>
          <span className="font-semibold text-foreground tabular-nums">{summary.ads_efficiency_declining}</span> sản phẩm hiệu quả Ads kém đi (ROAS / CVR / CPC)
        </li>
      </ul>
    </div>
  );
}

/** "multiple products in this shop show a similar decline" — only what was computed, never a market claim. */
export function PaShopContextNote({ ctx, shopName }: { ctx: ShopSignalContext[]; shopName: (id: string) => string }) {
  const notable = ctx.filter((c) => c.sales_comparable_products >= 5 && c.sales_down / c.sales_comparable_products >= 0.3);
  if (!notable.length) return null;
  return (
    <p className="rounded-lg border border-ads-border bg-ads-surface px-3 py-2 text-xs text-muted-foreground" data-slot="pa-shop-context">
      {notable.map((c) => `${shopName(c.shop_id)}: ${c.sales_down}/${c.sales_comparable_products} sản phẩm so sánh được cùng có doanh số giảm (trung vị ${formatPct(c.median_gmv_pct)})`).join(" · ")}. Đây là so sánh trong shop, không phải
      kết luận về thị trường.
    </p>
  );
}

function Metric({ label, value, delta, metric }: { label: string; value: string; delta: number | null; metric: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-semibold tabular-nums">{value}</p>
      {delta !== null ? <PaDeltaChip metric={metric} pct={delta} className="[&>span:last-child]:hidden" /> : <span className="text-[11px] text-muted-foreground">—</span>}
    </div>
  );
}

export function PaAttentionCards({ rows, hrefFor, shopName }: { rows: IntelListRow[]; hrefFor: (row: IntelListRow) => string; shopName: (id: string) => string }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-slot="pa-attention">
      {rows.map((r, i) => {
        const av = salesAvailability(r);
        return (
          <li key={r.id} style={{ "--ads-delay": `${80 + i * 40}ms` } as React.CSSProperties} className="animate-ads-rise">
            <Link
              href={hrefFor(r)}
              className="ads-card flex h-full flex-col gap-3 rounded-xl border border-ads-border bg-card p-3.5 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              aria-label={`${r.name ?? `Sản phẩm ${r.item_id}`} — ${HEALTH_TEXT[r.health.label]}`}
            >
              <div className="flex items-start gap-3">
                <AdsProductThumb src={r.image_url} alt="" size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm leading-snug font-medium">{r.name ?? `Sản phẩm #${r.item_id}`}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{shopName(r.shop_id)}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Metric label="Doanh số" value={formatSalesValue(r.gmv, av, fmt.vnd)} delta={r.gmv_pct} metric="sales_gmv" />
                <Metric label="Đơn" value={formatSalesValue(r.orders, av, fmt.int)} delta={r.orders_pct} metric="orders" />
                <Metric label="ROAS Broad" value={r.campaigns > 0 ? fmt.roas(r.broad_roas) : "—"} delta={r.campaigns > 0 ? r.roas_pct : null} metric="ads_broad_roas" />
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1.5">
                <HealthBadge label={r.health.label} />
                <PriorityPill priority={r.priority} />
              </div>
              <div className="flex flex-wrap gap-1.5" aria-label="Tín hiệu chính">
                {r.top_signals.slice(0, 2).map((s) => (
                  <SignalChip key={s.type} signal={s} />
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{healthRuleText(r.health.rule)}</p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export const HEALTH_FILTER_LABEL: Record<HealthLabel | "ATTENTION", string> = { ...HEALTH_TEXT, ATTENTION: "Cần chú ý" };
