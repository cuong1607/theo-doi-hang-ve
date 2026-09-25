"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";

type Result = { success: true; message: string } | { success: false; errorMessage: string };

// Client-side: only ever calls the server route via fetch — never imports
// anything from src/lib/zalo/* directly (that module touches secrets/tokens
// and must stay server-only).
export function SendTestMessageButton({ disabled }: { disabled?: boolean }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function handleClick() {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/zalo/test-message", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setResult({ success: true, message: data.message ?? "Đã gửi tin nhắn test" });
      } else {
        setResult({ success: false, errorMessage: data.errorMessage ?? "Gửi tin nhắn thử thất bại." });
      }
    } catch {
      setResult({ success: false, errorMessage: "Không thể gọi API gửi tin nhắn thử." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={handleClick} disabled={disabled || pending}>
        {pending ? "Đang gửi..." : "Gửi tin nhắn thử"}
      </Button>
      {result && (
        <p
          className={`flex items-center gap-1.5 text-sm ${result.success ? "text-primary" : "text-destructive"}`}
        >
          {result.success ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
          {result.success ? result.message : result.errorMessage}
        </p>
      )}
    </div>
  );
}
