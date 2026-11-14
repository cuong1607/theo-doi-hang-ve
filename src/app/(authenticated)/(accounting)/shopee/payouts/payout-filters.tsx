"use client";

import { FilterBar, FilterDate, FilterSelect, SearchInput, type FilterOption } from "@/components/patterns/filter-bar";
import { PAYOUT_RECON_INFO } from "@/lib/channels/core/payout-display";
import { PAYOUT_RECONCILIATION_STATUSES } from "@/lib/channels/core/payouts";

const KEYS = ["shop", "status", "from", "to", "q"] as const;
const STATUS_OPTIONS: FilterOption[] = [{ label: "Mọi trạng thái đối soát", value: "all" }, ...PAYOUT_RECONCILIATION_STATUSES.map((s) => ({ value: s, label: PAYOUT_RECON_INFO[s].label }))];

export function PayoutFilters({ query, shops }: { query: Record<string, string | undefined>; shops: Array<{ id: string; name: string }> }) {
  const shopOptions: FilterOption[] = [{ label: "Mọi shop", value: "all" }, ...shops.map((s) => ({ value: s.id, label: s.name }))];
  return (
    <FilterBar filterKeys={KEYS}>
      <SearchInput paramKey="q" defaultValue={query.q} placeholder="Mã payout…" label="Tìm theo mã payout" />
      {shops.length > 1 && <FilterSelect paramKey="shop" value={query.shop} options={shopOptions} label="Lọc theo shop" />}
      <FilterSelect paramKey="status" value={query.status} options={STATUS_OPTIONS} label="Lọc theo trạng thái đối soát" />
      <FilterDate paramKey="from" value={query.from} label="Từ ngày" />
      <FilterDate paramKey="to" value={query.to} label="Đến ngày" />
    </FilterBar>
  );
}
