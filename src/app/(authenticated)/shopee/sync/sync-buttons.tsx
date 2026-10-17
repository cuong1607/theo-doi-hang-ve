"use client";

// Sync buttons. Each one only enqueues (the server action answers
// immediately) — no button ever waits for Shopee. UIUX-1: idle → "Đang gửi
// yêu cầu…" (spinner, disabled, no double submit) → toast; the server
// action's revalidatePath re-renders the status cells.
import { History, RefreshCw, RotateCcw, XCircle } from "lucide-react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";

import { cancelSyncJobAction, requestBackfillAction, requestSyncNowAction, retrySyncJobAction } from "./actions";

export function SyncNowButton({ shopId, syncType, label = "Đồng bộ ngay", disabled, variant = "default" }: { shopId: string; syncType: "order" | "product" | "escrow" | "return" | "income" | "payout"; label?: string; disabled?: boolean; variant?: "default" | "outline" }) {
  const { run, pending } = useAsyncAction({ errorMessage: "Không gửi được yêu cầu đồng bộ. Vui lòng thử lại." });
  return (
    <LoadingButton
      size="sm"
      variant={variant}
      loading={pending}
      loadingText="Đang gửi yêu cầu…"
      icon={<RefreshCw />}
      disabled={disabled}
      title={disabled ? "Shop này chưa đồng bộ được ở chế độ hiện tại" : undefined}
      onClick={() => run(() => requestSyncNowAction(shopId, syncType))}
    >
      {label}
    </LoadingButton>
  );
}

export function BackfillButton({ shopId, syncType, days = 30, label, disabled }: { shopId: string; syncType: "order" | "product"; days?: number; label: string; disabled?: boolean }) {
  const { run, pending } = useAsyncAction({ errorMessage: "Không tạo được job backfill. Vui lòng thử lại." });
  return (
    <LoadingButton size="sm" variant="outline" loading={pending} loadingText="Đang gửi yêu cầu…" icon={<History />} disabled={disabled} onClick={() => run(() => requestBackfillAction(shopId, syncType, days))}>
      {label}
    </LoadingButton>
  );
}

export function JobActionButtons({ jobId, canRetry, canCancel }: { jobId: string; canRetry: boolean; canCancel: boolean }) {
  const retry = useAsyncAction({ errorMessage: "Không thử lại được job." });
  const cancel = useAsyncAction({ errorMessage: "Không hủy được job." });
  if (!canRetry && !canCancel) return null;
  return (
    <div className="flex justify-end gap-1">
      {canRetry && (
        <LoadingButton size="sm" variant="outline" loading={retry.pending} loadingText="Đang gửi…" icon={<RotateCcw />} disabled={cancel.pending} onClick={() => retry.run(() => retrySyncJobAction(jobId))}>
          Thử lại
        </LoadingButton>
      )}
      {canCancel && (
        <LoadingButton size="sm" variant="ghost" loading={cancel.pending} loadingText="Đang hủy…" icon={<XCircle />} disabled={retry.pending} onClick={() => cancel.run(() => cancelSyncJobAction(jobId))}>
          Hủy
        </LoadingButton>
      )}
    </div>
  );
}
