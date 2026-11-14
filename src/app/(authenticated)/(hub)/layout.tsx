import Link from "next/link";

import { BRAND_NAME } from "@/lib/brand";
import { APP_HUB_PATH } from "@/lib/apps/registry";
import { BrandLogo } from "@/components/brand-logo";
import { shellUser } from "@/components/app-shell/app-shell";
import { UserMenu } from "@/components/app-shell/user-menu";

// APP-SHELL-1: the workspace launcher frame (/apps, /forbidden) — a slim top
// bar only, no domain sidebar.
export default async function HubLayout({ children }: { children: React.ReactNode }) {
  const user = await shellUser();
  return (
    <div data-app="hub" className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 md:px-6">
          <Link href={APP_HUB_PATH} className="flex min-w-0 items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none" aria-label={`${BRAND_NAME} — Tất cả ứng dụng`}>
            <BrandLogo size={32} priority />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-bold tracking-wide text-heading">{BRAND_NAME}</span>
              <span className="text-xs text-muted-foreground">Không gian làm việc</span>
            </span>
          </Link>
          <div className="ml-auto">
            <UserMenu user={user} />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6 md:py-10">{children}</main>
    </div>
  );
}
