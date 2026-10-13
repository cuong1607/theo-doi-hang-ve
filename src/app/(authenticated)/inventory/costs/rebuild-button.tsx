"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

import { rebuildAllCostsAction, rebuildProductCostAction, type CostActionResult } from "./actions";

export function RebuildCostButton({ productId }: { productId?: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CostActionResult | null>(null);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => startTransition(async () => setResult(productId ? await rebuildProductCostAction(productId) : await rebuildAllCostsAction()))}
      >
        <RefreshCw className={pending ? "animate-spin" : ""} /> {productId ? "Tính lại giá vốn" : "Tính lại giá vốn toàn bộ"}
      </Button>
      {result && <p className={`text-sm ${result.ok ? "text-primary" : "text-destructive"}`}>{result.message}</p>}
    </div>
  );
}
