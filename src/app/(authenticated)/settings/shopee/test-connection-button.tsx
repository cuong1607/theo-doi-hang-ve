"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";

type ApiResult = {
  ok: boolean;
  requestId?: string | null;
  latencyMs?: number;
  shopName?: string | null;
  error?: { code: string; message: string };
};

// Calls the server route only — never imports src/lib/channels/shopee/*
// (tokens and partner credentials stay server-side).
export function TestConnectionButton({ shopId, disabled }: { shopId: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleClick() {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/shopee/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId }),
      });
      const data = (await res.json()) as { result?: ApiResult; errorMessage?: string };
      const result = data.result;
      if (result?.ok) {
        setMessage({
          ok: true,
          text: `Kết nối OK${result.shopName ? ` (${result.shopName})` : ""} · ${result.latencyMs ?? "?"}ms · request_id: ${result.requestId ?? "—"}`,
        });
      } else if (result?.error) {
        setMessage({
          ok: false,
          text: `[${result.error.code}] ${result.error.message}${result.requestId ? ` · request_id: ${result.requestId}` : ""}`,
        });
      } else {
        setMessage({ ok: false, text: data.errorMessage ?? "Kiểm tra kết nối thất bại." });
      }
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "Không gọi được API kiểm tra kết nối." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={handleClick} disabled={disabled || pending}>
        {pending ? "Đang kiểm tra..." : "Kiểm tra kết nối"}
      </Button>
      {message ? (
        <p className={`flex items-center gap-1.5 text-sm ${message.ok ? "text-primary" : "text-destructive"}`}>
          {message.ok ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
