import Link from "next/link";
import { notFound } from "next/navigation";

import { hasPermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { formatInt, formatRoas, formatVndCompact } from "@/lib/channels/shopee/ads/metrics";
import { getShopeeFlags } from "@/lib/feature-flags";
import { getProductAnalyticsSyncConfig } from "@/lib/product-analytics/config";
import { PRODUCT_PERIOD_LABELS, PRODUCT_PERIOD_PRESETS } from "@/lib/product-analytics/periods";
import { filterProductList, loadProductList, loadShopFreshness, timedRead } from "@/lib/product-analytics/read-model";
import { parseProductAnalyticsQuery, PRODUCT_LIST_PAGE_SIZE, productAnalyticsHref } from "@/lib/product-analytics/url-state";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/ui/format";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader, SectionHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { queueProductAnalyticsRefresh, setProductAnalyticsShopSwitch } from "./actions";
import { DeltaText, ProductThumb } from "./product-bits";

export const dynamic = "force-dynamic";

const PATH = "/shopee/product-analytics";
const KEYS = ["period", "from", "to", "shop", "q", "ads", "status", "sort", "dir"] as const;

// PRODUCT-ANALYTICS-2: product list (NOT an AI report). DB only — opening the
// page makes 0 Shopee calls. Sales = order facts; Ads = single-item campaigns.
export default async function ProductAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!getShopeeFlags().adsEnabled) notFound();
  const auth = await requirePermission("channel:view");
  const canManage = hasPermission(auth.profile.role, "channel:manage");
  const sp = await searchParams;
  const state = parseProductAnalyticsQuery(sp);
  const current = Object.fromEntries(KEYS.map((k) => [k, Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined)]));
  const db = createAdminClient();

  const { data: shopRows } = await db.from("shops").select("id, shop_name").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true).order("shop_name");
  const shops = (shopRows ?? []) as Array<{ id: string; shop_name: string }>;
  const shopName = new Map(shops.map((s) => [s.id, s.shop_name]));
  const selected = state.shop === "all" ? shops.map((s) => s.id) : shops.filter((s) => s.id === state.shop).map((s) => s.id);

  const {
    value: [rows, freshness],
    ms: queryMs,
  } = await timedRead(() => Promise.all([loadProductList(db, selected, state.period), loadShopFreshness(db, shops.map((s) => s.id))]));
  const filtered = filterProductList(rows, state.list);
  const pages = Math.max(1, Math.ceil(filtered.length / PRODUCT_LIST_PAGE_SIZE));
  const page = Math.min(state.page, pages);
  const visible = filtered.slice((page - 1) * PRODUCT_LIST_PAGE_SIZE, page * PRODUCT_LIST_PAGE_SIZE);
  const config = getProductAnalyticsSyncConfig();
  const statuses = [...new Set(rows.map((r) => r.status ?? "UNKNOWN"))].sort();
  const p = state.period;
  const sortHref = (key: string) => productAnalyticsHref(PATH, current, { sort: key, dir: state.list.sort === key && state.list.dir === "desc" ? "asc" : "desc", page: undefined });
  const salesMissing = selected.filter((id) => !freshness.get(id)?.sales_last_success_at);

  return (
    <PageContainer>
      <PageHeader
        title="Phân tích sản phẩm Shopee"
        description="Doanh số theo đơn hàng (chỉ đọc) đặt cạnh hiệu quả quảng cáo, theo từng sản phẩm. Chưa có phân tích AI."
        meta={<span className="text-xs text-muted-foreground">Kỳ {p.from} → {p.to} · so với {p.prevFrom} → {p.prevTo} · {queryMs} ms</span>}
      />

      <form method="get" action={PATH} className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Kỳ</span>
          <select name="period" defaultValue={p.preset} className="h-9 rounded-md border bg-background px-2">
            {PRODUCT_PERIOD_PRESETS.map((k) => (
              <option key={k} value={k}>{PRODUCT_PERIOD_LABELS[k]}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Từ (tùy chỉnh)</span>
          <input type="date" name="from" defaultValue={p.preset === "custom" ? p.from : ""} className="h-9 rounded-md border bg-background px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Đến</span>
          <input type="date" name="to" defaultValue={p.preset === "custom" ? p.to : ""} className="h-9 rounded-md border bg-background px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Shop</span>
          <select name="shop" defaultValue={state.shop} className="h-9 rounded-md border bg-background px-2">
            <option value="all">Tất cả shop</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>{s.shop_name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Quảng cáo</span>
          <select name="ads" defaultValue={state.list.ads} className="h-9 rounded-md border bg-background px-2">
            <option value="all">Tất cả</option>
            <option value="with">Có Ads</option>
            <option value="without">Không Ads</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Trạng thái</span>
          <select name="status" defaultValue={state.list.status} className="h-9 rounded-md border bg-background px-2">
            <option value="all">Tất cả</option>
            {statuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Tìm (tên, SKU, item ID — không dấu cũng được)</span>
          <input name="q" defaultValue={state.list.q} placeholder="vd: tham long xu" className="h-9 rounded-md border bg-background px-2" />
        </label>
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-primary-foreground">Lọc</button>
      </form>

      {p.partialToday && (
        <Callout tone="info" title="Hôm nay chưa hết ngày">
          {p.hourCutoff !== null ? `So sánh đến cùng ${p.hourCutoff}:00 của kỳ trước (đơn tạo trước ${p.hourCutoff}:00). % thay đổi trong bảng là của cả ngày — xem chi tiết sản phẩm để so sánh cùng giờ.` : "Kỳ có chứa hôm nay (chưa hết ngày): % thay đổi chỉ mang tính tham khảo."}
        </Callout>
      )}
      {salesMissing.length > 0 && (
        <Callout tone="warning" title="Một số shop chưa có dữ liệu bán hàng">
          {salesMissing.map((id) => shopName.get(id)).join(", ")}: chưa đồng bộ đơn hàng (product_sales_facts_read). Sản phẩm có Ads vẫn hiển thị nhưng doanh số là 0 / chưa có.
        </Callout>
      )}

      <Card>
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <EmptyState title="Không có sản phẩm" description="Chưa có sản phẩm có doanh số hoặc quảng cáo trong kỳ này (hoặc không khớp bộ lọc)." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sản phẩm</TableHead>
                  <TableHead className="text-right"><Link href={sortHref("gmv")}>Doanh số</Link></TableHead>
                  <TableHead className="text-right"><Link href={sortHref("orders")}>Đơn</Link></TableHead>
                  <TableHead className="text-right"><Link href={sortHref("units")}>SL</Link></TableHead>
                  <TableHead className="text-right"><Link href={sortHref("gmv_pct")}>Δ doanh số</Link></TableHead>
                  <TableHead className="text-right"><Link href={sortHref("spend")}>Chi Ads</Link></TableHead>
                  <TableHead className="text-right"><Link href={sortHref("spend_pct")}>Δ chi</Link></TableHead>
                  <TableHead className="text-right"><Link href={sortHref("broad_gmv")}>Broad GMV</Link></TableHead>
                  <TableHead className="text-right"><Link href={sortHref("broad_roas")}>ROAS Broad</Link></TableHead>
                  <TableHead className="text-right">Δ ROAS</TableHead>
                  <TableHead className="text-right">Click</TableHead>
                  <TableHead>Dữ liệu</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => {
                  const f = freshness.get(r.shop_id);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="min-w-64">
                        <Link href={productAnalyticsHref(`${PATH}/${r.id}`, { period: current.period, from: current.from, to: current.to }, {})} className="flex items-center gap-3 hover:underline">
                          <ProductThumb url={r.image_url} />
                          <span className="min-w-0">
                            <span className="line-clamp-2 font-medium">{r.name ?? `#${r.item_id}`}</span>
                            <span className="block text-xs text-muted-foreground">
                              {r.sku ? `SKU ${r.sku} · ` : ""}
                              {shopName.get(r.shop_id) ?? ""} · {r.item_id}
                            </span>
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatVndCompact(r.gmv)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatInt(r.orders)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatInt(r.units)}</TableCell>
                      <TableCell className="text-right"><DeltaText pct={r.gmv_pct} /></TableCell>
                      <TableCell className="text-right tabular-nums">{r.campaigns > 0 ? formatVndCompact(r.spend) : "—"}</TableCell>
                      <TableCell className="text-right"><DeltaText pct={r.campaigns > 0 ? r.spend_pct : null} neutral /></TableCell>
                      <TableCell className="text-right tabular-nums">{r.campaigns > 0 ? formatVndCompact(r.broad_gmv) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.campaigns > 0 ? formatRoas(r.broad_roas) : "—"}</TableCell>
                      <TableCell className="text-right"><DeltaText pct={r.campaigns > 0 ? r.roas_pct : null} /></TableCell>
                      <TableCell className="text-right tabular-nums">{r.campaigns > 0 ? formatInt(r.clicks) : "—"}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {!f?.sales_last_success_at ? <StatusBadge tone="warning">Chưa có doanh số</StatusBadge> : r.orders === 0 && r.campaigns > 0 ? <StatusBadge tone="neutral">Ads, 0 đơn</StatusBadge> : null}
                          {r.campaigns === 0 && <StatusBadge tone="neutral" icon={false}>Không Ads</StatusBadge>}
                          {r.shared_campaigns > 0 && <StatusBadge tone="info" icon={false}>{r.shared_campaigns} campaign chung</StatusBadge>}
                          {r.status && r.status !== "NORMAL" && <StatusBadge tone="danger" icon={false}>{r.status}</StatusBadge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{formatInt(filtered.length)} sản phẩm · trang {page}/{pages}</span>
        <span className="flex gap-3">
          {page > 1 && <Link href={productAnalyticsHref(PATH, current, { page: String(page - 1) })} className="underline">← Trước</Link>}
          {page < pages && <Link href={productAnalyticsHref(PATH, current, { page: String(page + 1) })} className="underline">Sau →</Link>}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        Doanh số = Σ đơn giá sau giảm giá sản phẩm × số lượng của đơn hợp lệ (trước voucher / phí ship, chưa trừ hoàn trả). Broad GMV / ROAS là số attribution của Shopee Ads — không phải phần doanh số do Ads tạo ra, và
        không suy ra được doanh số tự nhiên bằng phép trừ.
      </p>

      <section className="space-y-3">
        <SectionHeader title="Đồng bộ dữ liệu sản phẩm (chỉ đọc)" description={`Đơn hàng: ${config.salesSyncEnabled ? "BẬT" : "TẮT"} (PRODUCT_SALES_SYNC_ENABLED) · Snapshot sản phẩm: ${config.extraInfoSyncEnabled ? "BẬT" : "TẮT"} (PRODUCT_EXTRA_INFO_SYNC_ENABLED). Module đơn hàng cũ vẫn tắt.`} />
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shop</TableHead>
                  <TableHead>Đơn hàng</TableHead>
                  <TableHead>Lần đọc gần nhất</TableHead>
                  <TableHead>Backfill 30 ngày</TableHead>
                  <TableHead className="text-right">Dòng đơn</TableHead>
                  <TableHead>Khoảng ngày</TableHead>
                  <TableHead>Snapshot</TableHead>
                  {canManage && <TableHead>Điều khiển</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shops.map((s) => {
                  const f = freshness.get(s.id);
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.shop_name}</TableCell>
                      <TableCell>{f?.sales_enabled ? <StatusBadge tone="success">Bật</StatusBadge> : <StatusBadge tone="neutral">Tắt</StatusBadge>}</TableCell>
                      <TableCell className="text-xs">{f?.sales_last_success_at ? formatDateTime(f.sales_last_success_at) : "—"}{f && f.sales_active_jobs > 0 ? ` · ${f.sales_active_jobs} job đang chờ/chạy` : ""}</TableCell>
                      <TableCell className="text-xs">{f?.sales_backfill_done_at ? formatDateTime(f.sales_backfill_done_at) : "Chưa"}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatInt(f?.fact_lines ?? 0)}</TableCell>
                      <TableCell className="text-xs">{f?.first_report_date ? `${f.first_report_date} → ${f.last_report_date}` : "—"}</TableCell>
                      <TableCell className="text-xs">{f?.extra_info_enabled ? "Bật" : "Tắt"}{f?.extra_info_last_captured_at ? ` · ${formatDateTime(f.extra_info_last_captured_at)}` : ""}</TableCell>
                      {canManage && (
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            <form action={setProductAnalyticsShopSwitch}>
                              <input type="hidden" name="shopId" value={s.id} />
                              <input type="hidden" name="field" value="sales_sync_enabled" />
                              <input type="hidden" name="value" value={f?.sales_enabled ? "false" : "true"} />
                              <button type="submit" className="rounded border px-2 py-1 text-xs">{f?.sales_enabled ? "Tắt đơn hàng" : "Bật đơn hàng"}</button>
                            </form>
                            <form action={setProductAnalyticsShopSwitch}>
                              <input type="hidden" name="shopId" value={s.id} />
                              <input type="hidden" name="field" value="extra_info_enabled" />
                              <input type="hidden" name="value" value={f?.extra_info_enabled ? "false" : "true"} />
                              <button type="submit" className="rounded border px-2 py-1 text-xs">{f?.extra_info_enabled ? "Tắt snapshot" : "Bật snapshot"}</button>
                            </form>
                            <form action={queueProductAnalyticsRefresh}>
                              <input type="hidden" name="shopId" value={s.id} />
                              <input type="hidden" name="kind" value="sales" />
                              <button type="submit" className="rounded border px-2 py-1 text-xs" title="Xếp hàng 1 job đọc đơn hàng 48 giờ gần nhất">Làm mới đơn</button>
                            </form>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">&quot;Làm mới&quot; chỉ xếp hàng một job đọc; worker chạy job khi cờ môi trường tương ứng đang bật. Trình duyệt không gọi Shopee.</p>
      </section>
    </PageContainer>
  );
}
