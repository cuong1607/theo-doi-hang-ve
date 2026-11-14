"use client";

// The signed-in user's menu (profile + logout) — one component for the hub
// and every app shell, so auth state is never duplicated per app.
import { useTransition } from "react";
import { LogOut, User } from "lucide-react";

import { logout } from "@/lib/auth/actions";
import { ROLE_LABELS, type Role } from "@/lib/auth/permissions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ShellUser {
  displayName: string;
  email: string;
  role: Role;
}

export function UserMenu({ user }: { user: ShellUser }) {
  const [isLoggingOut, startLogout] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="gap-2" aria-label={`Tài khoản: ${user.displayName}`} />}>
        <User className="size-4" />
        <span className="hidden max-w-40 truncate sm:inline">{user.displayName}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5 text-sm">
          <p className="truncate font-medium">{user.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          <p className="text-xs text-muted-foreground">Vai trò: {ROLE_LABELS[user.role]}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={isLoggingOut} onClick={() => startLogout(() => logout())}>
          <LogOut className="mr-2 size-4" />
          {isLoggingOut ? "Đang đăng xuất..." : "Đăng xuất"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
