import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { requireActiveUser } from "@/lib/auth/session";

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
        <AppSidebar role={profile.role} />
        <SidebarInset>
          <AppHeader
            displayName={profile.full_name || user.email || "Người dùng"}
            email={user.email ?? ""}
            role={profile.role}
          />
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
