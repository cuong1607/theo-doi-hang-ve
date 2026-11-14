"use client";

// SHOPEE-6: change a return item's disposition (admin). Restock / leaving
// restock moves stock and COGS, so the dialog says what will happen and asks
// for confirmation; the server re-checks everything (permission, cumulative
// quantity, original cost) in one transaction.
import { useState } from "react";

import { Callout } from "@/components/patterns/callout";
import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DISPOSITION_INFO, RETURN_DISPOSITIONS, type ReturnDisposition } from "@/lib/channels/shopee/return-status";

import { setReturnDispositionAction } from "./actions";

const OPTIONS = RETURN_DISPOSITIONS.map((d) => ({ value: d, label: DISPOSITION_INFO[d].label }));

export function DispositionControl({ returnItemId, current, restockable, label }: { returnItemId: string; current: ReturnDisposition; restockable: boolean; label: string }) {
  const [next, setNext] = useState<ReturnDisposition | null>(null);
  const [reason, setReason] = useState("");
  const action = useAsyncAction({ errorMessage: "Không cập nhật được cách xử lý." });
  const inventoryNote =
    next === "restock"
      ? "Sẽ nhập lại kho theo giá vốn GỐC của đơn (combo: theo thành phần đã chụp lúc bán) và hoàn lại giá vốn tương ứng."
      : current === "restock" && next
        ? "Sẽ huỷ lần nhập lại kho trước đó bằng một bút toán xuất bù (cùng số lượng, cùng giá vốn gốc) — lịch sử được giữ nguyên."
        : "Không thay đổi tồn kho hay giá vốn.";

  return (
    <>
      <Select value={current} onValueChange={(v) => v !== current && setNext(v as ReturnDisposition)} items={OPTIONS}>
        <SelectTrigger className="w-full min-w-36 sm:w-40" aria-label={`Cách xử lý ${label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.value === "restock" && !restockable}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Dialog
        open={next !== null}
        onOpenChange={(o) => {
          if (!o) {
            setNext(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {DISPOSITION_INFO[current].label} → {next ? DISPOSITION_INFO[next].label : ""}
            </DialogTitle>
            <DialogDescription>{label}</DialogDescription>
          </DialogHeader>
          <Callout tone={next === "restock" || current === "restock" ? "warning" : "info"}>{inventoryNote}</Callout>
          {next && <p className="text-sm text-muted-foreground">{DISPOSITION_INFO[next].description}</p>}
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Ghi chú (không bắt buộc)</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="VD: kiểm tra thấy rách bao bì" />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNext(null)}>
              Huỷ
            </Button>
            <LoadingButton
              loading={action.pending}
              loadingText="Đang lưu…"
              onClick={() =>
                next &&
                action.run(async () => {
                  const r = await setReturnDispositionAction(returnItemId, next, reason);
                  if (r.ok) {
                    setNext(null);
                    setReason("");
                  }
                  return r;
                })
              }
            >
              Xác nhận
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
