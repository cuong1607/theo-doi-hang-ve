"use client";

// SHOPEE-7: admin note / resolution of a payout. The numbers are never
// edited — closing a mismatch keeps the original difference.
import { useState } from "react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RESOLUTION_INFO } from "@/lib/channels/core/payout-display";
import { PAYOUT_RESOLUTION_STATUSES, type PayoutResolutionStatus } from "@/lib/channels/core/payouts";

import { addPayoutNoteAction } from "../actions";

const KEEP = "keep";
const OPTIONS = [{ value: KEEP, label: "Giữ trạng thái hiện tại" }, ...PAYOUT_RESOLUTION_STATUSES.map((s) => ({ value: s, label: RESOLUTION_INFO[s].label }))];

export function PayoutNoteForm({ payoutId, current }: { payoutId: string; current: PayoutResolutionStatus }) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string>(KEEP);
  const [reason, setReason] = useState("");
  const action = useAsyncAction({ refresh: true, errorMessage: "Không lưu được ghi chú." });
  const closing = status === "resolved" || status === "accepted";

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const r = await addPayoutNoteAction({
            payoutId,
            note,
            resolutionStatus: status === KEEP || status === current ? null : (status as PayoutResolutionStatus),
            resolutionReason: closing ? reason : null,
          });
          if (r.ok) {
            setNote("");
            setReason("");
            setStatus(KEEP);
          }
          return r;
        });
      }}
    >
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Ghi chú điều tra</span>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="VD: đã hỏi Shopee, khoản lệch là phí dịch vụ tháng 10" required />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Trạng thái xử lý</span>
          <Select value={status} onValueChange={(v) => setStatus(String(v))} items={OPTIONS}>
            <SelectTrigger className="w-full" aria-label="Trạng thái xử lý">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {closing && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Lý do (bắt buộc)</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="VD: phí ngoài hệ thống, Shopee xác nhận" required />
          </label>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Ghi chú không thay đổi số tiền Shopee báo hay số chênh lệch — chênh lệch gốc luôn được giữ lại.</p>
      <LoadingButton type="submit" size="sm" loading={action.pending} loadingText="Đang lưu…" disabled={!note.trim() || (closing && !reason.trim())}>
        Lưu ghi chú
      </LoadingButton>
    </form>
  );
}
