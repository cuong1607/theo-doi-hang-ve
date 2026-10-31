// PRODUCT-ANALYTICS-3: product list — card/table hybrid. Desktop: four visual
// groups (SẢN PHẨM · DOANH SỐ · QUẢNG CÁO · SỨC KHỎE) instead of twelve equal
// columns; mobile (< md): stacked cards, no horizontal scrolling. Rows arrive
// already filtered / sorted / paged by SQL — nothing is recomputed here.
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "cn";

import { fmt, formatSalesValue, salesAvailability } from "@/lib/product-analytics/display";
import type { IntelListRow, IntelSort } from "@/lib/product-analytics/intelligence";
import { AdsProductThumb } from "@/components/ads/ads-product-thumb";

import { DataQualityChip, HealthBadge, PriorityPill, SignalChip } from "./pa-badges";
import { PaDeltaChip } from "./pa-kpi-card";

/** Raw Shopee item_status → subtle label (NORMAL needs none). */
const STATUS_LABEL: Record<string, string> = { UNLIST: "Đang ẩn", SELLER_DELETE: "Người bán đã xoá", SHOPEE_DELETE: "Shopee đã xoá", BANNED: "Bị khoá", REVIEWING: "Đang duyệt" };
export const productStatusLabel = (s: string | null) => (!s || s === "NORMAL" ? null : (STATUS_LABEL[s] ?? s));

export interface PaListProps {
  rows: IntelListRow[];
  sort: IntelSort;
  dir: "asc" | "desc";
  sortHref: (key: IntelSort) => string;
  rowHref: (row: IntelListRow) => string;
  shopName: (id: string) => string;
  showShop: boolean;
}

function SortLink({ k, label, sort, dir, sortHref, className }: { k: IntelSort; label: string; sort: IntelSort; dir: "asc" | "desc"; sortHref: (key: IntelSort) => string; className?: string }) {
  const active = sort === k;
  const Icon = active ? (dir === "desc" ? ArrowDown : ArrowUp) : ArrowUpDown;
  return (
    <Link
      href={sortHref(k)}
      scroll={false}
      aria-label={`Sắp xếp theo ${label}${active ? (dir === "desc" ? " (giảm dần)" : " (tăng dần)") : ""}`}
      className={cn("inline-flex items-center gap-1 rounded transition-colors duration-(--ads-dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", active && "text-foreground", className)}
    >
      {label}
      <Icon aria-hidden="true" className={cn("size-3", !active && "opacity-40")} />
    </Link>
  );
}

function ProductCell({ r, href, shopName, showShop }: { r: IntelListRow; href: string; shopName: (id: string) => string; showShop: boolean }) {
  const status = productStatusLabel(r.status);
  return (
    <Link href={href} className="group flex min-w-0 items-center gap-3 rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
      <AdsProductThumb src={r.image_url} alt="" size="lg" />
      <span className="min-w-0">
        <span className="line-clamp-2 text-sm leading-snug font-medium group-hover:text-ads-primary-text group-hover:underline">{r.name ?? `Sản phẩm #${r.item_id}`}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          {r.sku && <span>SKU {r.sku}</span>}
          {showShop && <span className="truncate">· {shopName(r.shop_id)}</span>}
          {status && <span className="rounded-full bg-danger-soft px-1.5 text-danger-text">{status}</span>}
          {r.shared_campaigns > 0 && <span title="Campaign quảng cáo nhiều sản phẩm không được chia cho từng sản phẩm">· {r.shared_campaigns} campaign chung (không tính)</span>}
        </span>
      </span>
    </Link>
  );
}

function SalesCell({ r }: { r: IntelListRow }) {
  const av = salesAvailability(r);
  return (
    <div className="min-w-0">
      <p className={cn("text-base font-semibold tabular-nums", av !== "complete" && "text-muted-foreground")} title={av === "no_data" ? "Chưa có dữ liệu đơn hàng — không phải 0" : av === "lower_bound" ? "Chưa đủ dữ liệu: mức tối thiểu" : undefined}>
        {formatSalesValue(r.gmv, av, fmt.vnd)}
      </p>
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {formatSalesValue(r.orders, av, fmt.int)} đơn · {formatSalesValue(r.units, av, fmt.int)} SP
      </p>
      {r.gmv_pct !== null && <PaDeltaChip metric="sales_gmv" pct={r.gmv_pct} className="mt-1 [&>span:last-child]:hidden" />}
    </div>
  );
}

function AdsCell({ r }: { r: IntelListRow }) {
  if (r.campaigns === 0) return <p className="text-xs text-muted-foreground">Không có campaign riêng</p>;
  return (
    <div className="min-w-0">
      <p className="text-sm font-semibold tabular-nums">
        {fmt.vnd(r.spend)} <span className="font-normal text-muted-foreground">·</span> <span className="text-metric-roas-text">{fmt.roas(r.broad_roas)}</span>
      </p>
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {fmt.int(r.clicks)} click · Broad GMV {fmt.vnd(r.broad_gmv)}
      </p>
      {r.roas_pct !== null && <PaDeltaChip metric="ads_broad_roas" pct={r.roas_pct} className="mt-1 [&>span:last-child]:hidden" />}
    </div>
  );
}

function HealthCell({ r }: { r: IntelListRow }) {
  const dq = r.data_quality.filter((t) => t === "SALES_DATA_MISSING" || t === "SALES_INCOMPLETE" || t === "ADS_DATA_MISSING");
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <HealthBadge label={r.health.label} />
        <PriorityPill priority={r.priority} />
      </span>
      {r.top_signals.slice(0, 2).map((s) => (
        <SignalChip key={s.type} signal={s} />
      ))}
      {dq.map((t) => (
        <DataQualityChip key={t} type={t} />
      ))}
    </div>
  );
}

export function PaProductList({ rows, sort, dir, sortHref, rowHref, shopName, showShop }: PaListProps) {
  const sl = (k: IntelSort, label: string, className?: string) => <SortLink k={k} label={label} sort={sort} dir={dir} sortHref={sortHref} className={className} />;
  return (
    <div data-slot="pa-product-list">
      {/* desktop / tablet: grouped table */}
      <table className="hidden w-full table-fixed border-separate border-spacing-0 text-sm md:table" aria-label="Danh sách sản phẩm">
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[19%]" />
          <col className="w-[20%]" />
          <col className="w-[23%]" />
        </colgroup>
        <thead>
          <tr className="text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <th scope="col" className="border-b border-ads-border px-3 py-2.5">
              <span className="flex items-center gap-3">Sản phẩm {sl("name", "Tên", "normal-case font-medium")}</span>
            </th>
            <th scope="col" className="border-b border-ads-border px-3 py-2.5">
              <span className="flex flex-wrap items-center gap-x-2">Doanh số {sl("gmv", "Giá trị", "normal-case font-medium")} {sl("gmv_pct", "Δ", "normal-case font-medium")} {sl("orders", "Đơn", "normal-case font-medium")}</span>
            </th>
            <th scope="col" className="border-b border-ads-border px-3 py-2.5">
              <span className="flex flex-wrap items-center gap-x-2">Quảng cáo {sl("spend", "Chi", "normal-case font-medium")} {sl("broad_roas", "ROAS", "normal-case font-medium")} {sl("roas_pct", "Δ", "normal-case font-medium")}</span>
            </th>
            <th scope="col" className="border-b border-ads-border px-3 py-2.5">
              <span className="flex items-center gap-2">Sức khỏe {sl("priority", "Ưu tiên", "normal-case font-medium")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-row={r.id} data-health={r.health.label} className="align-top transition-colors duration-(--ads-dur-fast) hover:bg-ads-surface">
              <td className="border-b border-ads-border/70 px-3 py-3">
                <ProductCell r={r} href={rowHref(r)} shopName={shopName} showShop={showShop} />
              </td>
              <td className="border-b border-ads-border/70 px-3 py-3">
                <SalesCell r={r} />
              </td>
              <td className="border-b border-ads-border/70 px-3 py-3">
                <AdsCell r={r} />
              </td>
              <td className="border-b border-ads-border/70 px-3 py-3">
                <HealthCell r={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* mobile: stacked cards */}
      <ul className="space-y-2.5 md:hidden" aria-label="Danh sách sản phẩm">
        {rows.map((r) => (
          <li key={r.id} data-row={r.id} data-health={r.health.label} className="rounded-xl border border-ads-border bg-card p-3">
            <ProductCell r={r} href={rowHref(r)} shopName={shopName} showShop={showShop} />
            <div className="mt-3 grid grid-cols-2 gap-3 border-t border-ads-border/70 pt-3">
              <div>
                <p className="mb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Doanh số</p>
                <SalesCell r={r} />
              </div>
              <div>
                <p className="mb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Quảng cáo</p>
                <AdsCell r={r} />
              </div>
            </div>
            <div className="mt-3 border-t border-ads-border/70 pt-3">
              <HealthCell r={r} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Server-side pagination: links only (filters / sort / size stay in the URL). */
export function PaPagination({ page, pageSize, filtered, hrefFor, sizeHref }: { page: number; pageSize: number; filtered: number; hrefFor: (page: number) => string; sizeHref: (size: number) => string }) {
  const pages = Math.max(1, Math.ceil(filtered / pageSize));
  const from = filtered === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(filtered, page * pageSize);
  const btn = "inline-flex h-8 items-center gap-1 rounded-full border border-ads-border bg-card px-3 text-sm font-medium transition-[background-color,transform] duration-(--ads-dur-fast) hover:bg-ads-surface-strong active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";
  return (
    <nav aria-label="Phân trang" className="flex flex-col gap-3 pt-4 text-sm sm:flex-row sm:items-center sm:justify-between" data-slot="pa-pagination">
      <p className="text-muted-foreground tabular-nums">{filtered === 0 ? "Không có sản phẩm nào" : `Hiển thị ${from.toLocaleString("vi-VN")}–${to.toLocaleString("vi-VN")} / ${filtered.toLocaleString("vi-VN")} sản phẩm`}</p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 text-muted-foreground">
          <span className="mr-1 hidden md:inline">Số dòng:</span>
          {[25, 50, 100].map((s) => (
            <Link key={s} href={sizeHref(s)} scroll={false} aria-current={s === pageSize ? "true" : undefined} className={cn("rounded-md px-2 py-0.5 tabular-nums hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", s === pageSize && "bg-ads-primary/12 font-medium text-ads-primary-text")}>
              {s}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} scroll={false} className={btn} aria-label="Trang trước">
              <ChevronLeft aria-hidden="true" className="size-4" /> <span className="hidden sm:inline">Trước</span>
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(btn, "pointer-events-none opacity-50")}>
              <ChevronLeft aria-hidden="true" className="size-4" /> <span className="hidden sm:inline">Trước</span>
            </span>
          )}
          <span className="text-muted-foreground tabular-nums">
            Trang {page} / {pages}
          </span>
          {page < pages ? (
            <Link href={hrefFor(page + 1)} scroll={false} className={btn} aria-label="Trang sau">
              <span className="hidden sm:inline">Sau</span> <ChevronRight aria-hidden="true" className="size-4" />
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(btn, "pointer-events-none opacity-50")}>
              <span className="hidden sm:inline">Sau</span> <ChevronRight aria-hidden="true" className="size-4" />
            </span>
          )}
        </div>
      </div>
    </nav>
  );
}
