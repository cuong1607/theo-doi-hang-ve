"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MAPPING_OPTIONS = [
  { label: "Mọi trạng thái ghép", value: "all" },
  { label: "Chưa ghép", value: "unmapped" },
  { label: "Tự động ghép", value: "auto_mapped" },
  { label: "Ghép thủ công", value: "manual_mapped" },
  { label: "Xung đột", value: "mapping_conflict" },
  { label: "Cần kiểm tra lại", value: "review" },
];

const ITEM_STATUS_OPTIONS = [
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  function debounced(key: string, value: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => updateParam(key, value.trim()), 300);
  }

  const shopItems = [{ label: "Tất cả shop", value: "all" }, ...shops.map((s) => ({ label: s.name, value: s.id }))];

  const textInput = (key: "name" | "sku" | "isku", placeholder: string) => (
    <div className="relative w-full max-w-[190px]">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input defaultValue={values[key]} onChange={(e) => debounced(key, e.target.value)} placeholder={placeholder} className="pl-8" aria-label={placeholder} />
    </div>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {textInput("name", "Tên sản phẩm Shopee...")}
      {textInput("sku", "SKU Shopee...")}
      {textInput("isku", "SKU nội bộ...")}
      <Select value={values.shop || "all"} onValueChange={(v) => updateParam("shop", v === "all" ? "" : String(v))} items={shopItems}>
        <SelectTrigger className="w-full max-w-[200px]" aria-label="Lọc theo shop">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {shopItems.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={values.mapping || "all"} onValueChange={(v) => updateParam("mapping", v === "all" ? "" : String(v))} items={MAPPING_OPTIONS}>
        <SelectTrigger className="w-full max-w-[190px]" aria-label="Lọc theo trạng thái ghép">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MAPPING_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={values.status || "all"} onValueChange={(v) => updateParam("status", v === "all" ? "" : String(v))} items={ITEM_STATUS_OPTIONS}>
        <SelectTrigger className="w-full max-w-[190px]" aria-label="Lọc theo trạng thái Shopee">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ITEM_STATUS_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
