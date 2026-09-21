"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ReceiptHistoryFilters({
  fromDate,
  toDate,
  supplierId,
  sku,
  productName,
  suppliers,
}: {
  fromDate: string;
  toDate: string;
  supplierId: string;
  sku: string;
  productName: string;
  suppliers: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  function updateParamDebounced(key: string, value: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => updateParam(key, value), 300);
  }

  const supplierItems = [
    { label: "Tất cả NCC", value: "all" },
    ...suppliers.map((s) => ({ label: `${s.code} — ${s.name}`, value: s.id })),
  ];

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <label htmlFor="fromDate" className="text-xs font-medium text-muted-foreground">
          Từ ngày
        </label>
        <Input
          id="fromDate"
          type="date"
          defaultValue={fromDate}
          onChange={(e) => updateParam("from", e.target.value)}
          className="w-[160px]"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="toDate" className="text-xs font-medium text-muted-foreground">
          Đến ngày
        </label>
        <Input
          id="toDate"
          type="date"
          defaultValue={toDate}
          onChange={(e) => updateParam("to", e.target.value)}
          className="w-[160px]"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="historySupplier" className="text-xs font-medium text-muted-foreground">
          Nhà cung cấp
        </label>
        <Select
          value={supplierId || "all"}
          onValueChange={(value) => updateParam("supplier", value === "all" ? "" : String(value))}
          items={supplierItems}
        >
          <SelectTrigger id="historySupplier" className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả NCC</SelectItem>
            {suppliers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.code} — {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="historySku" className="text-xs font-medium text-muted-foreground">
          SKU
        </label>
        <div className="relative w-[160px]">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="historySku"
            defaultValue={sku}
            onChange={(e) => updateParamDebounced("sku", e.target.value)}
            placeholder="Tìm SKU..."
            className="pl-8"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="historyProductName" className="text-xs font-medium text-muted-foreground">
          Tên sản phẩm
        </label>
        <div className="relative w-[200px]">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="historyProductName"
            defaultValue={productName}
            onChange={(e) => updateParamDebounced("name", e.target.value)}
            placeholder="Tìm tên sản phẩm..."
            className="pl-8"
          />
        </div>
      </div>
    </div>
  );
}
