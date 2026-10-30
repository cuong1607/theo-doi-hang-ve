"use client";

// SHOPEE-ADS-UI-1 campaign table. Search / status / sort / page live in the
// URL and are applied on the server (queryCampaigns) — the same contract a
// DB-backed source will have. Sticky header, horizontal scroll on small
// screens, row hover tint, and expandable rows: height + opacity animate
// via grid-template-rows (0fr → 1fr, no measuring, no layout jump); the
// detail is mounted on first open and `inert` while closed.
// ADS-3A.2: the campaign cell shows the advertised product (verified
// thumbnail / name / SKU from shopee_ads_products); unknown metadata falls
// back to the campaign name and a neutral icon — never blank, never invented.
import { Fragment, useId, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from "lucide-react";
import { cn } from "cn";

import { ADS_STATUS_OPTIONS, ADS_TYPE_OPTIONS, type AdsSortColumn } from "@/lib/channels/shopee/ads/filters";
import { ADS_TARGETS, formatInt, formatMetric, formatMetricDetailed, meetsTarget } from "@/lib/channels/shopee/ads/metrics";
import type { AdsAdvertisedProduct, AdsCampaignRow, AdsCampaignStatus } from "@/lib/channels/shopee/ads/view-models";
import { buildListHref } from "@/lib/ui/list-query";
import { DataTablePagination } from "@/components/patterns/data-table-pagination";
import { FilterBar, SearchInput, useFilterNav } from "@/components/patterns/filter-bar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { AdsCampaignStatusBadge } from "./ads-campaign-status-badge";
import { AdsProgress } from "./ads-efficiency-card";
import { AdsProductThumb } from "./ads-product-thumb";
import { ShopAvatar } from "./ads-filter-bar";
import { AdsEmptyState } from "./ads-states";

const TYPE_LABEL = Object.fromEntries(ADS_TYPE_OPTIONS.map((o) => [o.value, o.label]));

/** Raw Shopee item_status → subtle label (NORMAL needs none; unknown values are shown raw). Never a campaign status. */
const PRODUCT_STATUS_LABEL: Record<string, string> = { UNLIST: "Đang ẩn", SELLER_DELETE: "Người bán đã xoá SP", SHOPEE_DELETE: "Shopee đã xoá SP", BANNED: "Bị khoá", REVIEWING: "Đang duyệt" };

function productStatusLabel(p: AdsAdvertisedProduct): string | null {
  if (!p.providerStatus || p.providerStatus === "NORMAL") return null;
  return PRODUCT_STATUS_LABEL[p.providerStatus] ?? p.providerStatus;
}

/** The row's display product: verified metadata only (fixture / pending rows keep the campaign name). */
function displayProduct(r: AdsCampaignRow): { name: string; product: AdsAdvertisedProduct | null } {
  const product = r.topProducts[0] ?? null;
  return { name: product?.enrichment === "enriched" ? product.name : r.name, product };
}

const COLUMNS: Array<{ key: AdsSortColumn; label: string; align?: "right" }> = [
  { key: "name", label: "Chiến dịch" },
  { key: "status", label: "Trạng thái" },
  { key: "budget", label: "Ngân sách/ngày", align: "right" },
  { key: "spend", label: "Chi tiêu", align: "right" },
  { key: "revenue", label: "Doanh số Broad", align: "right" },
  { key: "orders", label: "Đơn Broad", align: "right" },
  { key: "roas", label: "ROAS Broad", align: "right" },
  { key: "ctr", label: "CTR", align: "right" },
  { key: "cpc", label: "CPC", align: "right" },
  { key: "acos", label: "ACOS", align: "right" },
];

function SortLink({ col, label, sort, desc, pathname, query }: { col: AdsSortColumn; label: string; sort: AdsSortColumn; desc: boolean; pathname: string; query: Record<string, string | undefined> }) {
  const active = sort === col;
  const href = buildListHref(pathname, query, { sort: col, dir: active && desc ? "asc" : "desc", page: undefined });
  const Icon = active ? (desc ? ArrowDown : ArrowUp) : ArrowUpDown;
  return (
    <Link href={href} scroll={false} replace className={cn("inline-flex items-center gap-1 rounded transition-colors duration-(--ads-dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", active && "text-foreground")}>
      {label}
      <Icon aria-hidden="true" className={cn("size-3", !active && "opacity-40")} />
    </Link>
  );
}

function StatusChips({ value, counts }: { value: AdsCampaignStatus | "all"; counts: Record<string, number> }) {
  const { setParam } = useFilterNav();
  return (
    <div role="group" aria-label="Lọc theo trạng thái" className="flex flex-wrap gap-1.5">
      {ADS_STATUS_OPTIONS.filter((o) => o.value === "all" || o.value === value || (counts[o.value] ?? 0) > 0).map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => setParam("status", o.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-[background-color,color,border-color,transform] duration-(--ads-dur-fast) active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              active ? "border-transparent bg-ads-primary/12 text-ads-primary-text" : "border-ads-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {o.value === "all" ? "Tất cả" : o.label}
            <span className={cn("rounded-full px-1.5 text-[10px] tabular-nums", active ? "bg-ads-primary/15" : "bg-muted")}>{counts[o.value] ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}

function MiniTrend({ points }: { points: AdsCampaignRow["trend"] }) {
  if (points.length < 2) return <p className="text-xs text-muted-foreground">Chưa đủ dữ liệu để vẽ xu hướng.</p>;
  const W = 260;
  const H = 64;
  const max = Math.max(1, ...points.flatMap((p) => [p.spend, p.revenue]));
  const path = (k: "spend" | "revenue") => points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * W).toFixed(1)},${(H - 4 - (p[k] / max) * (H - 8)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="Xu hướng chi tiêu và doanh số Broad của chiến dịch">
      <path d={`${path("revenue")} L${W},${H} L0,${H} Z`} style={{ fill: "var(--metric-revenue)", opacity: 0.14 }} />
      <path d={path("revenue")} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--metric-revenue)" }} />
      <path d={path("spend")} fill="none" strokeWidth="2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--metric-spend)" }} />
    </svg>
  );
}

function CampaignDetail({ row }: { row: AdsCampaignRow }) {
  const used = row.periodBudget ? row.metrics.spend / row.periodBudget : 0;
  return (
    <div className="grid gap-4 p-4 md:grid-cols-[1.2fr_1fr_1.2fr]">
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Xu hướng trong kỳ</p>
        <MiniTrend points={row.trend} />
        <p className="flex gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden="true" className="h-0.5 w-3 rounded bg-metric-revenue" /> Doanh số Broad
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden="true" className="h-0.5 w-3 rounded border-t-2 border-dashed border-metric-spend" /> Chi tiêu
          </span>
        </p>
      </div>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Ngân sách đã dùng (ngân sách/ngày × số ngày có chi tiêu)</p>
          {row.periodBudget ? (
            <>
              <AdsProgress value={used} barClass={used >= 0.95 ? "bg-metric-acos" : used >= 0.8 ? "bg-metric-cpc" : "ads-gradient-primary"} label={`Ngân sách đã dùng — ${row.name}`} delay={60} />
              <p className="text-xs tabular-nums">
                <span className="font-semibold">{Math.round(used * 100)}%</span> <span className="text-muted-foreground">· {formatMetricDetailed("spend", row.metrics.spend)} / {formatMetricDetailed("spend", row.periodBudget)}</span>
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Chưa có ngân sách/ngày.</p>
          )}
        </div>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          {(
            [
              ["Hiển thị", formatInt(row.metrics.impressions)],
              ["Lượt nhấp", formatInt(row.metrics.clicks)],
              ["CVR Broad", formatMetric("conversionRate", row.metrics.conversionRate)],
              ["Doanh số Direct", formatMetric("directRevenue", row.metrics.directRevenue)],
              ["Đơn Direct", formatInt(row.metrics.directOrders)],
              ["ROAS Direct", formatMetric("directRoas", row.metrics.directRoas)],
              ...(row.roasTarget ? ([["ROAS mục tiêu (Shopee)", formatMetric("roas", row.roasTarget)]] as const) : []),
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-lg bg-ads-surface-strong px-2 py-1.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Sản phẩm được quảng cáo</p>
        <ul className="space-y-1.5">
          {row.topProducts.length === 0 && <li className="text-xs text-muted-foreground">—</li>}
          {row.topProducts.map((p) => {
            const status = productStatusLabel(p);
            return (
              <li key={p.itemId ?? p.name} data-product={p.itemId} data-enrichment={p.enrichment} className="flex items-center gap-2.5 rounded-lg border border-ads-border bg-card px-2.5 py-1.5 text-xs">
                <AdsProductThumb src={p.imageUrl} alt={p.name} size="lg" />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="line-clamp-2 font-medium" title={p.name}>
                    {p.name}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    {p.itemId ? (
                      <span>
                        ID <span className="font-mono">{p.itemId}</span>
                      </span>
                    ) : null}
                    {p.sku ? (
                      <span>
                        SKU <span className="font-mono">{p.sku}</span>
                      </span>
                    ) : null}
                    {status ? (
                      <span className="rounded-full bg-muted px-1.5 py-px" title={`Trạng thái sản phẩm trên Shopee: ${p.providerStatus}`}>
                        {status}
                      </span>
                    ) : null}
                    {p.enrichment === "pending" ? <span>Đang chờ bổ sung thông tin sản phẩm</span> : null}
                  </span>
                  <span className="block text-muted-foreground tabular-nums">
                    {p.revenue === null ? "—" : formatMetric("revenue", p.revenue)} · {p.orders === null ? "—" : `${formatInt(p.orders)} đơn`}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        {row.topProducts[0]?.enrichment === "enriched" && row.topProducts[0].name !== row.name ? (
          <p className="text-[11px] text-muted-foreground">
            Tên chiến dịch: <span className="text-foreground">{row.name}</span>
          </p>
        ) : null}
        {row.provider && (
          <p className="text-[11px] text-muted-foreground">
            Shopee: trạng thái <span className="font-mono">{row.provider.status}</span> · giá thầu <span className="font-mono">{row.provider.biddingMethod ?? "—"}</span> · vị trí <span className="font-mono">{row.provider.placement ?? "—"}</span> · ID <span className="font-mono">{row.provider.campaignId}</span>
          </p>
        )}
      </div>
    </div>
  );
}

export function AdsCampaignTable({
  rows,
  total,
  page,
  size,
  sort,
  desc,
  q,
  status,
  statusCounts,
  pathname,
  query,
}: {
  rows: AdsCampaignRow[];
  total: number;
  page: number;
  size: number;
  sort: AdsSortColumn;
  desc: boolean;
  q: string;
  status: AdsCampaignStatus | "all";
  statusCounts: Record<string, number>;
  pathname: string;
  /** Current URL query (filters + q / sort / dir; no page / size). */
  query: Record<string, string | undefined>;
}) {
  const id = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set());
  const toggle = (rowId: string) => {
    setMounted((m) => (m.has(rowId) ? m : new Set(m).add(rowId)));
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(rowId)) n.delete(rowId);
      else n.add(rowId);
      return n;
    });
  };
  const filtered = Boolean(q) || status !== "all";

  return (
    <div className="space-y-3" data-slot="ads-campaign-table">
      <FilterBar filterKeys={["q", "status"]}>
        <SearchInput paramKey="q" defaultValue={q} placeholder="Tìm chiến dịch / sản phẩm / SKU…" label="Tìm chiến dịch" className="sm:w-64 [&_input]:rounded-full" />
        <StatusChips value={status} counts={statusCounts} />
      </FilterBar>

      {total === 0 ? (
        <AdsEmptyState
          variant={filtered ? "no-results" : "no-data"}
          title={filtered ? "Không có chiến dịch nào khớp bộ lọc." : "Chưa có dữ liệu quảng cáo trong khoảng thời gian này."}
          description={filtered ? "Thử từ khóa khác hoặc bỏ lọc trạng thái." : "Chọn khoảng thời gian khác để xem chiến dịch."}
          action={
            <Link href={filtered ? buildListHref(pathname, { ...query, q: undefined, status: undefined, page: undefined }) : buildListHref(pathname, { ...query, period: "30d", from: undefined, to: undefined })} scroll={false} className="inline-flex h-8 items-center rounded-full border border-ads-border bg-card px-3 text-sm font-medium transition-colors hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
              {filtered ? "Xóa bộ lọc" : "Đổi khoảng thời gian"}
            </Link>
          }
        />
      ) : (
        <>
          <Table stickyHeader className="min-w-[1080px]">
            <TableHeader className="bg-ads-surface-strong">
              <TableRow>
                {COLUMNS.map((c) => (
                  <TableHead key={c.key} className={cn(c.align === "right" && "text-right", c.key === "name" && "pl-11")} aria-sort={sort === c.key ? (desc ? "descending" : "ascending") : undefined}>
                    <SortLink col={c.key} label={c.label} sort={sort} desc={desc} pathname={pathname} query={query} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const isOpen = open.has(r.id);
                const detailId = `${id}-${r.id}`;
                const shown = displayProduct(r);
                const extraProducts = r.topProducts.length - 1;
                const roasOk = meetsTarget("roas", r.metrics.roas);
                const acosOk = meetsTarget("acos", r.metrics.acos);
                return (
                  <Fragment key={r.id}>
                    <TableRow data-campaign={r.id} data-open={isOpen || undefined} className={cn("hover:bg-ads-surface-strong/70", isOpen && "border-b-0 bg-ads-surface-strong/60")}>
                      <TableCell className="max-w-[20rem]">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-controls={detailId}
                            aria-label={`${isOpen ? "Thu gọn" : "Xem chi tiết"} ${shown.name}`}
                            onClick={() => toggle(r.id)}
                            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--ads-dur-fast) hover:bg-ads-primary/10 hover:text-ads-primary-text focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                          >
                            <ChevronRight aria-hidden="true" className={cn("size-4 transition-transform duration-(--ads-dur-normal) ease-ads", isOpen && "rotate-90")} />
                          </button>
                          {shown.product?.enrichment ? <AdsProductThumb src={shown.product.imageUrl} alt={shown.name} /> : null}
                          <div className="min-w-0">
                            <p className="truncate font-medium text-heading" title={shown.name === r.name ? r.name : `${shown.name}\nChiến dịch: ${r.name}`}>
                              {shown.name}
                              {extraProducts > 0 ? <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground">+{extraProducts} SP</span> : null}
                            </p>
                            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={`${r.shopName} · ${TYPE_LABEL[r.type]}${shown.product?.sku ? ` · SKU ${shown.product.sku}` : ""}`}>
                              <ShopAvatar name={r.shopName} index={r.shopId.endsWith("2") ? 1 : 0} className="size-4 shrink-0 text-[8px]" />
                              <span className="truncate">
                                {r.shopName} · {TYPE_LABEL[r.type]}
                                {shown.product?.sku ? <span className="font-mono"> · {shown.product.sku}</span> : null}
                              </span>
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <AdsCampaignStatusBadge status={r.status} raw={r.provider?.status} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground" title={r.dailyBudget === null ? "Chưa đặt / chưa rõ" : formatMetricDetailed("spend", r.dailyBudget)}>
                        {r.dailyBudget === null ? "—" : formatMetric("spend", r.dailyBudget)}
                      </TableCell>
                      <TableCell className="text-right font-medium" title={formatMetricDetailed("spend", r.metrics.spend)}>
                        {formatMetric("spend", r.metrics.spend)}
                      </TableCell>
                      <TableCell className="text-right" title={formatMetricDetailed("revenue", r.metrics.revenue)}>
                        {formatMetric("revenue", r.metrics.revenue)}
                      </TableCell>
                      <TableCell className={cn("text-right", r.metrics.orders === 0 && r.metrics.spend > 0 && "font-medium text-danger-text")}>{formatInt(r.metrics.orders)}</TableCell>
                      <TableCell className="text-right">
                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", roasOk === null ? "text-muted-foreground" : roasOk ? "bg-success-soft text-success-text" : "bg-warning-soft text-warning-text")} title={roasOk === null ? undefined : roasOk ? `Đạt mục tiêu tham khảo ≥ ${formatMetric("roas", ADS_TARGETS.roas)}` : `Dưới mục tiêu tham khảo ${formatMetric("roas", ADS_TARGETS.roas)}`}>
                          {formatMetric("roas", r.metrics.roas)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">{formatMetric("ctr", r.metrics.ctr)}</TableCell>
                      <TableCell className="text-right">{formatMetric("cpc", r.metrics.cpc)}</TableCell>
                      <TableCell className={cn("text-right", acosOk === false && "text-danger-text")}>{formatMetric("acos", r.metrics.acos)}</TableCell>
                    </TableRow>
                    <tr className={cn(isOpen ? "border-b" : "border-0")} data-detail-for={r.id}>
                      <td colSpan={COLUMNS.length} className="p-0">
                        <div
                          id={detailId}
                          inert={!isOpen}
                          className={cn("grid transition-[grid-template-rows,opacity] duration-(--ads-dur-slow) ease-ads", isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
                        >
                          <div className="min-h-0 overflow-hidden bg-ads-surface/70">{mounted.has(r.id) && <CampaignDetail row={r} />}</div>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          <DataTablePagination pathname={pathname} query={query} page={page} pageSize={size} total={total} />
        </>
      )}
    </div>
  );
}
