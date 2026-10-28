"use client";

// SHOPEE-ADS-UI-1: friendly error card with [Thử lại] (server re-render) —
// never the raw provider error. Client component: it needs the router.
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CloudOff, RotateCcw } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

export function AdsErrorState({ title = "Không tải được dữ liệu quảng cáo.", description = "Có thể kết nối đang gián đoạn. Dữ liệu cũ không bị mất — hãy thử lại sau ít phút.", className }: { title?: string; description?: string; className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div role="alert" data-slot="ads-error-state" className={cn("animate-ads-pop flex flex-col items-center gap-2 rounded-2xl border border-destructive/20 bg-danger-soft/40 px-4 py-12 text-center", className)}>
      <div className="mb-1 flex size-12 items-center justify-center rounded-2xl bg-danger-soft">
        <CloudOff aria-hidden="true" className="size-5 text-danger-text" />
      </div>
      <p className="font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      <Button className="mt-2 rounded-full active:scale-[0.97]" variant="outline" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        <RotateCcw aria-hidden="true" className={pending ? "animate-spin" : ""} /> {pending ? "Đang thử lại…" : "Thử lại"}
      </Button>
    </div>
  );
}
