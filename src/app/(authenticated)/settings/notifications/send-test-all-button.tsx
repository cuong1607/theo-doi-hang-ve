"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";

type RecipientResult = {
  recipientId: string;
  recipientName: string;
  status: "sent" | "failed" | "skipped";
  errorCode?: string;
};

type Result =
  | {
      success: true;
      totalRecipients: number;
      sentCount: number;
      failedCount: number;
      skippedCount: number;
      results: RecipientResult[];
    }
  | { success: false; errorMessage: string };

// Client-side: only ever calls the server route via fetch — never imports
// src/lib/notifications/* (server-only) or src/lib/zalo/* directly.
export function SendTestAllButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  async function handleClick() {
    setPending(true);
    setResult(null);
    setShowDetail(false);
    try {
      const res = await fetch("/api/notifications/test-all", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setResult(data);
      } else {
        setResult({ success: false, errorMessage: data.errorMessage ?? "Gửi thông báo thử thất bại." });
      }
    } catch {
      setResult({ success: false, errorMessage: "Không thể gọi API gửi thông báo thử." });
    } finally {
      setPending(false);
      // Refresh so "Lịch sử gửi gần đây" (server-rendered) reflects the new log rows.
      router.refresh();
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={handleClick} disabled={disabled || pending}>
        {pending ? "Đang gửi..." : "Gửi tin thử cho tất cả"}
      </Button>

      {result && !result.success && (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertTriangle className="size-4" />
          {result.errorMessage}
        </p>
      )}

      {result && result.success && (
        <div className="space-y-1.5 text-sm">
          {result.totalRecipients === 0 ? (
            <p className="text-muted-foreground">Chưa có người nhận nào đang hoạt động.</p>
          ) : (
            <>
              <p className="flex items-center gap-1.5">
                <CheckCircle2 className="size-4 text-primary" />
                Đã gửi: {result.sentCount} thành công
                {result.failedCount > 0 && `, ${result.failedCount} thất bại`}
                {result.skippedCount > 0 && `, ${result.skippedCount} bỏ qua`}
              </p>
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                onClick={() => setShowDetail((v) => !v)}
              >
                <ChevronDown className={`size-3 transition-transform ${showDetail ? "rotate-180" : ""}`} />
                {showDetail ? "Ẩn chi tiết" : "Xem chi tiết từng người"}
              </button>
              {showDetail && (
                <ul className="space-y-1 rounded-md border p-2">
                  {result.results.map((r) => (
                    <li key={r.recipientId} className="flex items-center justify-between gap-2 text-xs">
                      <span>{r.recipientName}</span>
                      <span
                        className={
                          r.status === "sent"
                            ? "text-primary"
                            : r.status === "skipped"
                              ? "text-muted-foreground"
                              : "text-destructive"
                        }
                      >
                        {r.status === "sent" ? "Thành công" : r.status === "skipped" ? "Bỏ qua" : `Lỗi${r.errorCode ? ` (${r.errorCode})` : ""}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
