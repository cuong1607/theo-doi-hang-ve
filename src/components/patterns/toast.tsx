"use client";

// UIUX-1 toasts: tiny, dependency-free. <Toaster/> is mounted once in the
// authenticated layout; anywhere in client code: toast.success("…").
// Polite live region (errors assertive), icon + text per tone, slide/fade in.
import { useSyncExternalStore } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "cn";

import { createToastStore, type ToastItem, type ToastTone } from "@/lib/ui/toast-store";

const store = createToastStore();
const EMPTY: ToastItem[] = [];

export const toast = {
  success: (message: string, description?: string) => store.add("success", message, description),
  error: (message: string, description?: string) => store.add("error", message, description),
  warning: (message: string, description?: string) => store.add("warning", message, description),
  info: (message: string, description?: string) => store.add("info", message, description),
  dismiss: (id: number) => store.dismiss(id),
};

const ICON: Record<ToastTone, LucideIcon> = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info };
const ICON_CLASS: Record<ToastTone, string> = { success: "text-success", error: "text-destructive", warning: "text-warning", info: "text-info" };

export function Toaster() {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY);
  const hasError = items.some((t) => t.tone === "error");
  return (
    <div
      aria-live={hasError ? "assertive" : "polite"}
      aria-relevant="additions"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
    >
      {items.map((t) => {
        const Icon = ICON[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            data-tone={t.tone}
            className="pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-2.5 rounded-lg border bg-popover px-3.5 py-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/5"
          >
            <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", ICON_CLASS[t.tone])} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.message}</p>
              {t.description && <p className="mt-0.5 text-muted-foreground">{t.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => store.dismiss(t.id)}
              aria-label="Đóng thông báo"
              className="-m-1 rounded p-1 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
