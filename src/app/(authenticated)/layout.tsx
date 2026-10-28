import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { Toaster } from "@/components/patterns/toast";
import { requireActiveUser } from "@/lib/auth/session";
import { displayLogin } from "@/lib/auth/login-identifier";
import { getShopeeFlags } from "@/lib/feature-flags";

// Layouts don't re-render on client-side navigation, so this check is NOT
// what protects pages — the proxy (every request) and each page's own
// requireActiveUser()/requirePermission() are. Here it only supplies the
// signed-in user to the sidebar/header (menu visibility = UX only).
export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requireActiveUser();

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar role={profile.role} shopeeAdsEnabled={getShopeeFlags().adsEnabled} />
        {/* min-w-0: a wide table scrolls inside its own container instead of widening the whole page. */}
        <SidebarInset className="min-w-0">
          <AppHeader
            displayName={profile.full_name || displayLogin(user.email ?? "") || "Người dùng"}
            email={displayLogin(user.email ?? "")}
            role={profile.role}
          />
          <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
    </TooltipProvider>
  );
}
