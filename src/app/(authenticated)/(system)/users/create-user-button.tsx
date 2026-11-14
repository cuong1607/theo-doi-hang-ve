"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { ROLES, ROLE_LABELS } from "@/lib/auth/permissions";
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

import { createUser, type UserActionState } from "./actions";

const ROLE_ITEMS = ROLES.map((r) => ({ label: ROLE_LABELS[r], value: r }));
const initialState: UserActionState = { status: "idle" };

export function CreateUserButton() {
  const [open, setOpen] = useState(false);
  // Bumped on every open so the form remounts with fresh action state.
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <>
      <Button
        onClick={() => {
          setInstanceKey((k) => k + 1);
          setOpen(true);
        }}
      >
        <Plus className="mr-2 size-4" />
        Thêm người dùng
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <CreateUserForm key={instanceKey} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const [state, submit, isPending] = useActionState(createUser, initialState);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<string>("staff");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (state.status === "success") onDone();
  }, [state, onDone]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Thêm người dùng</DialogTitle>
        <DialogDescription>
          Tạo tài khoản đăng nhập bằng email + mật khẩu tạm. Gửi mật khẩu tạm cho người dùng qua kênh riêng.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="newUserEmail" className="text-sm font-medium">
            Email *
          </label>
          <Input id="newUserEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          {state.fieldErrors?.email && <p className="text-xs text-destructive">{state.fieldErrors.email[0]}</p>}
        </div>
        <div className="space-y-1.5">
          <label htmlFor="newUserName" className="text-sm font-medium">
            Họ tên
          </label>
          <Input id="newUserName" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={255} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="newUserRole" className="text-sm font-medium">
            Vai trò *
          </label>
          <Select value={role} onValueChange={(v) => setRole(String(v))} items={ROLE_ITEMS}>
            <SelectTrigger id="newUserRole" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_ITEMS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="newUserPassword" className="text-sm font-medium">
            Mật khẩu tạm * <span className="font-normal text-muted-foreground">(tối thiểu 8 ký tự)</span>
          </label>
          <Input
            id="newUserPassword"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {state.fieldErrors?.password && (
            <p className="text-xs text-destructive">{state.fieldErrors.password[0]}</p>
          )}
        </div>
        {state.status === "error" && state.message && !state.fieldErrors?.email && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={isPending}>
          Hủy
        </Button>
        <Button
          disabled={isPending}
          onClick={() =>
            startTransition(() => submit({ email, fullName, role: role as "admin" | "staff" | "viewer", password }))
          }
        >
          {isPending ? "Đang tạo..." : "Tạo tài khoản"}
        </Button>
      </DialogFooter>
    </>
  );
}
