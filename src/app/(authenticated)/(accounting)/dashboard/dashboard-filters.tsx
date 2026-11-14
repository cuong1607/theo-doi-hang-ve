"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RANGE_PRESETS, type RangePreset } from "@/lib/dashboard/date-range";

const SUPPLIER_TYPE_OPTIONS = [
  { label: "Tất cả loại NCC", value: "all" },
  { label: "Hộ kinh doanh", value: "business_household" },
  { label: "Công ty", value: "company" },
];

export function DashboardFilters({
  range,
  customFrom,
  customTo,
  supplierId,
  supplierType,
  suppliers,
}: {
  range: RangePreset;
  customFrom: string;
  customTo: string;
  supplierId: string;
  supplierType: string;
  suppliers: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParams(patch: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  const supplierItems = [
    { label: "Tất cả NCC", value: "all" },
    ...suppliers.map((s) => ({ label: `${s.code} — ${s.name}`, value: s.id })),
  ];

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex gap-1 rounded-lg border border-input p-1">
        {RANGE_PRESETS.map((opt) => (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant={range === opt.value ? "default" : "ghost"}
            onClick={() => updateParams({ range: opt.value })}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      {range === "custom" && (
        <>
          <div className="space-y-1.5">
            <label htmlFor="dashFrom" className="text-xs font-medium text-muted-foreground">
              Từ ngày
            </label>
            <Input
              id="dashFrom"
              type="date"
              defaultValue={customFrom}
              onChange={(e) => updateParams({ from: e.target.value })}
              className="w-[160px]"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="dashTo" className="text-xs font-medium text-muted-foreground">
              Đến ngày
            </label>
            <Input
              id="dashTo"
              type="date"
              defaultValue={customTo}
              onChange={(e) => updateParams({ to: e.target.value })}
              className="w-[160px]"
            />
          </div>
        </>
      )}

      <div className="space-y-1.5">
        <label htmlFor="dashSupplier" className="text-xs font-medium text-muted-foreground">
          Nhà cung cấp
        </label>
        <Select
          value={supplierId || "all"}
          onValueChange={(value) => updateParams({ supplier: value === "all" ? "" : String(value) })}
          items={supplierItems}
        >
          <SelectTrigger id="dashSupplier" className="w-[220px]">
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
        <label htmlFor="dashSupplierType" className="text-xs font-medium text-muted-foreground">
          Loại NCC
        </label>
        <Select
          value={supplierType || "all"}
          onValueChange={(value) => updateParams({ supplierType: value === "all" ? "" : String(value) })}
          items={SUPPLIER_TYPE_OPTIONS}
        >
          <SelectTrigger id="dashSupplierType" className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPLIER_TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
