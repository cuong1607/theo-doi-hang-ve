"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { autoMapShopeeProductsAction, createFixtureShopAction, syncShopeeProductsAction, type ActionResult } from "./actions";

function ResultLine({ result }: { result: ActionResult<unknown> | null }) {
  if (!result) return null;
  return (
    <p className={`flex items-start gap-1.5 text-sm ${result.ok ? "text-primary" : "text-destructive"}`}>
      {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      {result.message}
    </p>
  );
}

export function ShopSyncControls({ shopId, disabled }: { shopId: string; disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);

  const run = (fn: () => Promise<ActionResult<unknown>>) => {
    setResult(null);
    startTransition(async () => setResult(await fn()));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => run(() => syncShopeeProductsAction(shopId, "full"))} disabled={disabled || pending}>
          <RefreshCw className={pending ? "animate-spin" : ""} /> Đồng bộ toàn bộ
        </Button>
        <Button size="sm" variant="outline" onClick={() => run(() => syncShopeeProductsAction(shopId, "incremental"))} disabled={disabled || pending}>
          Đồng bộ thay đổi
        </Button>
        <Button size="sm" variant="outline" onClick={() => run(() => autoMapShopeeProductsAction(shopId))} disabled={pending}>
          <Wand2 /> Tự động ghép SKU
        </Button>
      </div>
      <ResultLine result={result} />
    </div>
  );
}

export function CreateFixtureShopButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => setResult(await createFixtureShopAction()))}>
        Tạo shop fixture (dev)
      </Button>
      <ResultLine result={result} />
    </div>
  );
}
