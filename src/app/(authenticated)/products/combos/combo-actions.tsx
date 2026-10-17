"use client";

// Combo detail actions: edit, deactivate / activate (confirmed), delete
// (only when never used on an order — the server re-checks).
import { Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { deleteComboAction, setComboActiveAction } from "./actions";

export function ComboActions({ id, sku, isActive, used }: { id: string; sku: string; isActive: boolean; used: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<"toggle" | "delete" | null>(null);
  const toggle = useAsyncAction({ errorMessage: "Không cập nhật được trạng thái." });
  const remove = useAsyncAction({ errorMessage: "Không xóa được combo." });

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/products/combos/${id}/edit`} />}>
        <Pencil /> Sửa
      </Button>
      <Button variant="outline" size="sm" onClick={() => setConfirm("toggle")}>
        {isActive ? <PowerOff /> : <Power />} {isActive ? "Ngừng hoạt động" : "Kích hoạt"}
      </Button>
      {!used && (
        <Button variant="ghost" size="sm" onClick={() => setConfirm("delete")}>
          <Trash2 /> Xóa
        </Button>
      )}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "delete" ? `Xóa combo ${sku}?` : isActive ? `Ngừng combo ${sku}?` : `Kích hoạt combo ${sku}?`}</DialogTitle>
            <DialogDescription>
              {confirm === "delete"
                ? "Combo chưa có đơn hàng nào nên có thể xóa hẳn. Mapping Shopee tới combo này (nếu có) sẽ bị bỏ ghép."
                : isActive
                  ? "Combo ngừng hoạt động không được tự động ghép SKU nữa. Đơn hàng cũ và mapping hiện có giữ nguyên."
                  : "Combo sẽ được dùng lại cho tự động ghép SKU."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Huỷ
            </Button>
            {confirm === "delete" ? (
              <LoadingButton
                variant="destructive"
                loading={remove.pending}
                loadingText="Đang xóa…"
                onClick={() =>
                  remove.run(async () => {
                    const r = await deleteComboAction(id);
                    if (r.ok) router.push("/products?type=combo");
                    return r;
                  })
                }
              >
                Xóa combo
              </LoadingButton>
            ) : (
              <LoadingButton
                loading={toggle.pending}
                loadingText="Đang lưu…"
                onClick={() =>
                  toggle.run(async () => {
                    const r = await setComboActiveAction(id, !isActive);
                    if (r.ok) setConfirm(null);
                    return r;
                  })
                }
              >
                {isActive ? "Ngừng hoạt động" : "Kích hoạt"}
              </LoadingButton>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
