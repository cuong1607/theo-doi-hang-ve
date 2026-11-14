import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/patterns/toast";
import { requireActiveUser } from "@/lib/auth/session";

// APP-SHELL-1: shared frame for every signed-in route — auth session,
// tooltips, toasts. The navigation lives one level down, per app:
//   (hub)        /apps, /forbidden             → HubShell (no sidebar)
//   (accounting) /dashboard, /receipts, …      → AppShell app="accounting"
//   (shopee)     /apps/shopee, /shopee/ads, …  → AppShell app="shopee"
//   (system)     /users, /settings/notifications
//   (purchasing) (creative) (marketing)        → "Sắp có" landings
// Route groups don't change URLs, so every existing link and bookmark works.
//
// Layouts don't re-render on client-side navigation, so this check is NOT
// what protects pages — the proxy (every request) and each page's own
// requireActiveUser()/requirePermission() are.
export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireActiveUser();

  return (
    <TooltipProvider>
      {children}
      <Toaster />
    </TooltipProvider>
  );
}
