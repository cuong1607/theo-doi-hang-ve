"use client";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SupplierType } from "@/lib/invoices/financials";

export const DISCOUNT_TYPE_OPTIONS = [
  { label: "Không áp dụng", value: "none" },
  { label: "Phần trăm (%)", value: "percent" },
  { label: "Số tiền cố định", value: "fixed_amount" },
];

// The financial-policy inputs for one invoice, by supplier type (UP2/UP3):
// business_household -> discount (none / % / fixed amount), no VAT;
// company -> VAT %, no discount. Shared by the manual invoice form and the
// "create from receipts" dialog so both render the same policy. Inputs
// only — amounts are always computed by calculateInvoiceFinancials.
// "none" is a UI-only sentinel for "no discount" and is never sent as-is.
export function InvoiceFinancialFields({
  supplierType,
  discountType,
  onDiscountTypeChange,
  discountValue,
  onDiscountValueChange,
  vatRate,
  onVatRateChange,
  fieldErrors,
  className = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
}: {
  supplierType: SupplierType;
  discountType: string;
  onDiscountTypeChange: (value: string) => void;
  discountValue: string;
  onDiscountValueChange: (value: string) => void;
  vatRate: string;
  onVatRateChange: (value: string) => void;
  fieldErrors?: Record<string, string[]>;
  className?: string;
}) {
  if (supplierType === "company") {
    return (
      <div className={className}>
        <div className="space-y-1.5">
          <label htmlFor="vatRate" className="text-sm font-medium">
            VAT (%)
          </label>
          <Input
            id="vatRate"
            type="number"
            min={0}
            step="0.01"
            value={vatRate}
            onChange={(e) => onVatRateChange(e.target.value)}
          />
          {fieldErrors?.vatRate && <p className="text-xs text-destructive">{fieldErrors.vatRate[0]}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="space-y-1.5">
        <label htmlFor="discountType" className="text-sm font-medium">
          Loại chiết khấu
        </label>
        <Select
          value={discountType}
          onValueChange={(value) => onDiscountTypeChange(String(value))}
          items={DISCOUNT_TYPE_OPTIONS}
        >
          <SelectTrigger id="discountType" className="w-full">
            <SelectValue placeholder="Không áp dụng" />
          </SelectTrigger>
          <SelectContent>
            {DISCOUNT_TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {discountType !== "none" && (
        <div className="space-y-1.5">
          <label htmlFor="discountValue" className="text-sm font-medium">
            Giá trị chiết khấu {discountType === "percent" ? "(%)" : "(VNĐ)"} *
          </label>
          <Input
            id="discountValue"
            type="number"
            min={0}
            max={discountType === "percent" ? 100 : undefined}
            step="0.01"
            value={discountValue}
            onChange={(e) => onDiscountValueChange(e.target.value)}
          />
          {fieldErrors?.discountValue && (
            <p className="text-xs text-destructive">{fieldErrors.discountValue[0]}</p>
          )}
        </div>
      )}
    </div>
  );
}
