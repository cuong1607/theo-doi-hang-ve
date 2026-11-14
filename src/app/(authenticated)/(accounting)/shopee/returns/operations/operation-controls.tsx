"use client";

import { Check, RefreshCw, Undo2 } from "lucide-react";

import { FilterBar, FilterDate, FilterSelect, SearchInput, type FilterOption } from "@/components/patterns/filter-bar";
import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";

import { confirmReceivedAction, refreshReturnDataAction } from "./actions";

export const OPERATION_FILTER_KEYS = ["date", "shop", "carrier", "type", "window", "status", "q"] as const;

export function OperationFilters({
  query,
  shops,
  carriers,
  windows,
  statuses,
  showWindow,
}: {
  query: Record<string, string | undefined>;
  shops: FilterOption[];
  carriers: FilterOption[];
  windows: FilterOption[];
  statuses: FilterOption[];
  showWindow: boolean;
}) {
  return (
    <FilterBar filterKeys={OPERATION_FILTER_KEYS}>
      <FilterDate paramKey="date" value={query.date} label="Ngày giao thành công" />
      {shops.length > 2 && <FilterSelect paramKey="shop" value={query.shop} options={shops} label="Lọc theo shop" />}
      <FilterSelect paramKey="carrier" value={query.carrier} options={carriers} label="Lọc theo đơn vị vận chuyển" />
      <FilterSelect
        paramKey="type"
        value={query.type}
        options={[
          { label: "Mọi loại hoàn", value: "all" },
          { label: "Hoàn Trả", value: "customer_return" },
          { label: "Hoàn Hủy", value: "failed_delivery_return" },
        ]}
        label="Lọc theo loại hoàn"
      />
      {showWindow && <FilterSelect paramKey="window" value={query.window} options={windows} label="Lọc theo ca giao" />}
      <FilterSelect paramKey="status" value={query.status} options={statuses} label="Lọc theo trạng thái" />
      <SearchInput paramKey="q" defaultValue={query.q} placeholder="Mã đơn / mã hoàn / vận đơn…" label="Tìm theo mã đơn, mã đơn hoàn hoặc mã vận đơn" />
    </FilterBar>
  );
}

export function RefreshReturnsButton({ shopId, date, active }: { shopId: string | null; date: string; active: boolean }) {
  const { run, pending } = useAsyncAction({ refresh: true });
  return (
    <LoadingButton
      loading={pending || active}
      loadingText={active ? "Đang làm mới…" : "Đang gửi yêu cầu…"}
      icon={<RefreshCw aria-hidden="true" />}
      onClick={() => run(() => refreshReturnDataAction(shopId, date))}
    >
      Làm mới dữ liệu hoàn
    </LoadingButton>
  );
}

export function ReceiveButton({ operationId, confirmed }: { operationId: string; confirmed: boolean }) {
  const { run, pending } = useAsyncAction({ refresh: true });
  if (confirmed) {
    return (
      <LoadingButton size="xs" variant="ghost" loading={pending} icon={<Undo2 aria-hidden="true" />} onClick={() => run(() => confirmReceivedAction(operationId, false))} title="Bỏ xác nhận đã nhận">
        Bỏ
      </LoadingButton>
    );
  }
  return (
    <LoadingButton size="xs" variant="outline" loading={pending} icon={<Check aria-hidden="true" />} onClick={() => run(() => confirmReceivedAction(operationId, true))}>
      Đã nhận
    </LoadingButton>
  );
}
