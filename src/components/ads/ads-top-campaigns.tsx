// SHOPEE-ADS-UI-1: Top ROAS / Top doanh thu / Chi tiêu cao nhất / Cần chú ý
// — compact coloured lists; each name jumps to the campaign table filtered
// by that name (?q=…#ads-campaigns).
import Link from "next/link";
import { AlertTriangle, BadgeDollarSign, TrendingUp, Wallet, type LucideIcon } from "lucide-react";
import { cn } from "cn";

import { formatMetric, type AdsMetricKey } from "@/lib/channels/shopee/ads/metrics";
import type { AdsCampaignRow } from "@/lib/channels/shopee/ads/view-models";
import { buildListHref } from "@/lib/ui/list-query";

interface TopList {
  key: string;
  title: string;
  icon: LucideIcon;
  chip: string;
  bar: string;
  metric: AdsMetricKey;
  rows: AdsCampaignRow[];
}

export function needsAttention(r: AdsCampaignRow): boolean {
  return r.status === "warning" || (r.metrics.spend > 0 && r.metrics.orders === 0) || (r.metrics.roas !== null && r.metrics.roas < 1.5);
}

export function topCampaignLists(rows: AdsCampaignRow[]): TopList[] {
  const by = (k: AdsMetricKey) => [...rows].filter((r) => (r.metrics[k] ?? 0) > 0).sort((a, b) => (b.metrics[k] ?? 0) - (a.metrics[k] ?? 0)).slice(0, 3);
  return [
    { key: "roas", title: "Top ROAS", icon: TrendingUp, chip: "bg-metric-roas/12 text-metric-roas", bar: "bg-metric-roas", metric: "roas", rows: by("roas").filter((r) => r.metrics.orders > 0) },
    { key: "revenue", title: "Top doanh số Broad", icon: BadgeDollarSign, chip: "bg-metric-revenue/12 text-metric-revenue", bar: "bg-metric-revenue", metric: "revenue", rows: by("revenue") },
    { key: "spend", title: "Chi tiêu cao nhất", icon: Wallet, chip: "bg-metric-spend/12 text-metric-spend", bar: "bg-metric-spend", metric: "spend", rows: by("spend") },
    { key: "attention", title: "Cần chú ý", icon: AlertTriangle, chip: "bg-warning-soft text-warning-text", bar: "bg-warning", metric: "roas", rows: rows.filter(needsAttention).sort((a, b) => b.metrics.spend - a.metrics.spend).slice(0, 3) },
  ];
}

export function AdsTopCampaigns({ rows, pathname, query }: { rows: AdsCampaignRow[]; pathname: string; query: Record<string, string | undefined> }) {
  const lists = topCampaignLists(rows);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {lists.map((l, li) => {
        const Icon = l.icon;
        const max = Math.max(...l.rows.map((r) => r.metrics[l.metric] ?? 0), 0) || 1;
        return (
          <div key={l.key} data-slot="ads-top-list" data-list={l.key} style={{ "--ads-delay": `${li * 50}ms` } as React.CSSProperties} className="ads-card animate-ads-rise rounded-xl border border-ads-border bg-ads-surface p-3">
            <p className="mb-2 flex items-center gap-2 text-sm font-medium">
              <span data-ads-icon className={cn("flex size-6 items-center justify-center rounded-md transition-transform duration-(--ads-dur-fast)", l.chip)}>
                <Icon aria-hidden="true" className="size-3.5" />
              </span>
              {l.title}
            </p>
            {l.rows.length === 0 ? (
              <p className="py-3 text-xs text-muted-foreground">{l.key === "attention" ? "Không có chiến dịch nào cần chú ý." : "Chưa có dữ liệu."}</p>
            ) : (
              <ol className="space-y-2">
                {l.rows.map((r, i) => (
                  <li key={r.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <Link
                        href={`${buildListHref(pathname, query, { q: r.name, page: undefined })}#ads-campaigns`}
                        scroll={false}
                        className="min-w-0 truncate rounded hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        <span className="mr-1.5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                        {r.name}
                      </Link>
                      <span className="shrink-0 text-xs font-medium tabular-nums">
                        {l.key === "attention" ? (r.metrics.orders === 0 ? "0 đơn" : formatMetric("roas", r.metrics.roas)) : formatMetric(l.metric, r.metrics[l.metric])}
                      </span>
                    </div>
                    <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-muted">
                      <div className={cn("animate-ads-fill h-full rounded-full", l.bar)} style={{ width: `${l.key === "attention" ? 100 : ((r.metrics[l.metric] ?? 0) / max) * 100}%`, opacity: l.key === "attention" ? 0.6 : 1 }} />
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}
