"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { createProduct, updateProduct, type ProductFormState } from "./actions";

const initialState: ProductFormState = { status: "idle" };

export type ProductRecord = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  current_price: number;
  supplier_id: string;
};

export type SupplierOption = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function ProductFormDialog({
  open,
  onOpenChange,
  product,
  suppliers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: ProductRecord;
  suppliers: SupplierOption[];
}) {
  const isEdit = !!product;
  const action = isEdit ? updateProduct.bind(null, product.id) : createProduct;
  const [state, formAction] = useActionState(action, initialState);

  // Closes the dialog once the action succeeds. Relies on the parent
  // remounting this component (via a `key` bumped on every open) each time
  // it's opened — otherwise a stale "success" from a previous submit would
  // still be sitting in `state` and this would fire again immediately.
  useEffect(() => {
    if (open && state.status === "success") {
      onOpenChange(false);
    }
  }, [state.status, open, onOpenChange]);

  // New products can only be assigned to an active supplier. An existing
  // product keeps showing its current supplier even if it was deactivated
  // since, so editing other fields doesn't force a reassignment.
  const supplierOptions = suppliers.filter(
    (s) => s.is_active || s.id === product?.supplier_id
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa sản phẩm" : "Thêm sản phẩm"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Cập nhật thông tin sản phẩm." : "Nhập thông tin sản phẩm mới."}
          </DialogDescription>
        </DialogHeader>
        <form
          action={formAction}
          className="space-y-3"
          // React resets uncontrolled fields after every action call. Keying
          // on the action's result forces a remount exactly when a new
          // result comes back, so defaultValue can restore what was typed
          // (state.values) instead of the browser clearing the form on error.
          key={JSON.stringify(state)}
        >
          <div className="space-y-1.5">
            <label htmlFor="sku" className="text-sm font-medium">
              SKU *
            </label>
            <Input
              id="sku"
              name="sku"
              defaultValue={state.values?.sku ?? product?.sku}
              maxLength={100}
              required
            />
            {state.fieldErrors?.sku && (
              <p className="text-xs text-destructive">{state.fieldErrors.sku[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium">
              Tên sản phẩm *
            </label>
            <Input
              id="name"
              name="name"
              defaultValue={state.values?.name ?? product?.name}
              maxLength={255}
              required
            />
            {state.fieldErrors?.name && (
              <p className="text-xs text-destructive">{state.fieldErrors.name[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="unit" className="text-sm font-medium">
              Đơn vị *
            </label>
            <Input
              id="unit"
              name="unit"
              defaultValue={state.values?.unit ?? product?.unit}
              maxLength={50}
              required
            />
            {state.fieldErrors?.unit && (
              <p className="text-xs text-destructive">{state.fieldErrors.unit[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="currentPrice" className="text-sm font-medium">
              Đơn giá hiện tại *
            </label>
            <Input
              id="currentPrice"
              name="currentPrice"
              type="number"
              min={0}
              step="0.01"
              defaultValue={state.values?.currentPrice ?? product?.current_price}
              required
            />
            {state.fieldErrors?.currentPrice && (
              <p className="text-xs text-destructive">{state.fieldErrors.currentPrice[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="supplierId" className="text-sm font-medium">
              Nhà cung cấp *
            </label>
            <Select
              name="supplierId"
              required
              defaultValue={state.values?.supplierId ?? product?.supplier_id}
              items={supplierOptions.map((s) => ({ label: `${s.code} — ${s.name}`, value: s.id }))}
            >
              <SelectTrigger id="supplierId" className="w-full">
                <SelectValue placeholder="Chọn nhà cung cấp" />
              </SelectTrigger>
              <SelectContent>
                {supplierOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {state.fieldErrors?.supplierId && (
              <p className="text-xs text-destructive">{state.fieldErrors.supplierId[0]}</p>
            )}
          </div>
          {state.status === "error" && state.message && (
            <p className="text-sm text-destructive">{state.message}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <SubmitButton label={isEdit ? "Lưu thay đổi" : "Thêm sản phẩm"} pendingLabel="Đang lưu..." />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
