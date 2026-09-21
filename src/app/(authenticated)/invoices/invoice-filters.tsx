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

export function InvoiceFilters({
  fromDate,
  toDate,
  supplierId,
  invoiceNo,
  suppliers,
}: {
  fromDate: string;
  toDate: string;
  supplierId: string;
  invoiceNo: string;
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
        <label htmlFor="invFromDate" className="text-xs font-medium text-muted-foreground">
          Từ ngày
        </label>
        <Input
          id="invFromDate"
          type="date"
          defaultValue={fromDate}
          onChange={(e) => updateParam("from", e.target.value)}
          className="w-[160px]"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="invToDate" className="text-xs font-medium text-muted-foreground">
          Đến ngày
        </label>
        <Input
          id="invToDate"
          type="date"
          defaultValue={toDate}
          onChange={(e) => updateParam("to", e.target.value)}
          className="w-[160px]"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="invSupplier" className="text-xs font-medium text-muted-foreground">
          Nhà cung cấp
        </label>
        <Select
          value={supplierId || "all"}
          onValueChange={(value) => updateParam("supplier", value === "all" ? "" : String(value))}
          items={supplierItems}
        >
          <SelectTrigger id="invSupplier" className="w-[220px]">
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
        <label htmlFor="invNo" className="text-xs font-medium text-muted-foreground">
          Số hóa đơn
        </label>
        <div className="relative w-[200px]">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="invNo"
            defaultValue={invoiceNo}
            onChange={(e) => updateParamDebounced("invoiceNo", e.target.value)}
            placeholder="Tìm số hóa đơn..."
            className="pl-8"
          />
        </div>
      </div>
    </div>
  );
}
