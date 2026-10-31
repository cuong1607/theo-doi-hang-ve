// ============================================================
// PRODUCT-ANALYTICS-2: data quality + semantic confidence metadata for every
// metric the UI / a future agent sees (spec §28, §39–41). Pure.
// ============================================================
import { PRODUCT_SIGNAL_THRESHOLDS, type ProductSignalThresholds } from "./config.ts";
import { salesCoverage, salesCoverageNote, type SalesCoverage } from "./coverage.ts";
import type { MetricMeta, ProductSummary, ShopFreshnessRow } from "./types.ts";

/** Per metric: where it comes from and how sure we are of what it MEANS. */
export const PRODUCT_METRIC_META: Record<string, MetricMeta> = {
  sales_gmv: { source: "shopee_product_sales_facts (get_order_detail)", semantic_confidence: "HIGH", note: "Σ đơn giá sau giảm giá sản phẩm × số lượng (trừ phần bị hủy), đơn hợp lệ; TRƯỚC voucher shop/sàn và phí ship; không trừ hoàn trả." },
  orders: { source: "shopee_product_sales_facts", semantic_confidence: "HIGH", note: "Số đơn DISTINCT có dòng hợp lệ của sản phẩm, theo ngày tạo đơn (giờ VN)." },
  units: { source: "shopee_product_sales_facts", semantic_confidence: "HIGH", note: "Σ (số lượng − số lượng bị hủy) của dòng hợp lệ; quà tặng kèm 0đ không tính." },
  ads_spend: { source: "shopee_ads_campaign_daily_performance (campaign 1 sản phẩm)", semantic_confidence: "HIGH", note: "Chỉ campaign quảng cáo duy nhất sản phẩm này; campaign nhiều sản phẩm không được chia." },
  ads_broad_gmv: { source: "Shopee Ads report", semantic_confidence: "HIGH", note: "Chỉ số ATTRIBUTION của Shopee Ads (cửa sổ quy đổi của Shopee) — không phải doanh số thực của sản phẩm." },
  ads_direct_gmv: { source: "Shopee Ads report", semantic_confidence: "HIGH", note: "Attribution trực tiếp của Shopee Ads." },
  broad_gmv_to_sales_indicator: { source: "Ads broad GMV ÷ sales GMV", semantic_confidence: "LOW", note: "Chỉ báo 'Ads attribution / tổng doanh số' — KHÔNG phải tỷ trọng doanh số do Ads; hai nguồn khác cách quy đổi và thời điểm." },
  views_snapshot: { source: "get_item_extra_info", semantic_confidence: "UNKNOWN", note: "Snapshot hiện tại của Shopee; ý nghĩa (trọn đời / cửa sổ) CHƯA xác minh — không so sánh kỳ." },
  sale_snapshot: { source: "get_item_extra_info", semantic_confidence: "UNKNOWN", note: "Bộ đếm 'sale' của Shopee; ý nghĩa CHƯA xác minh — không dùng làm doanh số ngày." },
  likes_snapshot: { source: "get_item_extra_info", semantic_confidence: "LOW", note: "Snapshot hiện tại." },
  rating_snapshot: { source: "get_item_extra_info", semantic_confidence: "MEDIUM", note: "Điểm đánh giá hiện tại." },
  comment_count_snapshot: { source: "get_item_extra_info", semantic_confidence: "LOW", note: "Snapshot hiện tại." },
};

export interface ProductDataQuality {
  sales_freshness: { last_success_at: string | null; age_minutes: number | null; stale: boolean; backfill_done: boolean; enabled: boolean };
  ads_freshness: { last_today_read_at: string | null; age_minutes: number | null; stale: boolean };
  extra_info_freshness: { last_captured_at: string | null; age_hours: number | null; stale: boolean };
  missing_sources: string[];
  partial_today: boolean;
  /** Comparison of a partial today is cut at the same completed hour on both days. */
  same_time_comparison: { applied: boolean; hour_cutoff: number | null; sales_available: boolean; ads_available: boolean };
  semantic_warnings: string[];
  /** Whether the period's sales are complete — missing data is never shown as 0. */
  sales_coverage: SalesCoverage;
}

const ageMinutes = (iso: string | null, now: Date) => (iso ? Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000)) : null);

export function buildProductDataQuality(input: {
  now: Date;
  freshness: ShopFreshnessRow | null;
  summary: ProductSummary | null;
  partialToday: boolean;
  hourCutoff: number | null;
  /** Period being read (coverage); omitted = treated as the most recent day only. */
  period?: { from: string; prevFrom: string };
  thresholds?: ProductSignalThresholds;
}): ProductDataQuality {
  const t = input.thresholds ?? PRODUCT_SIGNAL_THRESHOLDS;
  const f = input.freshness;
  const coverage = salesCoverage(f, input.period ?? { from: "9999-12-31", prevFrom: "9999-12-31" });
  const salesAge = ageMinutes(f?.sales_last_success_at ?? null, input.now);
  const adsAge = ageMinutes(f?.ads_campaign_today_at ?? null, input.now);
  const extraAge = ageMinutes(f?.extra_info_last_captured_at ?? null, input.now);
  const s = input.summary;
  const hasCampaigns = (s?.ads.single_item_campaigns ?? 0) > 0;
  const missing: string[] = [];
  if (!f?.sales_last_success_at) missing.push("sales");
  if (hasCampaigns && !f?.ads_campaign_today_at) missing.push("ads");
  if (!s?.snapshot) missing.push("extra_info");

  const warnings: string[] = [];
  const coverageNote = salesCoverageNote(coverage);
  if (coverageNote) warnings.push(coverageNote);
  if ((s?.ads.shared_campaigns_excluded ?? 0) > 0) warnings.push(`${s!.ads.shared_campaigns_excluded} campaign quảng cáo nhiều sản phẩm không được tính vào Ads của sản phẩm này.`);
  warnings.push("Doanh số = tạm tính theo giá sản phẩm, trước voucher/phí ship; hoàn trả chưa được trừ.");
  warnings.push("Broad GMV là attribution của Shopee Ads, không phải phần doanh số do Ads tạo ra.");
  if (s?.snapshot) warnings.push("Views / sale của Shopee là snapshot hiện tại, ý nghĩa chưa xác minh — không so sánh theo kỳ.");

  const applied = input.partialToday && input.hourCutoff !== null;
  const salesAvailable = !input.partialToday || (input.hourCutoff !== null && input.hourCutoff > 0);
  // Ads same-time needs hourly rows of the previous day for this product's campaigns
  const adsAvailable = !input.partialToday || !hasCampaigns || (salesAvailable && (s?.ads.previous_fact_rows ?? 0) > 0);
  if (input.partialToday) warnings.push(salesAvailable ? `Hôm nay chưa hết ngày: so sánh đến cùng ${input.hourCutoff}:00 của hôm qua.` : "Hôm nay chưa có giờ nào hoàn tất — chưa so sánh được.");
  if (input.partialToday && !adsAvailable) warnings.push("Chưa có dữ liệu Ads theo giờ của hôm qua — không so sánh Ads cùng giờ.");

  return {
    sales_freshness: { last_success_at: f?.sales_last_success_at ?? null, age_minutes: salesAge, stale: salesAge === null || salesAge > t.salesStaleMinutes, backfill_done: !!f?.sales_backfill_done_at, enabled: !!f?.sales_enabled },
    ads_freshness: { last_today_read_at: f?.ads_campaign_today_at ?? null, age_minutes: adsAge, stale: hasCampaigns && (adsAge === null || adsAge > t.adsStaleMinutes) },
    extra_info_freshness: { last_captured_at: f?.extra_info_last_captured_at ?? null, age_hours: extraAge === null ? null : Math.round(extraAge / 60), stale: extraAge === null || extraAge > t.extraInfoStaleHours * 60 },
    missing_sources: missing,
    partial_today: input.partialToday,
    same_time_comparison: { applied, hour_cutoff: applied ? input.hourCutoff : null, sales_available: salesAvailable, ads_available: adsAvailable },
    semantic_warnings: warnings,
    sales_coverage: coverage,
  };
}
