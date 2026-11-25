// APP-SHELL-1: the domain app shell (server). Each route group's layout is
// `<AppShell app="…">`. It resolves the user once (React-cached, shared with
// the pages), refuses apps the role may not enter, and hands the sidebar the
// app's nav already filtered by role + flags.
//
// Like every layout, this is NOT what protects pages (layouts don't re-run on
// client navigation inside the group): the proxy and each page's own
// requirePermission() are. Shop scope is untouched — entering the Shopee app
// grants nothing beyond what each page already checks.
import { redirect } from "next/navigation";

import { systemAssistantAvailable } from "@/lib/ai-system/server";
import { tasksEnabled } from "@/lib/ai-tasks/server";
import { visibleNav } from "@/lib/apps/nav";
import { canAccessApp, hubApps, type AppId } from "@/lib/apps/registry";
import { displayLogin } from "@/lib/auth/login-identifier";
import { requireActiveUser } from "@/lib/auth/session";
import { getShopeeFlags } from "@/lib/feature-flags";
import { webAssistantAvailable } from "@/lib/product-analyst/access";
import { zaloAppVisible } from "@/lib/zalo-personal/dashboard/server";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

import { DomainSidebar } from "./domain-sidebar";
import { ShellHeader } from "./shell-header";
import type { ShellUser } from "./user-menu";

export async function shellUser(): Promise<ShellUser> {
  const { user, profile } = await requireActiveUser();
  return { displayName: profile.full_name || displayLogin(user.email ?? "") || "Người dùng", email: displayLogin(user.email ?? ""), role: profile.role };
}

/**
 * Data-dependent app access, computed on the server (React-cached per request).
 * Zalo Personal: shown only with its flag on AND a connection owned or a grant held;
 * no query at all for roles without the permission, or with the flag off.
 */
export async function appDataGates(): Promise<Partial<Record<AppId, boolean>>> {
  const { user, profile } = await requireActiveUser();
  return { zalo: await zaloAppVisible(user.id, profile.role) };
}

export async function AppShell({ app: appId, children }: { app: AppId; children: React.ReactNode }) {
  const user = await shellUser();
  if (!canAccessApp(user.role, appId)) redirect("/forbidden");
  const gates = await appDataGates();
  if (gates[appId] === false) redirect("/forbidden");
  const flags = getShopeeFlags();
  const apps = hubApps(user.role, gates);
  const app = apps.find((a) => a.id === appId)!;
  const groups = visibleNav(appId, { role: user.role, adsEnabled: flags.adsEnabled, legacyModulesEnabled: flags.legacyModulesEnabled, aiWebEnabled: webAssistantAvailable(user.role), aiSystemEnabled: systemAssistantAvailable(user.role), aiTasksEnabled: tasksEnabled() });

  return (
    <div data-app={app.accent} data-app-shell={appId} className="contents">
      <SidebarProvider>
        {/* No Suspense here: the shell is always dynamic (session), and a separately hydrated
            boundary made the mobile sidebar (useIsMobile → Sheet) mismatch the server HTML. */}
        <DomainSidebar app={app} apps={apps} groups={groups} />
        {/* min-w-0: a wide table scrolls inside its own container instead of widening the whole page. */}
        <SidebarInset className="min-w-0">
          <ShellHeader app={app} groups={groups} user={user} />
          <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
