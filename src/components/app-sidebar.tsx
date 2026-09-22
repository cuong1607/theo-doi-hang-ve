"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  PackagePlus,
  History,
  FileText,
  PackageSearch,
  Box,
  Truck,
  Users,
  Wallet,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const navGroups = [
  {
    items: [
      {
        title: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
      },
    ],
  },
  {
    label: "HÀNG VỀ",
    items: [
      {
        title: "Nhập hàng",
        href: "/receipts/new",
        icon: PackagePlus,
      },
      {
        title: "Lịch sử hàng về",
        href: "/receipts",
        icon: History,
      },
    ],
  },
  {
    label: "HÓA ĐƠN",
    items: [
      {
        title: "Danh sách hóa đơn",
        href: "/invoices",
        icon: FileText,
      },
      {
        title: "Theo dõi hàng còn phải về",
        href: "/outstanding",
        icon: PackageSearch,
      },
      {
        title: "Công nợ NCC",
        href: "/debts",
        icon: Wallet,
      },
    ],
  },
  {
    label: "DANH MỤC",
    items: [
      {
        title: "Sản phẩm",
        href: "/products",
        icon: Box,
      },
      {
        title: "Nhà cung cấp",
        href: "/suppliers",
        icon: Truck,
      },
    ],
  },
  {
    label: "HỆ THỐNG",
    items: [
      {
        title: "Người dùng",
        href: "/users",
        icon: Users,
      },
    ],
  },
];

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-1">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <PackageSearch className="size-4" />
          </div>
          <div className="flex flex-col gap-0.5 leading-none group-data-[collapsible=icon]:hidden">
            <span className="font-semibold text-sm">Theo Dõi Hàng Về</span>
            <span className="text-xs text-muted-foreground">Quản lý kho</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group, groupIndex) => (
          <SidebarGroup key={groupIndex}>
            {group.label && (
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isActive =
                    pathname === item.href ||
                    (item.href !== "/dashboard" &&
                      pathname.startsWith(item.href + "/"));
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={item.href} />}
                        isActive={isActive}
                        tooltip={item.title}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
