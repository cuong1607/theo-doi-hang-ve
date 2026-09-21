"use client";

import { usePathname } from "next/navigation";
import { LogOut, User } from "lucide-react";

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

export function AppHeader() {
  const pathname = usePathname();
  const title = pageTitles[pathname] ?? "Theo Dõi Hàng Về";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4!" />
      <h1 className="text-base font-semibold">{title}</h1>
      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="gap-2" />
            }
          >
            <User className="size-4" />
            <span className="hidden sm:inline">Người dùng</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem disabled>
              <User className="mr-2 size-4" />
              Hồ sơ
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <LogOut className="mr-2 size-4" />
              Đăng xuất
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
