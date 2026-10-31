// ============================================================
// PRODUCT-ANALYTICS-2: shapes returned by the product analytics RPCs
// (migration 00070). Numeric values arrive from PostgREST as JSON numbers
// (NUMERIC sums of integer VND) — they are DISPLAYED, never re-aggregated in JS.
// ============================================================

export interface PaDelta {
  current: number | null;
  previous: number | null;
  abs: number | null;
  pct: number | null;
}

export interface ProductSummary {
  identity: {
    product_id: string;
    shop_id: string;
    provider_item_id: string;
    name: string | null;
    sku: string | null;
    image_url: string | null;
    provider_status: string | null;
    metadata_source: "ads_enrichment" | "order_line" | null;
    metadata_updated_at: string | null;
  };
  period: { from: string; to: string; prev_from: string; prev_to: string; hour_cutoff: number | null };
  sales: { gmv: PaDelta; orders: PaDelta; units: PaDelta; cancelled_orders: PaDelta; fact_lines: number };
  ads: {
    single_item_campaigns: number;
    shared_campaigns_excluded: number;
    spend: PaDelta;
    impressions: PaDelta;
    clicks: PaDelta;
    direct_order: PaDelta;
    broad_order: PaDelta;
    direct_gmv: PaDelta;
    broad_gmv: PaDelta;
    cpc: PaDelta;
    ctr: PaDelta;
    direct_roas: PaDelta;
    broad_roas: PaDelta;
    direct_cvr: PaDelta;
    broad_cvr: PaDelta;
    broad_gmv_to_sales_indicator: PaDelta;
    fact_rows: number;
    previous_fact_rows: number | null;
  };
  snapshot: { captured_at: string; sale: number | null; views: number | null; likes: number | null; rating_star: number | null; comment_count: number | null } | null;
}

export interface ProductDailyRow {
  report_date: string;
  orders: number;
  units: number;
  gmv: number;
  spend: number;
  impressions: number;
  clicks: number;
  direct_order: number;
  broad_order: number;
  direct_gmv: number;
  broad_gmv: number;
}

export interface ProductListRow {
  id: string;
  shop_id: string;
  item_id: string;
  name: string | null;
  sku: string | null;
  image_url: string | null;
  status: string | null;
  campaigns: number;
  shared_campaigns: number;
  gmv: number;
  orders: number;
  units: number;
  prev_gmv: number;
  prev_orders: number;
  gmv_pct: number | null;
  spend: number;
  clicks: number;
  impressions: number;
  broad_gmv: number;
  broad_order: number;
  broad_roas: number | null;
  prev_spend: number;
  spend_pct: number | null;
  roas_pct: number | null;
}

export interface ShopFreshnessRow {
  shop_id: string;
  sales_enabled: boolean;
  extra_info_enabled: boolean;
  sales_last_success_at: string | null;
  sales_backfill_done_at: string | null;
  sales_active_jobs: number;
  fact_lines: number;
  first_report_date: string | null;
  last_report_date: string | null;
  last_order_created_at: string | null;
  extra_info_last_captured_at: string | null;
  products: number;
  /** ads_sync_freshness (campaign facts of today). */
  ads_campaign_today_at: string | null;
}

export type SemanticConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface MetricMeta {
  source: string;
  semantic_confidence: SemanticConfidence;
  note: string;
}
