"use client";

// SHOPEE-8 global filter bar: period preset (+ custom dates), shop. Every
// value lives in the URL (?period=7d&shop=…) — the server re-validates it.
import { FilterBar, FilterDate, FilterSelect, SearchInput, type FilterOption } from "@/components/patterns/filter-bar";
import { PERIOD_LABELS, PERIOD_PRESETS } from "@/lib/analytics/periods";

const PERIOD_OPTIONS: FilterOption[] = PERIOD_PRESETS.map((p) => ({ value: p, label: PERIOD_LABELS[p] }));

export function AnalyticsFilters({
  query,
  shops,
  extraKeys = [],
  typeFilter = false,
  search = false,
}: {
  query: Record<string, string | undefined>;
  shops: Array<{ id: string; name: string }>;
  extraKeys?: string[];
  typeFilter?: boolean;
  search?: boolean;
}) {
  const keys = ["period", "from", "to", "shop", ...extraKeys];
  const shopOptions: FilterOption[] = [{ label: "Tất cả shop", value: "all" }, ...shops.map((s) => ({ value: s.id, label: s.name }))];
  const period = query.period ?? (query.from || query.to ? "custom" : "today");
  return (
    <FilterBar filterKeys={keys}>
      <FilterSelect paramKey="period" value={period} options={PERIOD_OPTIONS} label="Khoảng thời gian" />
      {period === "custom" && (
        <>
          <FilterDate paramKey="from" value={query.from} label="Từ ngày" />
          <FilterDate paramKey="to" value={query.to} label="Đến ngày" />
        </>
      )}
      {shops.length > 1 && <FilterSelect paramKey="shop" value={query.shop} options={shopOptions} label="Shop" />}
      {typeFilter && (
        <FilterSelect
          paramKey="type"
          value={query.type}
          options={[
            { value: "all", label: "Mọi loại" },
            { value: "atomic", label: "Sản phẩm" },
            { value: "combo", label: "Combo" },
          ]}
          label="Loại sản phẩm"
        />
      )}
      {search && <SearchInput paramKey="q" defaultValue={query.q} placeholder="SKU / tên…" label="Tìm SKU hoặc tên" />}
    </FilterBar>
  );
}
