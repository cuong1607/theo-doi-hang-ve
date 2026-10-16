"use client";

// UIUX-1: instant feedback for a clicked <Link> while the next route is
// still on its way (slow network, not yet prefetched) — otherwise the old
// page just sits there and the app feels frozen. Must be rendered INSIDE a
// <Link>. Fixed size, only opacity changes (no layout shift).
import { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "cn";

export function LinkPendingHint({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  return (
    <span aria-hidden="true" className={cn("ml-auto inline-flex size-3.5 shrink-0 items-center justify-center transition-opacity duration-150", pending ? "opacity-100" : "opacity-0", className)}>
      <Loader2 className={cn("size-3.5", pending && "animate-spin")} />
      {pending && <span className="sr-only">Đang mở trang…</span>}
    </span>
  );
}
