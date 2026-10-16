"use client";

import { FilterBar, FilterSelect, SearchInput, type FilterOption } from "@/components/patterns/filter-bar";

const WARNING_OPTIONS: FilterOption[] = [
  { label: "Mọi sản phẩm", value: "all" },
  { label: "Tồn tính giá vốn âm", value: "negative" },
  { label: "Thiếu dữ liệu giá vốn", value: "missing_cost" },
  { label: "Chưa có lịch sử", value: "no_history" },
  { label: "Cần tính lại", value: "needs_rebuild" },
  { label: "Chờ hóa đơn VAT", value: "vat_pending" },
];

const COST_FILTER_KEYS = ["q", "warning"] as const;

export function CostFilters({ q, warning }: { q: string; warning: string }) {
  return (
    <FilterBar filterKeys={COST_FILTER_KEYS}>
      <SearchInput paramKey="q" defaultValue={q} placeholder="SKU hoặc tên sản phẩm…" label="SKU hoặc tên sản phẩm" className="sm:w-64" />
      <FilterSelect paramKey="warning" value={warning} options={WARNING_OPTIONS} label="Lọc theo cảnh báo" />
    </FilterBar>
  );
}
