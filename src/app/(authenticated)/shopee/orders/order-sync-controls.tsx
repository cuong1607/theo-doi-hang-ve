"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { backfillOrderCogsAction, type OrderActionResult } from "./actions";

/** Database-only (no Shopee call): computes COGS for orders still missing it. */
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
