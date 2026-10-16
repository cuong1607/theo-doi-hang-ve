"use client";

// Shopee product list filters (URL state). UIUX-1 FilterBar: debounced
// searches with clear buttons, collapsible on mobile, "Xóa bộ lọc".
import { FilterBar, FilterSelect, SearchInput, type FilterOption } from "@/components/patterns/filter-bar";

import { PRODUCT_FILTER_KEYS } from "../shared";

const MAPPING_OPTIONS: FilterOption[] = [
  { label: "Mọi trạng thái ghép", value: "all" },
  { label: "Chưa ghép", value: "unmapped" },
  { label: "Tự động ghép", value: "auto_mapped" },
  { label: "Ghép thủ công", value: "manual_mapped" },
  { label: "Xung đột", value: "mapping_conflict" },
  { label: "Cần kiểm tra lại", value: "review" },
];

const ITEM_STATUS_OPTIONS: FilterOption[] = [
  { label: "Mọi trạng thái Shopee", value: "all" },
  ...["NORMAL", "UNLIST", "REVIEWING", "BANNED", "SELLER_DELETE", "SHOPEE_DELETE"].map((s) => ({ label: s, value: s })),
];

export function ShopeeProductFilters({
  shops,
  values,
}: {
  shops: { id: string; name: string }[];
  values: { shop: string; mapping: string; status: string; name: string; sku: string; isku: string };
}) {
  const shopOptions: FilterOption[] = [{ label: "Tất cả shop", value: "all" }, ...shops.map((s) => ({ label: s.name, value: s.id }))];
  return (
    <FilterBar filterKeys={PRODUCT_FILTER_KEYS}>
      <SearchInput paramKey="name" defaultValue={values.name} placeholder="Tên sản phẩm…" label="Tên sản phẩm" />
      <SearchInput paramKey="sku" defaultValue={values.sku} placeholder="SKU Shopee…" label="SKU Shopee" className="sm:w-44" />
      <SearchInput paramKey="isku" defaultValue={values.isku} placeholder="SKU nội bộ…" label="SKU nội bộ" className="sm:w-44" />
      {shops.length > 1 && <FilterSelect paramKey="shop" value={values.shop} options={shopOptions} label="Lọc theo shop" />}
      <FilterSelect paramKey="mapping" value={values.mapping} options={MAPPING_OPTIONS} label="Lọc theo trạng thái ghép" />
      <FilterSelect paramKey="status" value={values.status} options={ITEM_STATUS_OPTIONS} label="Lọc theo trạng thái Shopee" />
    </FilterBar>
  );
}
