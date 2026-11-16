// PRODUCT-ANALYTICS-4: assistant skeleton (header, context bar, thread, composer).
import { Skeleton } from "@/components/ui/skeleton";

export default function ShopeeAssistantLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4" aria-busy="true">
      <div className="flex items-center gap-3">
        <Skeleton className="size-8 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
      </div>
      <Skeleton className="h-14 rounded-2xl" />
      <Skeleton className="h-[50svh] rounded-2xl" />
      <Skeleton className="h-14 rounded-2xl" />
    </div>
  );
}
