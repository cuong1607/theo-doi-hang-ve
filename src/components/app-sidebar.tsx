"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Megaphone, PackagePlus, History, FileText, PackageSearch, Box, Truck, Users, Wallet, Receipt, Bell, Store, Calculator, ChartColumn } from "lucide-react";

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
import { LinkPendingHint } from "@/components/patterns/link-pending-hint";
import { activeNavHref } from "@/lib/ui/navigation";

type NavItem = {
  title: string;
  href: string;
  icon: typeof LayoutDashboard;
  // Menu visibility only (UX). Pages/actions enforce the same permission
  // server-side.
  permission?: Permission;
  /** Feature flag the item depends on (SHOPEE-ADS-0). */
  flag?: "shopeeAds";
};

const navGroups: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      {
        title: "Tổng Quan",
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
      {
        title: "Giá vốn",
        href: "/inventory/costs",
        icon: Calculator,
        permission: "cost:view",
      },
    ],
  },
  {
    // SHOPEE-ADS-0: the legacy Shopee modules (dashboard, analytics, products,
    // orders, returns, return operations, payouts, sync, system health) are
    // retired and removed from navigation; only the Ads module remains.
    label: "SHOPEE",
    items: [
      {
        title: "Quảng cáo Shopee",
        href: "/shopee/ads",
        icon: Megaphone,
        permission: "channel:view",
        flag: "shopeeAds",
      },
      {
        // PRODUCT-ANALYTICS-2: order facts + Ads per product (DB only, read-only sync)
        title: "Phân tích sản phẩm",
        href: "/shopee/product-analytics",
        icon: ChartColumn,
        permission: "channel:view",
        flag: "shopeeAds",
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
      {
        title: "Tích hợp Shopee",
        href: "/settings/shopee",
        icon: Store,
        permission: "channel:manage",
      },
    ],
  },
];

export function AppSidebar({ role, shopeeAdsEnabled = false }: { role: Role; shopeeAdsEnabled?: boolean }) {
  const pathname = usePathname();
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => (!item.permission || hasPermission(role, item.permission)) && (item.flag !== "shopeeAds" || shopeeAdsEnabled)),
    }))
    .filter((group) => group.items.length > 0);
  // Exactly one active item: the longest href matching the path
  // (/receipts/new → "Nhập hàng", not also "Lịch sử hàng về").
  const activeHref = activeNavHref(pathname, visibleGroups.flatMap((g) => g.items.map((i) => i.href)));

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
                  const isActive = item.href === activeHref;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={item.href} />}
                        isActive={isActive}
                        tooltip={item.title}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                        <LinkPendingHint className="group-data-[collapsible=icon]:hidden" />
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
