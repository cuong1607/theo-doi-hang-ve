"use client";

// UIUX-1 ErrorState: friendly message + "Thử lại" + optional reference code
// (Next error digest) for an admin to quote. Never shows a stack, SQL,
// tokens or the raw server message.
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useTransition } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

export function ErrorState({
  title = "Không tải được dữ liệu.",
  description = "Đã có lỗi khi tải trang. Vui lòng thử lại; nếu vẫn lỗi, báo quản trị viên kèm mã tham chiếu.",
  retry,
  reference,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  retry?: () => void;
  /** Opaque id only (error digest) — never an error message. */
  reference?: string | null;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div role="alert" className={cn("flex flex-col items-center gap-2 rounded-xl border border-destructive/20 bg-danger-soft/40 px-4 py-12 text-center", className)}>
      <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-danger-soft">
        <AlertTriangle aria-hidden="true" className="size-5 text-danger-text" />
      </div>
      <p className="font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {retry && (
        <Button className="mt-2" variant="outline" disabled={pending} onClick={() => startTransition(() => retry())}>
          <RotateCcw className={pending ? "animate-spin" : ""} /> {pending ? "Đang thử lại…" : "Thử lại"}
        </Button>
      )}
      {reference && <p className="pt-1 font-mono text-xs text-muted-foreground">Mã tham chiếu: {reference}</p>}
    </div>
  );
}
