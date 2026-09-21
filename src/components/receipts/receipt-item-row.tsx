"use client";

import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import type { SupplierProduct } from "@/lib/receipts/actions";

import type { ReceiptItemState } from "./receipt-form";

export function ReceiptItemRow({
  item,
  availableProducts,
  onChange,
  onRemove,
}: {
  item: ReceiptItemState;
  availableProducts: SupplierProduct[];
  onChange: (patch: Partial<ReceiptItemState>) => void;
  onRemove: () => void;
}) {
  const difference = (Number(item.receivedQty) || 0) - (Number(item.deliveredQty) || 0);
  const lineTotal = (Number(item.receivedQty) || 0) * (Number(item.unitPrice) || 0);

  function handleSelectProduct(productId: string) {
    const product = availableProducts.find((p) => p.id === productId);
    if (!product) return;
    onChange({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      unitPrice: String(product.current_price),
    });
  }

  return (
    <TableRow>
      <TableCell className="min-w-[180px]">
        <Select
          value={item.productId || null}
          onValueChange={(value) => handleSelectProduct(String(value))}
          items={availableProducts.map((p) => ({ label: `${p.sku}`, value: p.id }))}
        >
          <SelectTrigger className="w-full" aria-label="Chọn SKU">
            <SelectValue placeholder="Chọn SKU" />
          </SelectTrigger>
          <SelectContent>
            {availableProducts.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.sku}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="min-w-[160px]">{item.name || "—"}</TableCell>
      <TableCell>{item.unit || "—"}</TableCell>
      <TableCell className="min-w-[110px]">
        <Input
          type="number"
          min={0}
          step="0.01"
          value={item.unitPrice}
          onChange={(e) => onChange({ unitPrice: e.target.value })}
          aria-label="Đơn giá"
        />
      </TableCell>
      <TableCell className="min-w-[90px]">
        <Input
          type="number"
          min={0}
          step="0.01"
          value={item.deliveredQty}
          onChange={(e) => onChange({ deliveredQty: e.target.value })}
          aria-label="SL giao"
        />
      </TableCell>
      <TableCell className="min-w-[90px]">
        <Input
          type="number"
          min={0}
          step="0.01"
          value={item.receivedQty}
          onChange={(e) => onChange({ receivedQty: e.target.value })}
          aria-label="SL nhận"
        />
      </TableCell>
      <TableCell className={difference < 0 ? "text-destructive" : undefined}>{difference}</TableCell>
      <TableCell>{formatCurrency(lineTotal)}</TableCell>
      <TableCell className="text-right">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Xóa dòng">
          <Trash2 className="text-destructive" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
