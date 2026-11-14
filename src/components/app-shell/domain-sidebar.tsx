"use client";

// APP-SHELL-1: one sidebar component, fed the CURRENT app's nav only (the
// server filtered it by role + flags). Active item comes from the URL
// (path + query), never from stored state. Desktop: collapsible to icons;
// mobile: the sidebar's sheet, closed again after each navigation.
import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { activeNavItemHref, type NavGroup } from "@/lib/apps/nav";
import type { HubApp } from "@/lib/apps/registry";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { LinkPendingHint } from "@/components/patterns/link-pending-hint";

import { NAV_ICONS } from "./app-icons";
import { AppSwitcher } from "./app-switcher";

export function DomainSidebar({ app, apps, groups }: { app: HubApp; apps: HubApp[]; groups: NavGroup[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeHref = activeNavItemHref(groups, pathname, searchParams);
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, searchParams, isMobile, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      {/* the mobile sheet is portalled outside the shell root → carry the accent here too */}
      <div data-app={app.accent} className="contents">
        <SidebarHeader className="border-b border-sidebar-border">
          <AppSwitcher current={app} apps={apps} />
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label={`Điều hướng ${app.name}`} className="contents">
            {groups.map((group, i) => (
              <SidebarGroup key={group.label ?? i}>
                {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => {
                      const Icon = NAV_ICONS[item.icon];
                      if (item.soon) {
                        return (
                          <SidebarMenuItem key={item.href}>
                            {/* no tooltip: the tooltip trigger would drop `disabled` (a disabled button can't host it anyway) */}
                            <SidebarMenuButton disabled aria-label={`${item.title} (sắp có)`} data-nav-soon="">
                              <Icon />
                              <span className="flex-1">{item.title}</span>
                              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground group-data-[collapsible=icon]:hidden">Sắp có</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      }
                      const isActive = item.href === activeHref;
                      return (
                        <SidebarMenuItem key={item.href}>
                          <SidebarMenuButton render={<Link href={item.href} aria-current={isActive ? "page" : undefined} />} isActive={isActive} tooltip={item.title}>
                            <Icon />
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
          </nav>
        </SidebarContent>
      </div>
      <SidebarRail />
    </Sidebar>
  );
}
