"use client";

import { useTransition } from "react";
import { usePathname } from "next/navigation";
import { LogOut, User } from "lucide-react";

import { logout } from "@/lib/auth/actions";
import { ROLE_LABELS, type Role } from "@/lib/auth/permissions";
import { BRAND_NAME } from "@/lib/brand";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const pageTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/receipts": "Lịch sử hàng về",
  "/receipts/new": "Nhập hàng",
  "/invoices": "Danh sách hóa đơn",
  "/invoices/new": "Tạo hóa đơn mới",
  "/outstanding": "Theo dõi hàng còn phải về",
  "/products": "Sản phẩm",
  "/suppliers": "Nhà cung cấp",
  "/users": "Người dùng",
};

export function AppHeader({ displayName, email, role }: { displayName: string; email: string; role: Role }) {
  const pathname = usePathname();
  const title = pageTitles[pathname] ?? BRAND_NAME;
  const [isLoggingOut, startLogout] = useTransition();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4!" />
      <h1 className="text-base font-semibold">{title}</h1>
      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="gap-2" />}>
            <User className="size-4" />
            <span className="hidden max-w-40 truncate sm:inline">{displayName}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5 text-sm">
              <p className="truncate font-medium">{displayName}</p>
              <p className="truncate text-xs text-muted-foreground">{email}</p>
              <p className="text-xs text-muted-foreground">Vai trò: {ROLE_LABELS[role]}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={isLoggingOut}
              onClick={() => startLogout(() => logout())}
            >
              <LogOut className="mr-2 size-4" />
              {isLoggingOut ? "Đang đăng xuất..." : "Đăng xuất"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
