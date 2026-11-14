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

import { createRecipient, updateRecipient, type RecipientFormState } from "./recipients-actions";

const initialState: RecipientFormState = { status: "idle" };

export type RecipientRecord = {
  id: string;
  name: string;
  zaloUid: string;
};

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function RecipientFormDialog({
  open,
  onOpenChange,
  recipient,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipient?: RecipientRecord;
}) {
  const isEdit = !!recipient;
  const action = isEdit ? updateRecipient.bind(null, recipient.id) : createRecipient;
  const [state, formAction] = useActionState(action, initialState);

  useEffect(() => {
    if (open && state.status === "success") {
      onOpenChange(false);
    }
  }, [state.status, open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa người nhận" : "Thêm người nhận"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Cập nhật tên hoặc Zalo UID của người nhận thông báo."
              : "Người này sẽ nhận tất cả thông báo hệ thống gửi qua Zalo OA."}
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-3" key={JSON.stringify(state)}>
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium">
              Tên *
            </label>
            <Input
              id="name"
              name="name"
              defaultValue={state.values?.name ?? recipient?.name}
              maxLength={255}
              required
            />
            {state.fieldErrors?.name && (
              <p className="text-xs text-destructive">{state.fieldErrors.name[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="zaloUid" className="text-sm font-medium">
              Zalo UID *
            </label>
            <Input
              id="zaloUid"
              name="zaloUid"
              defaultValue={state.values?.zaloUid ?? recipient?.zaloUid}
              maxLength={255}
              required
            />
            {state.fieldErrors?.zaloUid && (
              <p className="text-xs text-destructive">{state.fieldErrors.zaloUid[0]}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Xem docs/zalo-integration.md mục &quot;Cách lấy recipient UID&quot; nếu chưa biết cách lấy UID này.
            </p>
          </div>
          {state.status === "error" && state.message && (
            <p className="text-sm text-destructive">{state.message}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <SubmitButton label={isEdit ? "Lưu thay đổi" : "Thêm người nhận"} pendingLabel="Đang lưu..." />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
