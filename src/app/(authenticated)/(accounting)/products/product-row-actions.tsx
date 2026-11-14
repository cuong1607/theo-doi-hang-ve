"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal, Pencil, Power, PowerOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { setProductActive } from "./actions";
import { ProductFormDialog, type ProductRecord, type SupplierOption } from "./product-form-dialog";

type Product = ProductRecord & { is_active: boolean };

export function ProductRowActions({
  product,
  suppliers,
}: {
  product: Product;
  suppliers: SupplierOption[];
}) {
  const [editOpen, setEditOpen] = useState(false);
  // Bumped on every open so ProductFormDialog remounts with fresh action
  // state, instead of reusing a stale "success" from a previous submit.
  const [editKey, setEditKey] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggleActive() {
    setError(null);
    startTransition(async () => {
      const result = await setProductActive(product.id, !product.is_active);
      if (result.status === "error") {
        setError(result.message ?? "Không thể cập nhật trạng thái.");
        return;
      }
      setConfirmOpen(false);
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
          <MoreHorizontal />
          <span className="sr-only">Thao tác</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setEditKey((k) => k + 1);
              setEditOpen(true);
            }}
          >
            <Pencil /> Sửa
          </DropdownMenuItem>
          <DropdownMenuItem
            variant={product.is_active ? "destructive" : "default"}
            onClick={() => setConfirmOpen(true)}
          >
            {product.is_active ? <PowerOff /> : <Power />}
            {product.is_active ? "Ngừng hoạt động" : "Kích hoạt lại"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProductFormDialog
        key={editKey}
        open={editOpen}
        onOpenChange={setEditOpen}
        product={product}
        suppliers={suppliers}
      />

      <Dialog
        open={confirmOpen}
        onOpenChange={(next) => {
          setConfirmOpen(next);
          if (!next) setError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {product.is_active ? "Ngừng hoạt động sản phẩm?" : "Kích hoạt lại sản phẩm?"}
            </DialogTitle>
            <DialogDescription>
              {product.is_active
                ? `Sản phẩm "${product.name}" sẽ bị ẩn khi tạo phiếu nhập/hóa đơn mới. Dữ liệu cũ vẫn được giữ nguyên.`
                : `Sản phẩm "${product.name}" sẽ hoạt động trở lại.`}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={isPending}
            >
              Hủy
            </Button>
            <Button
              type="button"
              variant={product.is_active ? "destructive" : "default"}
              onClick={handleToggleActive}
              disabled={isPending}
            >
              {isPending ? "Đang xử lý..." : "Xác nhận"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
