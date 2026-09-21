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

import { createSupplier, updateSupplier, type SupplierFormState } from "./actions";

const initialState: SupplierFormState = { status: "idle" };

export type SupplierRecord = {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  note: string | null;
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
