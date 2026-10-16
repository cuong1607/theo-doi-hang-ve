"use client";

// Order list filters — every value lives in the URL (refresh / back /
// share keep the view). UIUX-1 FilterBar: debounced search, collapsible
// on mobile, "Xóa bộ lọc", "Đang cập nhật…" while the list reloads.
import { FilterBar, FilterDate, FilterSelect, SearchInput, type FilterOption } from "@/components/patterns/filter-bar";
import { ORDER_STATUS_LABELS } from "@/lib/channels/shopee/order-status";

import { FINANCIAL_STATUS_LABELS, ORDER_FILTER_KEYS } from "./labels";

const STATUS_OPTIONS: FilterOption[] = [
  { label: "Mọi trạng thái đơn", value: "all" },
  ...["UNPAID", "READY_TO_SHIP", "PROCESSED", "SHIPPED", "TO_CONFIRM_RECEIVE", "IN_CANCEL", "CANCELLED", "TO_RETURN", "COMPLETED"].map((s) => ({ label: ORDER_STATUS_LABELS[s] ?? s, value: s })),
];
const MAPPING_OPTIONS: FilterOption[] = [
  { label: "Mọi mapping", value: "all" },
  { label: "Ghép đầy đủ", value: "complete" },
  { label: "Ghép thiếu", value: "partial" },
  { label: "Chưa ghép", value: "unmapped" },
];
const FINANCIAL_OPTIONS: FilterOption[] = [
  { label: "Mọi trạng thái tài chính", value: "all" },
  ...Object.entries(FINANCIAL_STATUS_LABELS).map(([value, label]) => ({ label, value })),
];
// SHOPEE-5: one "Tài chính" filter covering the useful financial slices.
const FIN_VIEW_OPTIONS: FilterOption[] = [
  { label: "Mọi tình trạng lợi nhuận", value: "all" },
  { label: "Có lãi", value: "profit" },
  { label: "Lỗ", value: "loss" },
  { label: "Lệch đối soát", value: "mismatch" },
  { label: "Thiếu giá vốn", value: "cogs_missing" },
  { label: "Chưa có settlement", value: "settlement_missing" },
];

// PATCH: estimated profit (order value − COGS) state.
const ESTIMATED_OPTIONS: FilterOption[] = [
  { label: "Mọi tình trạng LN dự kiến", value: "all" },
  { label: "LN dự kiến: có lãi", value: "profit" },
  { label: "LN dự kiến: bán lỗ", value: "loss" },
  { label: "LN dự kiến: chưa đủ dữ liệu", value: "insufficient" },
];

type Values =Record<(typeof ORDER_FILTER_KEYS)[number], string>;

export function OrderFilters({ shops, values }: { shops: { id: string; name: string }[]; values: Values }) {
  const shopOptions: FilterOption[] = [{ label: "Tất cả shop", value: "all" }, ...shops.map((s) => ({ label: s.name, value: s.id }))];
  return (
    <FilterBar filterKeys={ORDER_FILTER_KEYS}>
      <SearchInput paramKey="sn" defaultValue={values.sn} placeholder="Mã đơn…" label="Mã đơn" className="sm:w-44" />
      <SearchInput paramKey="sku" defaultValue={values.sku} placeholder="SKU / tên sản phẩm…" label="SKU hoặc sản phẩm" />
      <FilterDate paramKey="from" value={values.from} label="Từ ngày" />
      <FilterDate paramKey="to" value={values.to} label="Đến ngày" />
      {shops.length > 1 && <FilterSelect paramKey="shop" value={values.shop} options={shopOptions} label="Lọc theo shop" />}
      <FilterSelect paramKey="status" value={values.status} options={STATUS_OPTIONS} label="Lọc theo trạng thái đơn" />
      <FilterSelect paramKey="mapping" value={values.mapping} options={MAPPING_OPTIONS} label="Lọc theo mapping" />
      <FilterSelect paramKey="financial" value={values.financial} options={FINANCIAL_OPTIONS} label="Lọc theo trạng thái tài chính" />
      <FilterSelect paramKey="est" value={values.est} options={ESTIMATED_OPTIONS} label="Lọc theo tình trạng lợi nhuận dự kiến" />
      <FilterSelect paramKey="fin" value={values.fin} options={FIN_VIEW_OPTIONS} label="Lọc theo lợi nhuận / đối soát" />
    </FilterBar>
  );
}
