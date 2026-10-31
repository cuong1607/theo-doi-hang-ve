// ============================================================
// PRODUCT-ANALYTICS-3: signal / health / priority SHAPES + their Vietnamese
// wording. The engine itself is SQL (pa_intelligence_eval, migration 00071),
// fed by PRODUCT_INTELLIGENCE_CONFIG — this file never decides a signal.
//
// A signal states what moved ("Doanh số giảm 21 %"), never why. Wording here
// must stay factual: no "do quảng cáo", no "Ads tạo ra", no organic remainder.
// Pure.
// ============================================================
import { PRODUCT_INTELLIGENCE_CONFIG } from "./config.ts";

export type SignalSeverity = "INFO" | "NOTICE" | "WARNING";
export type SignalConfidence = "HIGH" | "MEDIUM" | "LOW";
export type SignalPolarity = "positive" | "negative" | "neutral";

export const PERFORMANCE_SIGNAL_TYPES = [
  "SALES_UP",
  "SALES_DOWN",
  "SALES_STABLE",
  "ORDERS_UP",
  "ORDERS_DOWN",
  "UNITS_UP",
  "UNITS_DOWN",
  "ADS_SPEND_UP",
  "ADS_SPEND_DOWN",
  "ADS_IMPRESSIONS_UP",
  "ADS_IMPRESSIONS_DOWN",
  "ADS_CLICKS_UP",
  "ADS_CLICKS_DOWN",
  "ADS_CPC_UP",
  "ADS_CPC_DOWN",
  "ADS_ROAS_UP",
  "ADS_ROAS_DOWN",
  "ADS_CVR_UP",
  "ADS_CVR_DOWN",
] as const;
export type PerformanceSignalType = (typeof PERFORMANCE_SIGNAL_TYPES)[number];

export const DATA_QUALITY_SIGNAL_TYPES = ["SALES_DATA_MISSING", "SALES_INCOMPLETE", "COMPARISON_UNAVAILABLE", "PARTIAL_TODAY", "DATA_STALE", "ADS_DATA_MISSING", "SNAPSHOT_SEMANTICS_UNKNOWN"] as const;
export type DataQualitySignalType = (typeof DATA_QUALITY_SIGNAL_TYPES)[number];

/** One factual movement + its evidence (values are what SQL computed; ratios are ratio of sums). */
export interface ProductSignal {
  type: PerformanceSignalType;
  family: "sales" | "ads";
  metric: string;
  direction: "up" | "down" | "flat";
  polarity: SignalPolarity;
  severity: SignalSeverity;
  confidence: SignalConfidence;
  current: number;
  previous: number;
  abs_change: number;
  change_pct: number;
}

export interface DataQualitySignal {
  type: DataQualitySignalType;
  family: "data_quality";
  scope: "sales" | "ads" | "period" | "snapshot";
  severity: "INFO";
  detail?: Record<string, unknown>;
}

export const HEALTH_LABELS = ["GOOD", "STABLE", "WATCH", "WEAK", "INSUFFICIENT_DATA"] as const;
export type HealthLabel = (typeof HEALTH_LABELS)[number];
export type HealthRule =
  | "no_comparable_data"
  | "low_volume"
  | "sales_and_efficiency_down"
  | "sales_down_sharply"
  | "warning_signals"
  | "multiple_notices"
  | "sales_growing"
  | "no_significant_change";

export interface ProductHealth {
  label: HealthLabel;
  severity: SignalSeverity;
  confidence: SignalConfidence;
  rule: HealthRule;
  /** what the classification could look at */
  basis: "sales_and_ads" | "sales" | "ads" | "none";
  negative_warnings: number;
  negative_notices: number;
}

export interface AttentionPriority {
  score: number;
  level: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  signal_points: number;
  scale_points: number;
  business_vnd: number;
  confidence: SignalConfidence;
}

/** pa_intelligence_eval output. */
export interface ProductIntel {
  signals: ProductSignal[];
  data_quality: DataQualitySignal[];
  top_signals: ProductSignal[];
  health: ProductHealth;
  priority: AttentionPriority;
  needs_attention: boolean;
}

// ------------------------------------------------------------------ wording (vi)

const METRIC_NAME: Record<string, string> = {
  sales_gmv: "Doanh số",
  orders: "Đơn hàng",
  units: "Số lượng bán",
  ads_spend: "Chi Ads",
  ads_impressions: "Hiển thị Ads",
  ads_clicks: "Click Ads",
  ads_cpc: "CPC",
  ads_broad_roas: "ROAS Broad",
  ads_broad_cvr: "CVR Broad",
};

export const SIGNAL_SHORT_LABEL: Record<PerformanceSignalType, string> = {
  SALES_UP: "Doanh số tăng",
  SALES_DOWN: "Doanh số giảm",
  SALES_STABLE: "Doanh số ổn định",
  ORDERS_UP: "Đơn tăng",
  ORDERS_DOWN: "Đơn giảm",
  UNITS_UP: "Số lượng tăng",
  UNITS_DOWN: "Số lượng giảm",
  ADS_SPEND_UP: "Chi Ads tăng",
  ADS_SPEND_DOWN: "Chi Ads giảm",
  ADS_IMPRESSIONS_UP: "Hiển thị tăng",
  ADS_IMPRESSIONS_DOWN: "Hiển thị giảm",
  ADS_CLICKS_UP: "Click tăng",
  ADS_CLICKS_DOWN: "Click giảm",
  ADS_CPC_UP: "CPC tăng",
  ADS_CPC_DOWN: "CPC giảm",
  ADS_ROAS_UP: "ROAS tăng",
  ADS_ROAS_DOWN: "ROAS giảm",
  ADS_CVR_UP: "CVR tăng",
  ADS_CVR_DOWN: "CVR giảm",
};

const pctText = (v: number) => `${Math.abs(v).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;

/** "Doanh số giảm 21%" · "CPC tăng 12,5%" · "Doanh số ổn định (±3%)" — factual, no cause. */
export function describeSignal(s: Pick<ProductSignal, "metric" | "direction" | "change_pct">): string {
  const name = METRIC_NAME[s.metric] ?? s.metric;
  if (s.direction === "flat") return `${name} ổn định (${s.change_pct >= 0 ? "+" : "−"}${pctText(s.change_pct)})`;
  return `${name} ${s.direction === "up" ? "tăng" : "giảm"} ${pctText(s.change_pct)}`;
}

export const HEALTH_TEXT: Record<HealthLabel, string> = {
  GOOD: "Tốt",
  STABLE: "Ổn định",
  WATCH: "Cần theo dõi",
  WEAK: "Yếu",
  INSUFFICIENT_DATA: "Chưa đủ dữ liệu",
};

/** Explainable reason of a health label (mirrors the SQL rule codes). */
export function healthRuleText(rule: HealthRule, c = PRODUCT_INTELLIGENCE_CONFIG): string {
  const vnd = (n: number) => `${(n / 1000).toLocaleString("vi-VN")}k`;
  switch (rule) {
    case "no_comparable_data":
      return "Chưa có kỳ so sánh đủ dữ liệu (doanh số hoặc Ads) để đánh giá.";
    case "low_volume":
      return `Quy mô nhỏ ở cả hai kỳ (doanh số < ${vnd(c.minSalesGmv)} và chi Ads < ${vnd(c.minAdsSpend)}) — chưa đủ để đánh giá.`;
    case "sales_and_efficiency_down":
      return "Doanh số/đơn giảm mạnh, đồng thời hiệu quả Ads (ROAS, CVR hoặc CPC) cũng kém đi.";
    case "sales_down_sharply":
      return `Doanh số giảm hơn ${c.changePctMajor * 2}% ở quy mô đáng kể.`;
    case "warning_signals":
      return "Có tín hiệu cảnh báo, chưa đến mức Yếu.";
    case "multiple_notices":
      return "Có nhiều thay đổi bất lợi nhỏ cùng lúc.";
    case "sales_growing":
      return "Doanh số hoặc đơn hàng tăng, không có cảnh báo.";
    case "no_significant_change":
      return "Không có thay đổi đáng kể so với kỳ trước.";
  }
}

export const CONFIDENCE_TEXT: Record<SignalConfidence, string> = { HIGH: "Tin cậy cao", MEDIUM: "Tin cậy vừa", LOW: "Tin cậy thấp" };

export const PRIORITY_TEXT: Record<AttentionPriority["level"], string> = { HIGH: "Ưu tiên cao", MEDIUM: "Ưu tiên vừa", LOW: "Ưu tiên thấp", NONE: "Không cần ưu tiên" };

/** "76 điểm = 28 điểm tín hiệu × (1 + 17/10 quy mô) × 1" — the score is never shown alone. */
export function priorityExplain(p: AttentionPriority): string {
  const factor = p.confidence === "HIGH" ? "1" : p.confidence === "MEDIUM" ? "0,75" : "0,5";
  return `${p.score} điểm = ${p.signal_points} điểm tín hiệu bất lợi × (1 + ${p.scale_points}/10 quy mô) × ${factor} (${CONFIDENCE_TEXT[p.confidence].toLowerCase()})`;
}

export const DATA_QUALITY_TEXT: Record<DataQualitySignalType, string> = {
  SALES_DATA_MISSING: "Chưa có dữ liệu doanh số",
  SALES_INCOMPLETE: "Doanh số chưa đầy đủ",
  COMPARISON_UNAVAILABLE: "Chưa so sánh được",
  PARTIAL_TODAY: "Hôm nay chưa hết ngày",
  DATA_STALE: "Dữ liệu chưa mới",
  ADS_DATA_MISSING: "Chưa có dữ liệu Ads",
  SNAPSHOT_SEMANTICS_UNKNOWN: "Snapshot: ý nghĩa chưa xác minh",
};

/** Visual tone of a signal: business meaning, never "negative number = red". */
export type SignalTone = "good" | "bad" | "warning" | "neutral";
export function signalTone(s: Pick<ProductSignal, "polarity" | "severity">): SignalTone {
  if (s.polarity === "positive") return "good";
  if (s.polarity === "neutral") return "neutral";
  return s.severity === "WARNING" ? "bad" : "warning";
}

/** Meaning of an UP move per metric (CPC up is bad, spend up is context-dependent). */
export const METRIC_UP_POLARITY: Record<string, SignalPolarity> = {
  sales_gmv: "positive",
  orders: "positive",
  units: "positive",
  ads_spend: "neutral",
  ads_impressions: "positive",
  ads_clicks: "positive",
  ads_ctr: "positive",
  ads_cpc: "negative",
  ads_broad_roas: "positive",
  ads_direct_roas: "positive",
  ads_broad_cvr: "positive",
  ads_direct_cvr: "positive",
  ads_broad_gmv: "positive",
  ads_direct_gmv: "positive",
  ads_broad_order: "positive",
  ads_direct_order: "positive",
  cancelled_orders: "negative",
};

/** Tone of a plain Δ% (cards without a signal): tiny moves stay neutral. */
export function deltaTone(metric: string, pct: number | null | undefined, minorPct = 2): SignalTone {
  if (pct === null || pct === undefined || Math.abs(pct) < minorPct) return "neutral";
  const up = METRIC_UP_POLARITY[metric] ?? "neutral";
  if (up === "neutral") return "neutral";
  return (pct > 0) === (up === "positive") ? "good" : "bad";
}
