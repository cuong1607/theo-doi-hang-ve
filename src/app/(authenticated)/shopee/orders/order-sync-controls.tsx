"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

import { backfillOrderCogsAction, syncShopeeOrdersAction, type OrderActionResult } from "./actions";

export function BackfillCogsButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<OrderActionResult | null>(null);
  return (
    <div className="space-y-2 border-t pt-4">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => setResult(await backfillOrderCogsAction()))}>
        {pending ? "Đang tính..." : "Tính COGS còn thiếu"}
      </Button>
      {result && <p className={`text-sm ${result.ok ? "text-primary" : "text-destructive"}`}>{result.message}</p>}
    </div>
  );
}

export function OrderSyncControls({ shopId, disabled }: { shopId: string; disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<OrderActionResult | null>(null);
  const run = (mode: "incremental" | "backfill") => {
    setResult(null);
    startTransition(async () => setResult(await syncShopeeOrdersAction(shopId, mode)));
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => run("incremental")} disabled={disabled || pending}>
          <RefreshCw className={pending ? "animate-spin" : ""} /> Đồng bộ đơn mới
        </Button>
        <Button size="sm" variant="outline" onClick={() => run("backfill")} disabled={disabled || pending}>
          Backfill 30 ngày
        </Button>
      </div>
      {result && (
        <p className={`flex items-start gap-1.5 text-sm ${result.ok ? "text-primary" : "text-destructive"}`}>
          {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
          {result.message}
        </p>
      )}
    </div>
  );
}
