"use client";

// SHOPEE-PERF-1 sync buttons. Each one only enqueues (the server action
// answers immediately) — no button ever waits for Shopee.
import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, History, RefreshCw, RotateCcw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

import { cancelSyncJobAction, requestBackfillAction, requestSyncNowAction, retrySyncJobAction, type SyncActionResult } from "./actions";

function ResultLine({ result }: { result: SyncActionResult | null }) {
  if (!result) return null;
  return (
    <p className={`flex items-start gap-1.5 text-sm ${result.ok ? "text-primary" : "text-destructive"}`}>
      {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      {result.message}
    </p>
  );
}

function useAction() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SyncActionResult | null>(null);
  const run = (fn: () => Promise<SyncActionResult>) => {
    setResult(null);
    startTransition(async () => setResult(await fn()));
  };
  return { pending, result, run };
}

export function SyncNowButton({ shopId, syncType, label = "Đồng bộ ngay", disabled }: { shopId: string; syncType: "order" | "product"; label?: string; disabled?: boolean }) {
  const { pending, result, run } = useAction();
  return (
    <div className="space-y-1.5">
      <Button size="sm" onClick={() => run(() => requestSyncNowAction(shopId, syncType))} disabled={disabled || pending}>
        <RefreshCw className={pending ? "animate-spin" : ""} /> {label}
      </Button>
      <ResultLine result={result} />
    </div>
  );
}

export function BackfillButton({ shopId, syncType, days = 30, label, disabled }: { shopId: string; syncType: "order" | "product"; days?: number; label: string; disabled?: boolean }) {
  const { pending, result, run } = useAction();
  return (
    <div className="space-y-1.5">
      <Button size="sm" variant="outline" onClick={() => run(() => requestBackfillAction(shopId, syncType, days))} disabled={disabled || pending}>
        <History /> {label}
      </Button>
      <ResultLine result={result} />
    </div>
  );
}

export function JobActionButtons({ jobId, canRetry, canCancel }: { jobId: string; canRetry: boolean; canCancel: boolean }) {
  const { pending, result, run } = useAction();
  if (!canRetry && !canCancel) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        {canRetry && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => retrySyncJobAction(jobId))}>
            <RotateCcw /> Thử lại
          </Button>
        )}
        {canCancel && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => cancelSyncJobAction(jobId))}>
            <XCircle /> Hủy
          </Button>
        )}
      </div>
      <ResultLine result={result} />
    </div>
  );
}
