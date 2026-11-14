"use client";

// APP-SHELL-1: the shell's top bar — sidebar toggle, a light breadcrumb
// (Ứng dụng / <app> / <page>), the page title and the user menu. Title and
// crumbs are derived from the URL + the app's nav config only.
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";

import { activeNavItemHref, navItemByHref, type NavGroup } from "@/lib/apps/nav";
import { APP_HUB_PATH, type HubApp } from "@/lib/apps/registry";
import { pageTitleFor } from "@/lib/ui/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

import { UserMenu, type ShellUser } from "./user-menu";

/** Page title: a query-specific nav item wins ("Sản phẩm cần chú ý"), then the page-title map, then the nav item, then the app. */
export function shellPageTitle(app: HubApp, groups: NavGroup[], pathname: string, search: URLSearchParams | string): string {
  const item = navItemByHref(groups, activeNavItemHref(groups, pathname, search));
  if (item?.href.includes("?")) return item.title;
  return pageTitleFor(pathname, item?.title ?? app.name);
}

export function ShellHeader({ app, groups, user }: { app: HubApp; groups: NavGroup[]; user: ShellUser }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const title = shellPageTitle(app, groups, pathname, searchParams);
  const onLanding = pathname === app.href;

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <SidebarTrigger className="-ml-1" aria-label="Mở / thu gọn menu" />
      <Separator orientation="vertical" className="mr-1 h-4!" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        <nav aria-label="Đường dẫn" className="hidden min-w-0 shrink-0 sm:block">
          <ol className="flex items-center gap-1.5 text-muted-foreground">
            <li>
              <Link href={APP_HUB_PATH} className="rounded hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                Ứng dụng
              </Link>
            </li>
            <li aria-hidden="true">
              <ChevronRight className="size-3.5" />
            </li>
            <li>
              <Link href={app.href} aria-current={onLanding ? "page" : undefined} className="rounded font-medium text-app-accent-text hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                {app.name}
              </Link>
            </li>
          </ol>
        </nav>
        {!onLanding && <ChevronRight aria-hidden="true" className="hidden size-3.5 shrink-0 text-muted-foreground sm:block" />}
        <h1 className={`truncate text-base font-semibold ${onLanding ? "sm:sr-only" : ""}`}>{title}</h1>
      </div>
      <UserMenu user={user} />
    </header>
  );
}
