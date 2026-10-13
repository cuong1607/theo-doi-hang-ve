"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const STATUS_OPTIONS = [
  { label: "Mọi trạng thái đơn", value: "all" },
  ...["UNPAID", "READY_TO_SHIP", "PROCESSED", "SHIPPED", "TO_CONFIRM_RECEIVE", "IN_CANCEL", "CANCELLED", "TO_RETURN", "COMPLETED"].map((s) => ({ label: s, value: s })),
];
const MAPPING_OPTIONS = [
  { label: "Mọi mapping", value: "all" },
  { label: "Đầy đủ", value: "complete" },
  { label: "Thiếu", value: "partial" },
  { label: "Chưa ghép", value: "unmapped" },
];
const FINANCIAL_OPTIONS = [
  { label: "Mọi trạng thái tài chính", value: "all" },
  ...["pending", "estimated", "settlement_available", "released", "mismatch", "return_adjusted"].map((s) => ({ label: s, value: s })),
];

type Values = { shop: string; status: string; mapping: string; financial: string; sn: string; sku: string; from: string; to: string };

export function OrderFilters({ shops, values }: { shops: { id: string; name: string }[]; values: Values }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function update(key: keyof Values, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "all") params.set(key, value);
    else params.delete(key);
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }
  function debounced(key: keyof Values, value: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => update(key, value.trim()), 300);
  }

  const shopItems = [{ label: "Tất cả shop", value: "all" }, ...shops.map((s) => ({ label: s.name, value: s.id }))];
  const select = (key: keyof Values, items: { label: string; value: string }[], label: string, width = "max-w-[200px]") => (
    <Select value={values[key] || "all"} onValueChange={(v) => update(key, String(v))} items={items}>
      <SelectTrigger className={`w-full ${width}`} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-[180px]">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input defaultValue={values.sn} onChange={(e) => debounced("sn", e.target.value)} placeholder="Mã đơn..." className="pl-8" aria-label="Mã đơn" />
      </div>
      <div className="relative w-full max-w-[200px]">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input defaultValue={values.sku} onChange={(e) => debounced("sku", e.target.value)} placeholder="SKU / tên sản phẩm..." className="pl-8" aria-label="SKU hoặc sản phẩm" />
      </div>
      <Input type="date" defaultValue={values.from} onChange={(e) => update("from", e.target.value)} className="w-[150px]" aria-label="Từ ngày" />
      <Input type="date" defaultValue={values.to} onChange={(e) => update("to", e.target.value)} className="w-[150px]" aria-label="Đến ngày" />
      {select("shop", shopItems, "Lọc theo shop")}
      {select("status", STATUS_OPTIONS, "Lọc theo trạng thái đơn")}
      {select("mapping", MAPPING_OPTIONS, "Lọc theo mapping", "max-w-[160px]")}
      {select("financial", FINANCIAL_OPTIONS, "Lọc theo trạng thái tài chính")}
    </div>
  );
}
