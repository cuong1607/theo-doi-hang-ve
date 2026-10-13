"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const WARNING_OPTIONS = [
  { label: "Mọi sản phẩm", value: "all" },
  { label: "Tồn tính giá vốn âm", value: "negative" },
  { label: "Thiếu dữ liệu giá vốn", value: "missing_cost" },
  { label: "Chưa có lịch sử", value: "no_history" },
  { label: "Cần tính lại", value: "needs_rebuild" },
];

export function CostFilters({ q, warning }: { q: string; warning: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function update(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "all") params.set(key, value);
    else params.delete(key);
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-[220px]">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          defaultValue={q}
          onChange={(e) => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            const v = e.target.value.trim();
            timeoutRef.current = setTimeout(() => update("q", v), 300);
          }}
          placeholder="SKU / tên sản phẩm..."
          className="pl-8"
          aria-label="Tìm sản phẩm"
        />
      </div>
      <Select value={warning || "all"} onValueChange={(v) => update("warning", String(v))} items={WARNING_OPTIONS}>
        <SelectTrigger className="w-full max-w-[220px]" aria-label="Lọc cảnh báo">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WARNING_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
