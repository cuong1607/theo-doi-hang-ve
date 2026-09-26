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
  Receipt,
  Bell,
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
import { hasPermission, type Permission, type Role } from "@/lib/auth/permissions";
import { APP_NAME, BRAND_NAME } from "@/lib/brand";
import { BrandLogo } from "@/components/brand-logo";

type NavItem = {
  title: string;
  href: string;
  icon: typeof LayoutDashboard;
  // Menu visibility only (UX). Pages/actions enforce the same permission
  // server-side.
  permission?: Permission;
};

const navGroups: { label?: string; items: NavItem[] }[] = [
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
        permission: "receipt:create",
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
      {
        title: "Lịch sử thanh toán",
        href: "/payments",
        icon: Receipt,
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
        permission: "user:manage",
      },
      {
        title: "Cài đặt thông báo",
        href: "/settings/notifications",
        icon: Bell,
        permission: "notification:manage",
      },
    ],
  },
];

export function AppSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.permission || hasPermission(role, item.permission)),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <Link href="/dashboard" className="flex items-center gap-2 px-0.5 py-1" aria-label={`${BRAND_NAME} — Dashboard`}>
          <BrandLogo size={36} priority className="group-data-[collapsible=icon]:size-8" />
          <div className="flex min-w-0 flex-col gap-0.5 leading-none group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-bold tracking-wide text-heading">{BRAND_NAME}</span>
            <span className="text-xs text-muted-foreground">{APP_NAME}</span>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {visibleGroups.map((group, groupIndex) => (
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
