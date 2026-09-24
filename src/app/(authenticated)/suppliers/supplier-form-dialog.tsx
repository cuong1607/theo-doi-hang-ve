"use client";

import { useActionState, useEffect, useState } from "react";
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

import { createSupplier, updateSupplier, type SupplierFormState } from "./actions";

const initialState: SupplierFormState = { status: "idle" };

const SUPPLIER_TYPE_OPTIONS = [
  { label: "Hộ kinh doanh", value: "business_household" },
  { label: "Công ty", value: "company" },
];

export type SupplierRecord = {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  note: string | null;
  supplier_type: string;
};

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function SupplierFormDialog({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier?: SupplierRecord;
}) {
  const isEdit = !!supplier;
  const action = isEdit ? updateSupplier.bind(null, supplier.id) : createSupplier;
  const [state, formAction] = useActionState(action, initialState);

  // Select is a controlled component; keep it outside the form's remounting
  // key so the current pick survives a failed submit.
  const [supplierType, setSupplierType] = useState(
    state.values?.supplierType || supplier?.supplier_type || "business_household"
  );

  // Closes the dialog once the action succeeds. Relies on the parent
  // remounting this component (e.g. via a `key` bumped on every open) each
  // time it's opened — otherwise a stale "success" from a previous submit
  // would still be sitting in `state` and this would fire again immediately.
  useEffect(() => {
    if (open && state.status === "success") {
      onOpenChange(false);
    }
  }, [state.status, open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa nhà cung cấp" : "Thêm nhà cung cấp"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Cập nhật thông tin nhà cung cấp."
              : "Nhập thông tin nhà cung cấp mới."}
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
            <label htmlFor="code" className="text-sm font-medium">
              Mã NCC *
            </label>
            <Input
              id="code"
              name="code"
              defaultValue={state.values?.code ?? supplier?.code}
              maxLength={50}
              required
            />
            {state.fieldErrors?.code && (
              <p className="text-xs text-destructive">{state.fieldErrors.code[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium">
              Tên NCC *
            </label>
            <Input
              id="name"
              name="name"
              defaultValue={state.values?.name ?? supplier?.name}
              maxLength={255}
              required
            />
            {state.fieldErrors?.name && (
              <p className="text-xs text-destructive">{state.fieldErrors.name[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="supplierType" className="text-sm font-medium">
              Loại nhà cung cấp *
            </label>
            <Select
              name="supplierType"
              required
              value={supplierType}
              onValueChange={(value) => setSupplierType(String(value))}
              items={SUPPLIER_TYPE_OPTIONS}
            >
              <SelectTrigger id="supplierType" className="w-full">
                <SelectValue placeholder="Chọn loại nhà cung cấp" />
              </SelectTrigger>
              <SelectContent>
                {SUPPLIER_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {state.fieldErrors?.supplierType && (
              <p className="text-xs text-destructive">{state.fieldErrors.supplierType[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="phone" className="text-sm font-medium">
              Điện thoại
            </label>
            <Input
              id="phone"
              name="phone"
              defaultValue={state.values?.phone ?? supplier?.phone ?? ""}
              maxLength={30}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="address" className="text-sm font-medium">
              Địa chỉ
            </label>
            <Input
              id="address"
              name="address"
              defaultValue={state.values?.address ?? supplier?.address ?? ""}
              maxLength={500}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="note" className="text-sm font-medium">
              Ghi chú
            </label>
            <Input
              id="note"
              name="note"
              defaultValue={state.values?.note ?? supplier?.note ?? ""}
              maxLength={1000}
            />
          </div>
          {state.status === "error" && state.message && (
            <p className="text-sm text-destructive">{state.message}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <SubmitButton
              label={isEdit ? "Lưu thay đổi" : "Thêm NCC"}
              pendingLabel="Đang lưu..."
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
