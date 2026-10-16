// UIUX-1 fallback skeleton for any signed-in page without its own
// loading.tsx — never a blank page while the server renders.
import { PageSkeleton } from "@/components/patterns/skeletons";

export default function AuthenticatedLoading() {
  return <PageSkeleton />;
}
