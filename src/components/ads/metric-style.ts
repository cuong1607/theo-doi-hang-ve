// SHOPEE-ADS-UI-1: metric → visual identity, in ONE place. Literal class
// strings (Tailwind must see them); colours come from the Ads semantic
// tokens in globals.css — never raw palette classes.
import {
  BadgeDollarSign,
  Eye,
  Gauge,
  MousePointerClick,
  Percent,
  ShoppingBag,
  Target,
  TrendingUp,
  Wallet,
  Repeat,
  type LucideIcon,
} from "lucide-react";

import type { AdsMetricKey, AdsDeltaTone } from "@/lib/channels/shopee/ads/metrics";
import type { AdsCampaignStatus, AdsInsightTone } from "@/lib/channels/shopee/ads/view-models";
import type { Tone } from "@/lib/ui/status";

export interface MetricStyle {
  icon: LucideIcon;
  /** Icon / solid accent colour. */
  solid: string;
  /** Readable text on the tint. */
  text: string;
  /** Tinted background (icon chip, soft fill). */
  soft: string;
  /** Hover / focus ring tint. */
  ring: string;
  /** CSS colour for SVG strokes / fills. */
  stroke: string;
}

export const METRIC_STYLE: Record<AdsMetricKey, MetricStyle> = {
  spend: { icon: Wallet, solid: "text-metric-spend", text: "text-metric-spend-text", soft: "bg-metric-spend/12", ring: "ring-metric-spend/25", stroke: "var(--metric-spend)" },
  revenue: { icon: BadgeDollarSign, solid: "text-metric-revenue", text: "text-metric-revenue-text", soft: "bg-metric-revenue/12", ring: "ring-metric-revenue/25", stroke: "var(--metric-revenue)" },
  roas: { icon: TrendingUp, solid: "text-metric-roas", text: "text-metric-roas-text", soft: "bg-metric-roas/12", ring: "ring-metric-roas/25", stroke: "var(--metric-roas)" },
  orders: { icon: ShoppingBag, solid: "text-metric-orders", text: "text-metric-orders-text", soft: "bg-metric-orders/12", ring: "ring-metric-orders/25", stroke: "var(--metric-orders)" },
  clicks: { icon: MousePointerClick, solid: "text-metric-clicks", text: "text-metric-clicks-text", soft: "bg-metric-clicks/12", ring: "ring-metric-clicks/25", stroke: "var(--metric-clicks)" },
  impressions: { icon: Eye, solid: "text-metric-impressions", text: "text-metric-impressions-text", soft: "bg-metric-impressions/12", ring: "ring-metric-impressions/25", stroke: "var(--metric-impressions)" },
  ctr: { icon: Percent, solid: "text-metric-ctr", text: "text-metric-ctr-text", soft: "bg-metric-ctr/12", ring: "ring-metric-ctr/25", stroke: "var(--metric-ctr)" },
  cpc: { icon: Gauge, solid: "text-metric-cpc", text: "text-metric-cpc-text", soft: "bg-metric-cpc/14", ring: "ring-metric-cpc/30", stroke: "var(--metric-cpc)" },
  acos: { icon: Target, solid: "text-metric-acos", text: "text-metric-acos-text", soft: "bg-metric-acos/12", ring: "ring-metric-acos/25", stroke: "var(--metric-acos)" },
  conversionRate: { icon: Repeat, solid: "text-metric-cr", text: "text-metric-cr-text", soft: "bg-metric-cr/12", ring: "ring-metric-cr/25", stroke: "var(--metric-cr)" },
  // Direct variants share the identity of their Broad counterpart
  directRevenue: { icon: BadgeDollarSign, solid: "text-metric-revenue", text: "text-metric-revenue-text", soft: "bg-metric-revenue/12", ring: "ring-metric-revenue/25", stroke: "var(--metric-revenue)" },
  directOrders: { icon: ShoppingBag, solid: "text-metric-orders", text: "text-metric-orders-text", soft: "bg-metric-orders/12", ring: "ring-metric-orders/25", stroke: "var(--metric-orders)" },
  directRoas: { icon: TrendingUp, solid: "text-metric-roas", text: "text-metric-roas-text", soft: "bg-metric-roas/12", ring: "ring-metric-roas/25", stroke: "var(--metric-roas)" },
  directAcos: { icon: Target, solid: "text-metric-acos", text: "text-metric-acos-text", soft: "bg-metric-acos/12", ring: "ring-metric-acos/25", stroke: "var(--metric-acos)" },
  directConversionRate: { icon: Repeat, solid: "text-metric-cr", text: "text-metric-cr-text", soft: "bg-metric-cr/12", ring: "ring-metric-cr/25", stroke: "var(--metric-cr)" },
};

/** ACOS within target reads orange (spend colour), above target red. */
export function acosStyle(acos: number | null, target: number): MetricStyle {
  return acos !== null && acos <= target ? { ...METRIC_STYLE.acos, solid: "text-metric-spend", text: "text-metric-spend-text", soft: "bg-metric-spend/12", ring: "ring-metric-spend/25", stroke: "var(--metric-spend)" } : METRIC_STYLE.acos;
}

/** Delta chip: semantic (good / bad / warning), never "up = green". */
export const DELTA_CLASS: Record<AdsDeltaTone, string> = {
  good: "bg-success-soft text-success-text",
  bad: "bg-danger-soft text-danger-text",
  warning: "bg-warning-soft text-warning-text",
  neutral: "bg-muted text-muted-foreground",
};

export const DELTA_LABEL: Record<AdsDeltaTone, string> = {
  good: "tốt hơn",
  bad: "kém hơn",
  warning: "cần chú ý",
  neutral: "",
};

export const CAMPAIGN_STATUS: Record<AdsCampaignStatus, { label: string; tone: Tone }> = {
  active: { label: "Đang chạy", tone: "success" },
  paused: { label: "Tạm dừng", tone: "neutral" },
  ended: { label: "Đã kết thúc", tone: "neutral" },
  closed: { label: "Đã đóng", tone: "neutral" },
  warning: { label: "Cần chú ý", tone: "warning" },
  unknown: { label: "Trạng thái khác", tone: "neutral" },
};

export const INSIGHT_STYLE: Record<AdsInsightTone, { soft: string; icon: string; border: string }> = {
  success: { soft: "bg-success-soft/60", icon: "bg-success-soft text-success-text", border: "border-success/25" },
  warning: { soft: "bg-warning-soft/60", icon: "bg-warning-soft text-warning-text", border: "border-warning/30" },
  danger: { soft: "bg-danger-soft/60", icon: "bg-danger-soft text-danger-text", border: "border-destructive/25" },
  info: { soft: "bg-info-soft/60", icon: "bg-info-soft text-info-text", border: "border-info/25" },
};
