"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { autoMapShopeeProductsAction, createFixtureShopAction, type ActionResult } from "./actions";

function ResultLine({ result }: { result: ActionResult<unknown> | null }) {
  if (!result) return null;
  return (
    <p className={`flex items-start gap-1.5 text-sm ${result.ok ? "text-primary" : "text-destructive"}`}>
      {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      {result.message}
    </p>
  );
}

/** Database-only: exact-SKU auto-mapping of what product sync already stored (no Shopee call). */
export function AutoMapButton({ shopId }: { shopId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  return (
    <div className="space-y-1.5">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        title="Ghép SKU từ dữ liệu đã đồng bộ trong hệ thống — không gọi Shopee"
        onClick={() => {
          setResult(null);
          startTransition(async () => {
            try {
              setResult(await autoMapShopeeProductsAction(shopId));
            } catch {
              // Never let a failed request take the page down.
              setResult({ ok: false, message: "Không gửi được yêu cầu ghép SKU. Vui lòng thử lại." });
            }
          });
        }}
      >
        <Wand2 /> {pending ? "Đang ghép..." : "Tự động ghép SKU"}
      </Button>
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
