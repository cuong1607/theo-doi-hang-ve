"use client";

// UIUX-1 AutoRefresh: while a sync job is active, re-render the server page
// every `intervalMs` (router.refresh in a transition — data stays on screen,
// a small "Đang cập nhật…" shows). Pauses while the tab is hidden; stops by
// itself when the page renders with active=false. Reads the DATABASE only
// (the page), never Shopee.
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "cn";

export function AutoRefresh({ active, intervalMs = 10_000, className }: { active: boolean; intervalMs?: number; className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    };
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);

  if (!active) return null;
  return (
    <span role="status" className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      {pending ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : <RefreshCw aria-hidden="true" className="size-3.5" />}
      {pending ? "Đang cập nhật…" : `Tự làm mới mỗi ${Math.round(intervalMs / 1000)} giây khi đang đồng bộ`}
    </span>
  );
}
