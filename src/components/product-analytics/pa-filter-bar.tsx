// PRODUCT-ANALYTICS-3: list filters — a plain GET form (works without JS,
// shareable URL). Every filter is applied in SQL (product_intelligence_list):
// shop, search (accent-insensitive name / SKU / item id), Ads, status, health,
// signal, sort. Styled like the Ads filter bar (rounded pills on the Ads surface).
import Link from "next/link";
import { Search, SlidersHorizontal, X } from "lucide-react";

import { PRODUCT_PERIOD_LABELS } from "@/lib/product-analytics/periods";
import { HEALTH_LABELS, PERFORMANCE_SIGNAL_TYPES, SIGNAL_SHORT_LABEL } from "@/lib/product-analytics/signals";
import type { ProductAnalyticsUrlState } from "@/lib/product-analytics/url-state";

import { HEALTH_FILTER_LABEL } from "./pa-overview";
import { productStatusLabel } from "./pa-product-list";

const SORT_LABEL: Record<string, string> = {
  priority: "Mức ưu tiên",
  gmv: "Doanh số",
  gmv_pct: "Δ doanh số",
  orders: "Số đơn",
  units: "Số lượng",
  spend: "Chi Ads",
  broad_roas: "ROAS Broad",
  roas_pct: "Δ ROAS",
  name: "Tên sản phẩm",
};

const field = "h-9 min-w-0 rounded-full border border-ads-border bg-card px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

export function PaFilterBar({ path, state, shops, statuses, resetHref }: { path: string; state: ProductAnalyticsUrlState; shops: Array<{ id: string; shop_name: string }>; statuses: string[]; resetHref: string }) {
  const p = state.period;
  const l = state.list;
  const active = [l.q, l.ads !== "all", l.status !== "all", l.health !== "all", l.signal !== "all", state.shop !== "all"].filter(Boolean).length;
  return (
    <div className="space-y-2" data-slot="pa-filter-bar">
      <form method="get" action={path} role="search" aria-label="Lọc sản phẩm" className="flex flex-wrap items-center gap-2 rounded-2xl border border-ads-border bg-ads-surface p-2.5">
        <input type="hidden" name="period" value={p.preset} />
        {p.preset === "custom" && (
          <>
            <input type="hidden" name="from" value={p.from} />
            <input type="hidden" name="to" value={p.to} />
          </>
        )}
        <label className="relative flex min-w-[11rem] flex-[2_1_12rem] items-center">
          <span className="sr-only">Tìm theo tên, SKU hoặc item ID (không dấu cũng được)</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
          <input name="q" defaultValue={l.q} placeholder="Tìm tên, SKU, item ID…" className={`${field} w-full pl-9`} />
        </label>
        <label className="flex-[1_1_7.5rem]">
          <span className="sr-only">Shop</span>
          <select name="shop" defaultValue={state.shop} className={`${field} w-full`}>
            <option value="all">Tất cả shop</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.shop_name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-[1_1_6.5rem]">
          <span className="sr-only">Sức khỏe</span>
          <select name="health" defaultValue={l.health} className={`${field} w-full`}>
            <option value="all">Sức khỏe</option>
            {(["ATTENTION", ...HEALTH_LABELS] as const).map((h) => (
              <option key={h} value={h}>
                {HEALTH_FILTER_LABEL[h]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-[1_1_6.5rem]">
          <span className="sr-only">Tín hiệu</span>
          <select name="signal" defaultValue={l.signal} className={`${field} w-full`}>
            <option value="all">Tín hiệu</option>
            {PERFORMANCE_SIGNAL_TYPES.map((s) => (
              <option key={s} value={s}>
                {SIGNAL_SHORT_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-[1_1_6.5rem]">
          <span className="sr-only">Quảng cáo</span>
          <select name="ads" defaultValue={l.ads} className={`${field} w-full`}>
            <option value="all">Ads: tất cả</option>
            <option value="with">Có Ads</option>
            <option value="without">Không Ads</option>
          </select>
        </label>
        <label className="flex-[1_1_6.5rem]">
          <span className="sr-only">Trạng thái sản phẩm</span>
          <select name="status" defaultValue={l.status} className={`${field} w-full`}>
            <option value="all">Trạng thái</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {productStatusLabel(s) ?? "Đang bán"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-[1_1_7.5rem]">
          <span className="sr-only">Sắp xếp</span>
          <select name="sort" defaultValue={l.sort} className={`${field} w-full`}>
            {Object.entries(SORT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                Sắp xếp: {v}
              </option>
            ))}
          </select>
        </label>
        <input type="hidden" name="dir" value={l.dir} />
        {l.pageSize !== 50 && <input type="hidden" name="size" value={l.pageSize} />}
        <button type="submit" className="ads-gradient-primary inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-white shadow-sm shadow-ads-primary/30 transition-transform duration-(--ads-dur-fast) active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none">
          <SlidersHorizontal aria-hidden="true" className="size-4" /> Lọc
        </button>
        {active > 0 && (
          <Link href={resetHref} className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            <X aria-hidden="true" className="size-4" /> Bỏ lọc ({active})
          </Link>
        )}
      </form>
      <details className="group text-xs text-muted-foreground">
        <summary className="inline-flex cursor-pointer items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          Khoảng ngày tùy chỉnh{p.preset === "custom" ? `: ${p.from} → ${p.to}` : ""}
        </summary>
        <form method="get" action={path} className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="period" value="custom" />
          {state.shop !== "all" && <input type="hidden" name="shop" value={state.shop} />}
          <label className="flex items-center gap-1.5">
            Từ <input type="date" name="from" defaultValue={p.preset === "custom" ? p.from : ""} className={field} />
          </label>
          <label className="flex items-center gap-1.5">
            Đến <input type="date" name="to" defaultValue={p.preset === "custom" ? p.to : ""} className={field} />
          </label>
          <button type="submit" className="inline-flex h-9 items-center rounded-full border border-ads-border bg-card px-3 font-medium text-foreground hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            Áp dụng
          </button>
          <span>Mặc định: {PRODUCT_PERIOD_LABELS["7d"]} (so với 7 ngày trước đó).</span>
        </form>
      </details>
    </div>
  );
}
