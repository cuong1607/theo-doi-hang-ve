"use client";

import { FilterBar, FilterDate, FilterSelect, SearchInput, type FilterOption } from "@/components/patterns/filter-bar";
import { DISPOSITION_INFO, RETURN_DISPOSITIONS, RETURN_STATUS } from "@/lib/channels/shopee/return-status";

const KEYS = ["shop", "status", "disposition", "from", "to", "q"] as const;

const STATUS_OPTIONS: FilterOption[] = [{ label: "Mọi trạng thái", value: "all" }, ...Object.entries(RETURN_STATUS).map(([value, i]) => ({ value, label: i.label }))];
const DISPOSITION_OPTIONS: FilterOption[] = [{ label: "Mọi cách xử lý", value: "all" }, ...RETURN_DISPOSITIONS.map((d) => ({ value: d, label: DISPOSITION_INFO[d].label }))];

export function ReturnFilters({ query, shops }: { query: Record<string, string | undefined>; shops: Array<{ id: string; name: string }> }) {
  const shopOptions: FilterOption[] = [{ label: "Mọi shop", value: "all" }, ...shops.map((s) => ({ value: s.id, label: s.name }))];
  return (
    <FilterBar filterKeys={KEYS}>
      <SearchInput paramKey="q" defaultValue={query.q} placeholder="Mã trả hàng / mã đơn…" label="Tìm theo mã trả hàng hoặc mã đơn" />
      {shops.length > 1 && <FilterSelect paramKey="shop" value={query.shop} options={shopOptions} label="Lọc theo shop" />}
      <FilterSelect paramKey="status" value={query.status} options={STATUS_OPTIONS} label="Lọc theo trạng thái trả hàng" />
      <FilterSelect paramKey="disposition" value={query.disposition} options={DISPOSITION_OPTIONS} label="Lọc theo cách xử lý" />
      <FilterDate paramKey="from" value={query.from} label="Từ ngày" />
      <FilterDate paramKey="to" value={query.to} label="Đến ngày" />
    </FilterBar>
  );
}
