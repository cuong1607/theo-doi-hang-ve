"use client";

import { useState, useTransition } from "react";
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

import { retryNotificationLog } from "./retry-log-action";

export function RetryLogButton({ logId }: { logId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await retryNotificationLog(logId);
      if (result.status === "error") {
        setError(result.message ?? "Gửi lại thất bại.");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button variant="ghost" size="sm" onClick={handleClick} disabled={isPending}>
        <RotateCw className={isPending ? "animate-spin" : undefined} />
        {isPending ? "Đang gửi lại..." : "Gửi lại"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
