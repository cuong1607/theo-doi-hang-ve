"use client";

// SHOPEE-ADS-UI-1: "Làm mới dữ liệu" + sync status, sharing one state.
// No Ads API yet → the refresh is SIMULATED: short wait, then a server
// re-render (router.refresh in a transition) — the old dashboard stays on
// screen the whole time (dimmed slightly), never blanked. Success → toast
// + brief check mark; "Cập nhật … trước" restarts from now.
import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, CircleDashed, Clock, Database, RefreshCw } from "lucide-react";
import { cn } from "cn";

import type { AdsSyncStatus as AdsSyncStatusVM } from "@/lib/channels/shopee/ads/view-models";
import { toast } from "@/components/patterns/toast";
import { Button } from "@/components/ui/button";

type Phase = "idle" | "refreshing" | "success";

interface RefreshState {
  phase: Phase;
  refresh: () => void;
  /** Client-side "last refreshed" (ms) — overrides the server time after a refresh. */
  refreshedAt: number | null;
}

const RefreshContext = createContext<RefreshState | null>(null);

/** Simulated provider latency (fixture only). */
const FIXTURE_REFRESH_MS = 900;

export function AdsRefreshProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [success, setSuccess] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(false), 1800);
    return () => clearTimeout(t);
  }, [success]);

  const refresh = () => {
    if (pending) return;
    setSuccess(false);
    startTransition(async () => {
      await new Promise((r) => setTimeout(r, FIXTURE_REFRESH_MS));
      router.refresh();
      startTransition(() => {
        setRefreshedAt(Date.now());
        setSuccess(true);
      });
      toast.success("Đã làm mới dữ liệu quảng cáo", "Đang hiển thị dữ liệu mẫu — chưa kết nối Ads API.");
    });
  };

  const phase: Phase = pending ? "refreshing" : success ? "success" : "idle";
  return (
    <RefreshContext.Provider value={{ phase, refresh, refreshedAt }}>
      <div data-refresh-phase={phase} className={cn("transition-opacity duration-(--ads-dur-normal)", phase === "refreshing" && "[&_[data-refresh-dim]]:opacity-70")}>
        {children}
      </div>
    </RefreshContext.Provider>
  );
}

function useRefresh(): RefreshState {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used inside <AdsRefreshProvider>");
  return ctx;
}

export function AdsRefreshButton({ className }: { className?: string }) {
  const { phase, refresh } = useRefresh();
  const Icon = phase === "success" ? Check : RefreshCw;
  return (
    <Button
      type="button"
      onClick={refresh}
      disabled={phase === "refreshing"}
      aria-busy={phase === "refreshing"}
      data-phase={phase}
      className={cn(
        "ads-gradient-primary border-0 text-white shadow-sm shadow-ads-primary/30 transition-[transform,box-shadow,filter] duration-(--ads-dur-fast) ease-ads hover:-translate-y-px hover:shadow-md hover:brightness-105 active:scale-[0.97] disabled:opacity-90",
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn(phase === "refreshing" && "animate-spin", phase === "success" && "animate-ads-pop")} />
      {phase === "refreshing" ? "Đang làm mới…" : phase === "success" ? "Đã cập nhật" : "Làm mới dữ liệu"}
    </Button>
  );
}

function minutesAgo(fromMs: number, nowMs: number): string {
  const m = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  if (m < 1) return "vừa xong";
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} giờ trước` : `${Math.floor(h / 24)} ngày trước`;
}

const STATE_VIEW = {
  fresh: { icon: Clock, cls: "border-success/30 bg-success-soft text-success-text" },
  refreshing: { icon: RefreshCw, cls: "border-info/30 bg-info-soft text-info-text" },
  never: { icon: CircleDashed, cls: "border-border bg-muted text-muted-foreground" },
  error: { icon: AlertTriangle, cls: "border-destructive/25 bg-danger-soft text-danger-text" },
} as const;

/**
 * "Cập nhật 3 phút trước" / "Chưa đồng bộ Ads" / "Đang làm mới" /
 * "Không tải được dữ liệu". `serverNow` = render time, so the first client
 * render matches the server HTML; the label then ticks every 30 s.
 */
export function AdsSyncStatus({ sync, serverNow, compact = false, className }: { sync: AdsSyncStatusVM; serverNow: string; compact?: boolean; className?: string }) {
  const { phase, refreshedAt } = useRefresh();
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const state = phase === "refreshing" ? "refreshing" : sync.state === "refreshing" ? "refreshing" : sync.state;
  const last = refreshedAt ?? (sync.lastSyncedAt ? Date.parse(sync.lastSyncedAt) : null);
  const label =
    state === "refreshing" ? "Đang làm mới" : state === "error" ? "Không tải được dữ liệu" : state === "never" || last === null ? "Chưa đồng bộ Ads" : `Cập nhật ${minutesAgo(last, Math.max(now, last))}`;
  const view = STATE_VIEW[state === "fresh" && last === null ? "never" : state];
  const Icon = view.icon;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2 text-xs", className)} data-sync-state={state}>
      <span role="status" className={cn("inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 font-medium transition-colors duration-(--ads-dur-normal)", view.cls)}>
        <Icon aria-hidden="true" className={cn("size-3.5", state === "refreshing" && "animate-spin")} />
        {label}
      </span>
      {!compact && sync.source === "fixture" && (
        <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-dashed border-ads-border bg-ads-surface px-2.5 text-ads-muted">
          <Database aria-hidden="true" className="size-3.5" /> Dữ liệu mẫu
        </span>
      )}
    </span>
  );
}
