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

const STATUS_OPTIONS = [
  { label: "Tất cả trạng thái", value: "all" },
  { label: "Đang hoạt động", value: "active" },
  { label: "Ngừng hoạt động", value: "inactive" },
];

export function ProductFilters({
  sku,
  name,
  supplierId,
  status,
  suppliers,
}: {
  sku: string;
  name: string;
  supplierId: string;
  status: string;
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
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-[180px]">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          defaultValue={sku}
          onChange={(e) => updateParamDebounced("sku", e.target.value)}
          placeholder="Tìm SKU..."
          className="pl-8"
          aria-label="Tìm theo SKU"
        />
      </div>
      <div className="relative w-full max-w-[200px]">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          defaultValue={name}
          onChange={(e) => updateParamDebounced("name", e.target.value)}
          placeholder="Tìm tên sản phẩm..."
          className="pl-8"
          aria-label="Tìm theo tên sản phẩm"
        />
      </div>
      <Select
        value={supplierId || "all"}
        onValueChange={(value) => updateParam("supplier", value === "all" ? "" : String(value))}
        items={supplierItems}
      >
        <SelectTrigger className="w-full max-w-[220px]" aria-label="Lọc theo nhà cung cấp">
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
      <Select
        value={status || "all"}
        onValueChange={(value) => updateParam("status", value === "all" ? "" : String(value))}
        items={STATUS_OPTIONS}
      >
        <SelectTrigger className="w-full max-w-[180px]" aria-label="Lọc theo trạng thái">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
