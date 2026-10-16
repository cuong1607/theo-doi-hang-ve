"use client";

// Admin repair action (SHOPEE-4 cost engine): rebuilds the moving-average
// ledger from receipts + posted sales. Never rewrites locked order COGS.
// UIUX-1: a confirmation (it can take a while on the whole catalogue),
// loading state, toast with the result.
import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { rebuildAllCostsAction, rebuildProductCostAction } from "./actions";

export function RebuildCostButton({ productId }: { productId?: string }) {
  const [open, setOpen] = useState(false);
  const { run, pending } = useAsyncAction({ errorMessage: "Không dựng lại được sổ giá vốn." });
  const label = productId ? "Dựng lại sổ giá vốn (sửa lỗi)" : "Dựng lại sổ giá vốn toàn bộ (sửa lỗi)";
  return (
    <>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => setOpen(true)} title="Thao tác sửa lỗi (admin) — không cần cho vận hành hằng ngày">
        <RefreshCw className={pending ? "animate-spin" : ""} /> {label}
      </Button>
      <Dialog open={open} onOpenChange={(v) => !pending && setOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label}?</DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">
                Dựng lại sổ giá vốn sẽ tính lại giá vốn hiện tại từ lịch sử nhập hàng. Không tự động thay đổi COGS của đơn hàng lịch sử.
              </span>
              <span className="block text-xs">
                Áp dụng {productId ? "cho sản phẩm này" : "cho toàn bộ sản phẩm"}; hàng từ NCC công ty được cộng VAT theo hóa đơn đã lập. Đơn đang &quot;chờ VAT&quot; sẽ được điền
                COGS nếu nay đã đủ dữ liệu. Muốn điều chỉnh COGS đơn cũ theo sổ mới, dùng &quot;Điều chỉnh COGS đơn lịch sử&quot; (thao tác riêng, có xem trước).
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Hủy
            </Button>
            <LoadingButton
              loading={pending}
              loadingText="Đang dựng lại…"
              onClick={async () => {
                await run(() => (productId ? rebuildProductCostAction(productId) : rebuildAllCostsAction()));
                setOpen(false);
              }}
            >
              Dựng lại
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
