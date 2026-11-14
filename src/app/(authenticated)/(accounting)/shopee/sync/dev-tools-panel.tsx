"use client";

// LOCAL-LIVE-1 §9: developer panel. Rendered by the page ONLY when
// devToolsEnabled() — the server actions re-check it anyway.
import { Play, Search, Timer, Wrench, Zap } from "lucide-react";
import { useState } from "react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { devDiagnoseQueueAction, devEnqueueAction, devRunCycleAction, devRunSchedulerTickAction, devRunWorkerOnceAction, type DevActionResult } from "./dev-actions";

const SYNC_TYPES = [
  { type: "order", label: "đơn" },
  { type: "product", label: "sản phẩm" },
  { type: "escrow", label: "tài chính" },
  { type: "return", label: "trả hàng" },
  { type: "income", label: "giải ngân" },
  { type: "payout", label: "payout" },
] as const;

export function DevToolsPanel({ shops }: { shops: Array<{ id: string; name: string }> }) {
  const { run, pending } = useAsyncAction({ errorMessage: "Công cụ dev lỗi." });
  const [active, setActive] = useState<string | null>(null);
  const [last, setLast] = useState<DevActionResult | null>(null);

  const exec = (key: string, fn: () => Promise<DevActionResult>) => {
    setActive(key);
    void run(async () => {
      const r = await fn();
      setLast(r);
      return r;
    }).finally(() => setActive(null));
  };
  const button = (key: string, label: string, icon: React.ReactNode, fn: () => Promise<DevActionResult>) => (
    <LoadingButton key={key} size="sm" variant="outline" loading={pending && active === key} loadingText="Đang chạy…" icon={icon} disabled={pending && active !== key} onClick={() => exec(key, fn)}>
      {label}
    </LoadingButton>
  );

  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench aria-hidden="true" className="size-4" /> Công cụ dev (chỉ local)
        </CardTitle>
        <CardDescription>Chạy từng bước của pipeline bằng tay. Không hiển thị trên production.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {button("tick", "Chạy scheduler 1 lần (chỉ tick)", <Timer />, devRunSchedulerTickAction)}
          {button("worker", "Chạy worker 1 lượt", <Play />, devRunWorkerOnceAction)}
          {button("cycle", "Chạy 1 chu kỳ đầy đủ (tick + worker)", <Zap />, devRunCycleAction)}
          {button("diagnose", "Chẩn đoán hàng đợi", <Search />, devDiagnoseQueueAction)}
        </div>
        {shops.map((shop) => (
          <div key={shop.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Tạo job (không chạy) cho {shop.name}:</span>
            {SYNC_TYPES.map((t) => button(`enqueue-${shop.id}-${t.type}`, t.label, null, () => devEnqueueAction(shop.id, t.type)))}
          </div>
        ))}
        {last?.detail !== undefined && (
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{JSON.stringify(last.detail, null, 2)}</pre>
        )}
      </CardContent>
    </Card>
  );
}
