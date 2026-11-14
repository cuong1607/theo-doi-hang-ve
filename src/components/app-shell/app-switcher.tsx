"use client";

// APP-SHELL-1: top-left app switcher. Lists the apps this role may see (from
// the registry via hubApps), marks the current one, and always offers
// "Tất cả ứng dụng" → /apps — switching domains never needs a logout.
// "Sắp có" / locked apps are disabled items: they never navigate.
import Link from "next/link";
import { Check, ChevronsUpDown, LayoutGrid, Lock } from "lucide-react";

import { APP_HUB_PATH, type AppId, type HubApp } from "@/lib/apps/registry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { AppIconTile } from "./app-icons";

export function AppSwitcher({ current, apps }: { current: HubApp; apps: HubApp[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="app-switcher"
        aria-label={`Ứng dụng hiện tại: ${current.name}. Chuyển ứng dụng`}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg p-1 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:bg-sidebar-accent group-data-[collapsible=icon]:justify-center"
      >
        <AppIconTile icon={current.icon} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight group-data-[collapsible=icon]:hidden">
          <span className="truncate text-sm font-semibold text-heading">{current.name}</span>
          <span className="truncate text-xs text-muted-foreground">{current.subtitle}</span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" data-app={current.accent}>
        <DropdownMenuItem render={<Link href={APP_HUB_PATH} />} className="gap-2 py-1.5">
          <LayoutGrid className="size-4" /> Tất cả ứng dụng
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Ứng dụng</DropdownMenuLabel>
          {apps.map((app) => (
            <SwitcherItem key={app.id} app={app} currentId={current.id} />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SwitcherItem({ app, currentId }: { app: HubApp; currentId: AppId }) {
  const isCurrent = app.id === currentId;
  const body = (
    <>
      <span data-app={app.accent} className="contents">
        <AppIconTile icon={app.icon} size="sm" />
      </span>
      <span className="min-w-0 flex-1 truncate">{app.name}</span>
      {isCurrent && <Check aria-label="đang mở" className="size-4 text-app-accent-text" />}
      {app.access === "soon" && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Sắp có</span>}
      {app.access === "locked" && <Lock aria-label="không có quyền" className="size-3.5 text-muted-foreground" />}
    </>
  );
  if (app.access !== "open") {
    return (
      <DropdownMenuItem disabled className="gap-2 py-1.5" data-app-id={app.id}>
        {body}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem render={<Link href={app.href} />} className="gap-2 py-1.5" data-app-id={app.id} data-current={isCurrent || undefined}>
      {body}
    </DropdownMenuItem>
  );
}
