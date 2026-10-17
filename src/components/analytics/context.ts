// SHOPEE-8: request context shared by the dashboard and analytics pages —
// URL filters → validated period + server-resolved shop scope + drilldown
// links that carry the same filters.
import "server-only";

import { resolveAnalyticsScope, type AnalyticsScope } from "@/lib/channels/core/analytics";
import { previousPeriod, resolvePeriod, type Period, type PeriodPreset, PERIOD_LABELS } from "@/lib/analytics/periods";
import { createAdminClient } from "@/lib/supabase/admin";

export type AnalyticsParams = { period?: string; from?: string; to?: string; shop?: string; [k: string]: string | undefined };

export interface AnalyticsContext {
  scope: AnalyticsScope;
  period: Period;
  previous: { from: string; to: string };
  previousLabel: string;
  /** Filter values echoed back to the filter bar. */
  query: Record<string, string | undefined>;
  /** "?period=…&shop=…" for links between analytics pages. */
  qs: string;
}

const PREVIOUS_LABEL: Record<PeriodPreset, string> = {
  today: "hôm qua",
  yesterday: "hôm kia",
  "7d": "7 ngày trước đó",
  "30d": "30 ngày trước đó",
  this_month: "cùng kỳ tháng trước",
  last_month: "tháng trước nữa",
  custom: "kỳ trước cùng độ dài",
};

export async function getAnalyticsContext(params: AnalyticsParams, fallback: PeriodPreset = "today"): Promise<AnalyticsContext | null> {
  const scope = await resolveAnalyticsScope(createAdminClient(), params.shop);
  if (!scope) return null;
  const period = resolvePeriod({ preset: params.period, from: params.from, to: params.to }, new Date(), fallback);
  const query: Record<string, string | undefined> = {
    period: params.period,
    from: period.preset === "custom" ? period.from : undefined,
    to: period.preset === "custom" ? period.to : undefined,
    shop: scope.selectedShopId ?? undefined,
  };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) sp.set(k, v);
  return { scope, period, previous: previousPeriod(period), previousLabel: PREVIOUS_LABEL[period.preset], query, qs: sp.toString() ? `?${sp}` : "" };
}

export const periodText = (p: Period) => (p.preset === "custom" ? (p.from === p.to ? p.from : `${p.from} → ${p.to}`) : `${PERIOD_LABELS[p.preset]} (${p.from === p.to ? p.from : `${p.from} → ${p.to}`})`);

/** /shopee/orders link with the same period + shop and extra filters. */
export function ordersHref(ctx: AnalyticsContext, extra: Record<string, string> = {}): string {
  const sp = new URLSearchParams({ from: ctx.period.from, to: ctx.period.to, ...extra });
  if (ctx.scope.selectedShopId) sp.set("shop", ctx.scope.selectedShopId);
  return `/shopee/orders?${sp}`;
}
