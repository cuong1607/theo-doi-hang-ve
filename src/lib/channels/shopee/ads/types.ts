// ============================================================
// SHOPEE-ADS-0: Ads domain vocabulary — PLANNED, no schema, no formulas.
//
// Future canonical entities (SHOPEE-ADS-1 designs the real tables once the
// API payloads are known — no premature schema here):
//   ads_campaigns            one row per (shop, provider campaign id)
//   ads_products / entities  what a campaign promotes (listing / keyword …)
//   ads_daily_performance    one row per (shop, entity, business date)
//   sync state               reuses channel_sync_states / jobs / logs
//                            (sync types: see core/sync-domains.ts
//                            PLANNED_ADS_SYNC_TYPES)
//   raw payloads             reuse channel_api_snapshots (entity_type "ads")
// Money stays exact NUMERIC strings at the data boundary (carry-forward #5).
// ============================================================

/** Metrics the Ads module will show. Definitions only — formulas come with real payloads (SHOPEE-ADS-1). */
export const ADS_METRICS = [
  { key: "spend", label: "Chi phí quảng cáo", note: "Tiền Shopee trừ cho quảng cáo trong kỳ" },
  { key: "impressions", label: "Lượt hiển thị", note: "Số lần quảng cáo được hiển thị" },
  { key: "clicks", label: "Lượt nhấp", note: "Số lần nhấp vào quảng cáo" },
  { key: "orders", label: "Đơn từ quảng cáo", note: "Đơn được Shopee quy cho quảng cáo" },
  { key: "gmv", label: "Doanh số từ quảng cáo", note: "Giá trị đơn được quy cho quảng cáo" },
  { key: "ctr", label: "CTR", note: "Tỷ lệ nhấp trên hiển thị" },
  { key: "cpc", label: "CPC", note: "Chi phí trung bình mỗi lượt nhấp" },
  { key: "conversion_rate", label: "Tỷ lệ chuyển đổi", note: "Đơn trên lượt nhấp" },
  { key: "roas", label: "ROAS", note: "Doanh số trên chi phí" },
  { key: "acos", label: "ACOS", note: "Chi phí trên doanh số" },
] as const;

export type AdsMetricKey = (typeof ADS_METRICS)[number]["key"];

/** Raw snapshot entity type reserved for Ads payloads (existing channel_api_snapshots table). */
export const ADS_SNAPSHOT_ENTITY_TYPE = "ads";
