// UIUX-1 fallback skeleton for any signed-in page without its own
// loading.tsx — never a blank page while the server renders.
// APP-SHELL-1: this boundary only shows while a whole app shell is on its way
// (hub → app, app → app), so it is shaped like a shell: sidebar, top bar, page.
// Inside an app, each route group's own loading.tsx keeps the real shell.
import { PageSkeleton } from "@/components/patterns/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function AuthenticatedLoading() {
  return (
    <div className="flex min-h-svh w-full" aria-busy="true">
      <div aria-hidden="true" className="hidden w-64 shrink-0 space-y-3 border-r bg-sidebar p-3 md:block">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-5/6" />
      </div>
      <div className="min-w-0 flex-1">
        <div aria-hidden="true" className="flex h-14 items-center gap-3 border-b px-4">
          <Skeleton className="size-7" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="p-4 md:p-6">
          <PageSkeleton />
        </div>
      </div>
    </div>
  );
}
