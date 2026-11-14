"use client";

import { useState, useTransition } from "react";

import { ROLES, ROLE_LABELS, type Role } from "@/lib/auth/permissions";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { setUserActive, updateUserRole } from "./actions";

const ROLE_ITEMS = ROLES.map((r) => ({ label: ROLE_LABELS[r], value: r }));

// UI conveniences only — every change is re-authorized (user:manage) and
// re-validated (last active admin) on the server and in the database.
export function UserRowActions({
  user,
  isLastActiveAdmin,
}: {
  user: { id: string; email: string; role: Role; isActive: boolean };
  isLastActiveAdmin: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<{ status: string; message?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.status === "error") setError(result.message ?? "Không thể cập nhật người dùng.");
    });
  }

  function handleToggleActive() {
    const verb = user.isActive ? "vô hiệu hóa" : "kích hoạt lại";
    if (!window.confirm(`Bạn có chắc muốn ${verb} tài khoản ${user.email}?`)) return;
    run(() => setUserActive(user.id, !user.isActive));
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-2">
        <Select
          value={user.role}
          onValueChange={(value) => {
            if (value && value !== user.role) run(() => updateUserRole(user.id, String(value)));
          }}
          items={ROLE_ITEMS}
          disabled={isPending}
        >
          <SelectTrigger className="w-[130px]" aria-label={`Vai trò của ${user.email}`}>
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
        <Button
          variant={user.isActive ? "outline" : "default"}
          size="sm"
          onClick={handleToggleActive}
          disabled={isPending}
          title={isLastActiveAdmin ? "Đây là admin đang hoạt động cuối cùng." : undefined}
        >
          {user.isActive ? "Vô hiệu hóa" : "Kích hoạt"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="max-w-xs text-right text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
