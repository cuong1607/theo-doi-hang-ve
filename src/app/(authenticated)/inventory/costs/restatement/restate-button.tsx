"use client";

// Historical COGS restatement — the explicit admin step after a cost rebuild.
// The dry-run table (server) shows old / new / difference; this button asks
// for a reason, confirms, then restates exactly the restatable lines shown.
import { useState } from "react";
import { History } from "lucide-react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { restateHistoricalCogsAction } from "../actions";

export function RestateCogsButton({ itemIds, lines, orders, difference }: { itemIds: string[]; lines: number; orders: number; difference: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("Giá vốn nhập hàng công ty cộng VAT đầu vào theo hóa đơn NCC");
  const { run, pending } = useAsyncAction({ errorMessage: "Không điều chỉnh được COGS." });
  const tooShort = reason.trim().length < 5;
  return (
    <>
      <Button size="sm" disabled={itemIds.length === 0 || pending} onClick={() => setOpen(true)}>
        <History /> Điều chỉnh COGS {lines} dòng
      </Button>
      <Dialog open={open} onOpenChange={(v) => !pending && setOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Điều chỉnh COGS của đơn lịch sử?</DialogTitle>
            <DialogDescription>
              {lines} dòng của {orders} đơn sẽ đổi COGS theo sổ giá vốn hiện tại (chênh lệch tổng {difference}). Lợi nhuận dự kiến và lợi nhuận thực tế của các đơn này được tính
              lại. Giá trị cũ, giá trị mới, lý do, người thực hiện và phiên bản tính được lưu lại để đối chiếu.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Lý do điều chỉnh</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-invalid={tooShort} />
            {tooShort && <span className="text-xs text-danger-text">Lý do cần ít nhất 5 ký tự.</span>}
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Hủy
            </Button>
            <LoadingButton
              loading={pending}
              loadingText="Đang điều chỉnh…"
              disabled={tooShort}
              onClick={async () => {
                await run(() => restateHistoricalCogsAction({ itemIds, reason }));
                setOpen(false);
              }}
            >
              Xác nhận điều chỉnh
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
