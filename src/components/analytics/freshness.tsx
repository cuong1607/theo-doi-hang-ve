// SHOPEE-8 data freshness: per-domain "cập nhật lần cuối" + a stale banner
// when a key source has not synced for 3 × its interval. Uses the existing
// sync states + scheduler heartbeat (never claims the whole dashboard is
// fresh because one domain synced).
import Link from "next/link";
import { Clock } from "lucide-react";

import { domainFreshness, formatAgeMinutes } from "@/lib/analytics/freshness";
import { getSyncConfig } from "@/lib/channels/core/sync-config";
import { getSyncHealth, getSyncStatuses } from "@/lib/channels/core/sync-status-queries";
import { formatDateTime } from "@/lib/ui/format";
import { Callout } from "@/components/patterns/callout";

import { AnalyticsSection, loadSection } from "./section";

async function load(shopIds: string[]) {
  const [statuses, health] = await Promise.all([getSyncStatuses(shopIds, ["order", "escrow", "return", "income", "payout"]), getSyncHealth()]);
  const config = getSyncConfig();
  const domains = domainFreshness(shopIds, (s, t) => statuses.get(`${s}|${t}`)?.lastSuccessAt ?? null, config as unknown as Record<string, number>);
  return { domains, health };
}

/** Top-of-page: compact per-domain freshness + stale warning. */
export async function FreshnessBar({ shopIds }: { shopIds: string[] }) {
  const res = await loadSection("freshness", () => load(shopIds));
  if (!res.ok) return null;
  const { domains, health } = res.data;
  const stale = domains.filter((d) => d.stale);
  return (
    <div className="space-y-2">
      {(stale.length > 0 || health.schedulerStale) && (
        <Callout tone="warning" title="Một số dữ liệu chưa được cập nhật">
          <ul className="list-disc space-y-0.5 pl-5">
            {health.schedulerStale && <li>Scheduler đồng bộ có thể đang dừng — dữ liệu sẽ không tự cập nhật.</li>}
            {stale.map((d) => (
              <li key={d.syncType}>
                Dữ liệu {d.label.toLowerCase()} Shopee {d.ageMinutes === null ? "chưa từng được đồng bộ thành công" : `chưa được đồng bộ trong ${formatAgeMinutes(d.ageMinutes)}`}.
              </li>
            ))}
          </ul>
          <Link href="/shopee/sync" className="mt-1 inline-block underline underline-offset-4">
            Xem trang đồng bộ
          </Link>
        </Callout>
      )}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <Clock aria-hidden="true" className="size-3.5" />
        {domains.map((d) => (
          <span key={d.syncType} className={d.stale ? "text-warning-text" : undefined}>
            {d.label}: <span className="tabular-nums">{d.lastSuccessAt ? formatDateTime(d.lastSuccessAt) : "chưa có"}</span>
          </span>
        ))}
      </p>
    </div>
  );
}

/** Operational footer: sync health (not a business KPI). */
export async function SyncHealthSection({ shopIds }: { shopIds: string[] }) {
  const res = await loadSection("sync-health", () => load(shopIds));
  if (!res.ok) return null;
  const { domains, health } = res.data;
  return (
    <AnalyticsSection title="Tình trạng đồng bộ" description="Lần đồng bộ thành công gần nhất (shop cũ nhất trong phạm vi lọc).">
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        {domains.map((d) => (
          <div key={d.syncType}>
            <dt className="text-muted-foreground">{d.label}</dt>
            <dd className={d.stale ? "text-warning-text" : undefined}>
              {d.lastSuccessAt ? formatDateTime(d.lastSuccessAt) : "chưa có"}
              {d.stale && <span className="block text-xs">cũ (quá {d.staleAfterMinutes} phút)</span>}
            </dd>
          </div>
        ))}
        <div>
          <dt className="text-muted-foreground">Scheduler</dt>
          <dd className={health.schedulerStale ? "text-warning-text" : undefined}>{health.scheduler?.last_success_at ? formatDateTime(health.scheduler.last_success_at) : "chưa chạy"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Worker</dt>
          <dd>{health.worker?.last_success_at ? formatDateTime(health.worker.last_success_at) : "chưa chạy"}</dd>
        </div>
      </dl>
    </AnalyticsSection>
  );
}
