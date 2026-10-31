import Link from "next/link";
import { notFound } from "next/navigation";
import { Activity, CloudDownload, HeartPulse, ListOrdered, PackageX, SearchX, Siren, Unplug } from "lucide-react";

import { hasPermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getShopeeFlags } from "@/lib/feature-flags";
import { getProductAnalyticsSyncConfig } from "@/lib/product-analytics/config";
import { PRODUCT_METRIC_META } from "@/lib/product-analytics/data-quality";
import { BROAD_GMV_TOOLTIP, fmt, minutesSince } from "@/lib/product-analytics/display";
import { loadIntelligenceList, type IntelListRow, type IntelSort } from "@/lib/product-analytics/intelligence";
import { loadShopFreshness, timedRead } from "@/lib/product-analytics/read-model";
import { parseProductAnalyticsQuery, productAnalyticsHref } from "@/lib/product-analytics/url-state";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/ui/format";
import { AdsSection } from "@/components/ads/ads-section";
import { AdsEmptyState } from "@/components/ads/ads-states";
import { PaFilterBar } from "@/components/product-analytics/pa-filter-bar";
import { PaHeroKpi, PaKpiCard } from "@/components/product-analytics/pa-kpi-card";
import { PaAttentionCards, PaHealthSummary, PaShopContextNote } from "@/components/product-analytics/pa-overview";
import { PaPageHeader } from "@/components/product-analytics/pa-page-header";
import { PaPagination, PaProductList } from "@/components/product-analytics/pa-product-list";
import { PaNotice } from "@/components/product-analytics/pa-notice";

import { queueProductAnalyticsRefresh, setProductAnalyticsShopSwitch } from "./actions";

export const dynamic = "force-dynamic";

const PATH = "/shopee/product-analytics";

// PRODUCT-ANALYTICS-3: friendly product-health dashboard. ONE RPC
// (product_intelligence_list) returns the page of 50 rows + hero + health
// distribution + attention products — filtered / sorted / paged in SQL.
// DB only: opening, paging or filtering makes 0 Shopee calls. No AI.
export default async function ProductAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!getShopeeFlags().adsEnabled) notFound();
  const auth = await requirePermission("channel:view");
  const canManage = hasPermission(auth.profile.role, "channel:manage");
  const sp = await searchParams;
  const state = parseProductAnalyticsQuery(sp);
  const db = createAdminClient();
  const now = new Date();

  const { data: shopRows } = await db.from("shops").select("id, shop_name").eq("channel", "shopee").eq("data_source", "live").eq("is_active", true).order("shop_name");
  const shops = (shopRows ?? []) as Array<{ id: string; shop_name: string }>;
  const nameOf = new Map(shops.map((s) => [s.id, s.shop_name]));
  const shopName = (id: string) => nameOf.get(id) ?? "—";
  const selected = state.shop === "all" ? shops.map((s) => s.id) : shops.filter((s) => s.id === state.shop).map((s) => s.id);
  const p = state.period;
  const l = state.list;

  const {
    value: [list, freshness],
    ms: queryMs,
  } = await timedRead(() => Promise.all([loadIntelligenceList(db, selected, p, l), loadShopFreshness(db, shops.map((s) => s.id))]));
  const summary = list.summary;
  const hero = summary?.hero;
  const config = getProductAnalyticsSyncConfig();

  // URL helpers (defaults dropped so links stay short)
  const current: Record<string, string | undefined> = {
    period: p.preset === "7d" ? undefined : p.preset,
    from: p.preset === "custom" ? p.from : undefined,
    to: p.preset === "custom" ? p.to : undefined,
    shop: state.shop,
    q: l.q || undefined,
    ads: l.ads,
    status: l.status,
    health: l.health,
    signal: l.signal,
    sort: l.sort === "priority" ? undefined : l.sort,
    dir: l.dir === "desc" ? undefined : l.dir,
    size: l.pageSize === 50 ? undefined : String(l.pageSize),
  };
  const href = (patch: Record<string, string | undefined>) => productAnalyticsHref(PATH, current, { page: undefined, ...patch });
  const sortHref = (k: IntelSort) => {
    const dir = l.sort === k ? (l.dir === "desc" ? "asc" : "desc") : k === "name" ? "asc" : "desc";
    return href({ sort: k === "priority" ? undefined : k, dir: dir === "desc" ? undefined : dir });
  };
  const periodQuery = { period: current.period, from: current.from, to: current.to };
  const rowHref = (r: IntelListRow) => productAnalyticsHref(`${PATH}/${r.id}`, periodQuery, {});

  // scope / freshness
  const scope = list.shops;
  const noData = scope.filter((s) => s.sales_state === "no_data");
  const notBackfilled = scope.filter((s) => s.sales_state === "not_backfilled");
  const prevUncovered = scope.filter((s) => s.sales_state === "covered" && s.current_complete && !s.previous_complete);
  const stale = scope.filter((s) => s.sales_state !== "no_data" && s.sales_stale);
  const salesAge = minutesSince(hero?.sales_oldest_success_at ?? null, now);
  const adsAge = minutesSince(hero?.ads_today_at ?? null, now);
  const scopeLabel = state.shop === "all" ? `Tất cả ${shops.length} shop` : shopName(state.shop);
  const sameTimeOk = !p.partialToday || (p.hourCutoff !== null && p.hourCutoff > 0);
  const salesUnavailable = !sameTimeOk
    ? "Chưa có giờ hoàn tất để so sánh"
    : hero?.sales_availability === "no_data"
      ? "Chưa có dữ liệu đơn hàng"
      : hero?.sales_availability === "lower_bound"
        ? "Chưa đủ dữ liệu — mức tối thiểu, không so sánh"
        : "Kỳ so sánh chưa có dữ liệu đầy đủ";
  const adsUnavailable = !sameTimeOk ? "Chưa có giờ hoàn tất để so sánh" : "Chưa có dữ liệu Ads theo giờ của kỳ so sánh";

  return (
    <div data-ads-root className="space-y-5">
      <PaPageHeader
        title="Phân tích sản phẩm"
        subtitle="Sức khỏe từng sản phẩm: doanh số từ đơn hàng đặt cạnh hiệu quả quảng cáo. Tín hiệu là quan sát, không phải nguyên nhân."
        preset={p.preset}
        rangeLabel={p.from === p.to ? p.from : `${p.from} → ${p.to}`}
        compareLabel={p.prevFrom === p.prevTo ? p.prevFrom : `${p.prevFrom} → ${p.prevTo}`}
        scopeLabel={scopeLabel}
        salesAgeMinutes={salesAge}
        salesStale={stale.length > 0}
        adsAgeMinutes={adsAge}
        partialToday={p.partialToday}
        hourCutoff={p.hourCutoff}
      />

      <div className="animate-ads-rise" style={{ "--ads-delay": "40ms" } as React.CSSProperties}>
        <PaFilterBar path={PATH} state={state} shops={shops} statuses={list.statuses} resetHref={productAnalyticsHref(PATH, periodQuery, {})} />
      </div>

      {selected.length === 0 ? (
        <AdsSection title="Tổng quan" icon={Activity}>
          <AdsEmptyState icon={Unplug} title="Chưa có shop Shopee nào đang kết nối" description="Kết nối shop để bắt đầu theo dõi sản phẩm." />
        </AdsSection>
      ) : (
        <>
          <div className="space-y-2" data-slot="pa-notices">
            {noData.length > 0 && (
              <PaNotice tone="warning" title="Một số shop chưa có dữ liệu bán hàng" icon={PackageX}>
                {noData.map((s) => shopName(s.shop_id)).join(", ")}: chưa đồng bộ đơn hàng. Sản phẩm có Ads vẫn hiển thị; doanh số hiện “—” (chưa có, không phải 0).
              </PaNotice>
            )}
            {notBackfilled.length > 0 && (
              <PaNotice tone="warning" title="Doanh số chưa đầy đủ — đang chờ backfill" icon={CloudDownload}>
                {notBackfilled.map((s) => shopName(s.shop_id)).join(", ")}: chưa backfill 30 ngày. Doanh số là mức tối thiểu (≥) và không tính % thay đổi.
              </PaNotice>
            )}
            {prevUncovered.length > 0 && (
              <PaNotice tone="info" title="Kỳ so sánh chưa có dữ liệu" icon={Activity}>
                {prevUncovered.map((s) => `${shopName(s.shop_id)} (đủ từ ${s.covered_from})`).join(", ")}: kỳ trước bắt đầu sớm hơn ngày có dữ liệu đầy đủ — không tính Δ doanh số. Chọn “7 ngày” để so sánh.
              </PaNotice>
            )}
            {stale.length > 0 && (
              <PaNotice tone="warning" title="Dữ liệu đơn hàng chưa mới" icon={Siren}>
                {stale.map((s) => `${shopName(s.shop_id)} (${s.sales_age_minutes ?? "?"} phút)`).join(", ")} — lần đọc đơn hàng gần nhất đã cũ hơn ngưỡng; số liệu có thể thiếu các đơn mới.
              </PaNotice>
            )}
          </div>

          {hero && (
            <section aria-label="Chỉ số chính" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-slot="pa-hero-metrics">
              <PaHeroKpi
                label="Doanh số"
                delta={hero.gmv}
                availability={hero.sales_availability}
                comparable={hero.sales_comparable}
                unavailableText={salesUnavailable}
                tooltip={`${PRODUCT_METRIC_META.sales_gmv.note} Toàn bộ shop trong phạm vi (không phụ thuộc bộ lọc sản phẩm).`}
                className="sm:col-span-2 lg:row-span-2"
                footer={
                  <span className="text-white/85 tabular-nums">
                    {summary.products.toLocaleString("vi-VN")} sản phẩm có hoạt động
                    {hero.sales_excluded_shops > 0 ? ` · không gồm ${hero.sales_excluded_shops} shop chưa có dữ liệu bán hàng` : ""}
                  </span>
                }
              />
              <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:col-span-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:contents">
                <PaKpiCard label="Đơn hàng" look="orders" metric="orders" delta={hero.orders} availability={hero.sales_availability} comparable={hero.sales_comparable} unavailableText={salesUnavailable} tooltip="Số đơn DISTINCT của shop (một đơn nhiều sản phẩm chỉ tính 1 lần), theo ngày tạo đơn, giờ VN." delay={80} className="w-[72%] shrink-0 snap-start sm:w-auto" />
                <PaKpiCard label="Số lượng bán" look="orders" metric="units" delta={hero.units} availability={hero.sales_availability} comparable={hero.sales_comparable} unavailableText={salesUnavailable} tooltip={PRODUCT_METRIC_META.units.note} delay={105} className="w-[72%] shrink-0 snap-start sm:w-auto" />
                <PaKpiCard label="Chi Ads (toàn shop)" look="spend" metric="ads_spend" delta={hero.ads_spend} comparable={hero.ads_comparable} unavailableText={adsUnavailable} tooltip="Tổng chi quảng cáo cấp shop (mọi loại campaign), từ báo cáo Shopee Ads. Chi tăng không tự nó là tốt hay xấu." delay={130} className="w-[72%] shrink-0 snap-start sm:w-auto" />
                <PaKpiCard label="ROAS Broad (toàn shop)" look="roas" metric="ads_broad_roas" delta={hero.ads_broad_roas} comparable={hero.ads_comparable} unavailableText={adsUnavailable} tooltip={`Broad GMV ÷ chi Ads cấp shop (tổng / tổng). ${BROAD_GMV_TOOLTIP}`} delay={155} className="w-[72%] shrink-0 snap-start sm:w-auto" />
              </div>
            </section>
          )}

          {summary && list.total > 0 && (
            <AdsSection id="pa-health" title="Sức khỏe sản phẩm" description="Phân loại mô tả từ các tín hiệu — bấm để lọc danh sách" icon={HeartPulse} iconClass="bg-success-soft text-success-text" delay={120}>
              <PaHealthSummary summary={summary} active={l.health} hrefFor={(h) => href({ health: h })} />
              <div className="mt-3">
                <PaShopContextNote ctx={summary.shop_context} shopName={shopName} />
              </div>
            </AdsSection>
          )}

          {summary && list.total > 0 && (
            <AdsSection
              id="pa-attention"
              title="Sản phẩm cần chú ý"
              description="Xếp theo mức ưu tiên: quy mô kinh doanh × mức độ tín hiệu bất lợi × độ tin cậy dữ liệu"
              icon={Siren}
              iconClass="bg-warning-soft text-warning-text"
              delay={160}
              actions={
                summary.needs_attention > summary.top_attention.length ? (
                  <Link href={href({ health: "ATTENTION" })} scroll={false} className="text-sm font-medium text-ads-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                    Xem tất cả {summary.needs_attention}
                  </Link>
                ) : undefined
              }
            >
              {summary.top_attention.length > 0 ? (
                <PaAttentionCards rows={summary.top_attention} hrefFor={rowHref} shopName={shopName} />
              ) : (
                <AdsEmptyState compact title="Không có sản phẩm nào cần chú ý." description={hero?.sales_comparable ? "Không có sản phẩm quy mô đáng kể nào có tín hiệu bất lợi so với kỳ trước." : "Kỳ này chưa so sánh được doanh số — chọn “7 ngày” để có tín hiệu đầy đủ."} />
              )}
            </AdsSection>
          )}

          <AdsSection
            id="pa-products"
            title="Danh sách sản phẩm"
            description={`${list.filtered.toLocaleString("vi-VN")} / ${list.total.toLocaleString("vi-VN")} sản phẩm có doanh số hoặc quảng cáo · ${queryMs} ms`}
            icon={ListOrdered}
            delay={200}
          >
            {list.total === 0 ? (
              <AdsEmptyState
                title="Chưa có sản phẩm nào có doanh số hoặc quảng cáo trong kỳ này."
                description={noData.length === scope.length ? "Chưa có dữ liệu đơn hàng — bật đồng bộ đơn hàng cho shop ở mục bên dưới." : "Thử chọn khoảng thời gian dài hơn."}
                action={
                  <Link href={productAnalyticsHref(PATH, { shop: current.shop }, { period: "30d" })} className="inline-flex h-8 items-center rounded-full border border-ads-border bg-card px-3 text-sm font-medium hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                    Xem 30 ngày
                  </Link>
                }
              />
            ) : list.filtered === 0 ? (
              <AdsEmptyState
                variant="no-results"
                icon={SearchX}
                title="Không có sản phẩm khớp bộ lọc."
                description="Thử bỏ bớt bộ lọc hoặc tìm bằng tên / SKU / item ID khác (không dấu cũng được)."
                action={
                  <Link href={productAnalyticsHref(PATH, periodQuery, {})} className="inline-flex h-8 items-center rounded-full border border-ads-border bg-card px-3 text-sm font-medium hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                    Bỏ lọc
                  </Link>
                }
              />
            ) : (
              <>
                <PaProductList rows={list.rows} sort={l.sort} dir={l.dir} sortHref={sortHref} rowHref={rowHref} shopName={shopName} showShop={state.shop === "all"} />
                <PaPagination
                  page={list.page}
                  pageSize={list.page_size}
                  filtered={list.filtered}
                  hrefFor={(n) => href({ page: n > 1 ? String(n) : undefined })}
                  sizeHref={(s) => href({ size: s === 50 ? undefined : String(s) })}
                />
              </>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              Doanh số = Σ đơn giá sau giảm giá sản phẩm × số lượng của đơn hợp lệ (trước voucher / phí ship, chưa trừ hoàn trả). Ads chỉ tính campaign quảng cáo riêng sản phẩm đó. Broad GMV / ROAS là số attribution
              của Shopee Ads — không phải phần doanh số do Ads tạo ra.
            </p>
          </AdsSection>
        </>
      )}

      <AdsSection id="pa-sync" title="Đồng bộ dữ liệu sản phẩm (chỉ đọc)" description={`Đơn hàng: ${config.salesSyncEnabled ? "BẬT" : "TẮT"} · Snapshot: ${config.extraInfoSyncEnabled ? "BẬT" : "TẮT"} · module đơn hàng cũ vẫn tắt`} icon={CloudDownload} iconClass="bg-ads-accent/12 text-ads-accent-text" delay={240}>
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-slot="pa-sync-shops">
          {shops.map((s) => {
            const f = freshness.get(s.id);
            const ctx = scope.find((x) => x.shop_id === s.id);
            return (
              <li key={s.id} className="flex flex-col gap-2 rounded-xl border border-ads-border bg-ads-surface p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{s.shop_name}</p>
                  <span className={f?.sales_enabled ? "rounded-full bg-success-soft px-2 py-0.5 font-medium text-success-text" : "rounded-full bg-muted px-2 py-0.5 text-muted-foreground"}>{f?.sales_enabled ? "Đang đồng bộ" : "Chưa bật"}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
                  <dt>Lần đọc gần nhất</dt>
                  <dd className="text-right text-foreground tabular-nums">{f?.sales_last_success_at ? formatDateTime(f.sales_last_success_at) : "—"}</dd>
                  <dt>Backfill 30 ngày</dt>
                  <dd className="text-right text-foreground">{f?.sales_backfill_done_at ? `Xong · đủ từ ${ctx?.covered_from ?? "?"}` : "Chưa"}</dd>
                  <dt>Dòng đơn</dt>
                  <dd className="text-right text-foreground tabular-nums">{fmt.int(f?.fact_lines ?? 0)}</dd>
                  <dt>Snapshot</dt>
                  <dd className="text-right text-foreground">{f?.extra_info_enabled ? "Bật" : "Tắt"}</dd>
                  {f && f.sales_active_jobs > 0 && (
                    <>
                      <dt>Job đang chờ/chạy</dt>
                      <dd className="text-right text-foreground tabular-nums">{f.sales_active_jobs}</dd>
                    </>
                  )}
                </dl>
                {canManage && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <form action={setProductAnalyticsShopSwitch}>
                      <input type="hidden" name="shopId" value={s.id} />
                      <input type="hidden" name="field" value="sales_sync_enabled" />
                      <input type="hidden" name="value" value={f?.sales_enabled ? "false" : "true"} />
                      <button type="submit" className="h-7 rounded-full border border-ads-border bg-card px-2.5 font-medium hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                        {f?.sales_enabled ? "Tắt đơn hàng" : "Bật đơn hàng"}
                      </button>
                    </form>
                    <form action={setProductAnalyticsShopSwitch}>
                      <input type="hidden" name="shopId" value={s.id} />
                      <input type="hidden" name="field" value="extra_info_enabled" />
                      <input type="hidden" name="value" value={f?.extra_info_enabled ? "false" : "true"} />
                      <button type="submit" className="h-7 rounded-full border border-ads-border bg-card px-2.5 font-medium hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                        {f?.extra_info_enabled ? "Tắt snapshot" : "Bật snapshot"}
                      </button>
                    </form>
                    <form action={queueProductAnalyticsRefresh}>
                      <input type="hidden" name="shopId" value={s.id} />
                      <input type="hidden" name="kind" value="sales" />
                      <button type="submit" title="Xếp hàng 1 job đọc đơn hàng 48 giờ gần nhất" className="h-7 rounded-full border border-ads-border bg-card px-2.5 font-medium hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                        Làm mới đơn
                      </button>
                    </form>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          “Bật đơn hàng” bật đồng bộ định kỳ (backfill 30 ngày, rồi đọc mỗi 30 phút). “Làm mới đơn” chỉ xếp hàng MỘT lần đọc đơn của 48 giờ gần nhất. Trình duyệt không gọi Shopee.
        </p>
      </AdsSection>
    </div>
  );
}
