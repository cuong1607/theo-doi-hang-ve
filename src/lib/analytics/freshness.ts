// ============================================================
// PHASE SHOPEE-8: per-domain data freshness (pure). Each analytics domain
// is only as fresh as the OLDEST last-successful sync among the shops in
// scope; a domain is stale when that is older than 3 × its scheduler
// interval (≥ 30 min). Never "the dashboard is fresh because one sync ran".
// ============================================================

export const FRESHNESS_DOMAINS = [
  { syncType: "order", label: "Đơn hàng", intervalKey: "orderIntervalMinutes" },
  { syncType: "escrow", label: "Tài chính", intervalKey: "escrowIntervalMinutes" },
  { syncType: "return", label: "Trả hàng", intervalKey: "returnIntervalMinutes" },
  { syncType: "income", label: "Giải ngân", intervalKey: "incomeIntervalMinutes" },
  { syncType: "payout", label: "Payout", intervalKey: "payoutIntervalMinutes" },
] as const;

export type FreshnessDomain = (typeof FRESHNESS_DOMAINS)[number]["syncType"];

export interface DomainFreshness {
  syncType: FreshnessDomain;
  label: string;
  /** Oldest last success across the scoped shops (null = some shop never synced). */
  lastSuccessAt: string | null;
  stale: boolean;
  staleAfterMinutes: number;
  ageMinutes: number | null;
}

export const staleAfterMinutes = (intervalMinutes: number) => Math.max(30, intervalMinutes * 3);

export function domainFreshness(
  shopIds: string[],
  lastSuccess: (shopId: string, syncType: string) => string | null,
  intervals: Record<string, number>,
  now: Date = new Date(),
): DomainFreshness[] {
  return FRESHNESS_DOMAINS.map((d) => {
    const times = shopIds.map((s) => lastSuccess(s, d.syncType));
    const oldest = times.some((t) => t === null) ? null : times.reduce<string | null>((acc, t) => (acc === null || (t && t < acc) ? t : acc), null);
    const limit = staleAfterMinutes(intervals[d.intervalKey] ?? 60);
    const age = oldest ? Math.floor((now.getTime() - new Date(oldest).getTime()) / 60_000) : null;
    return { syncType: d.syncType, label: d.label, lastSuccessAt: oldest, stale: shopIds.length > 0 && (age === null || age > limit), staleAfterMinutes: limit, ageMinutes: age };
  });
}

export function formatAgeMinutes(m: number | null): string {
  if (m === null) return "chưa từng đồng bộ";
  if (m < 60) return `${m} phút`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} giờ`;
  return `${Math.floor(m / 1440)} ngày`;
}
