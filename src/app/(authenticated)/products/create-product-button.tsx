"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { ProductFormDialog, type SupplierOption } from "./product-form-dialog";

export function CreateProductButton({ suppliers }: { suppliers: SupplierOption[] }) {
  const [open, setOpen] = useState(false);
  // Bumped on every open so ProductFormDialog remounts with fresh action
  // state, instead of reusing a stale "success" from a previous submit.
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <>
      <Button
        onClick={() => {
          setInstanceKey((k) => k + 1);
          setOpen(true);
        }}
      >
        <Plus className="mr-2 size-4" />
        Thêm sản phẩm
      </Button>
      <ProductFormDialog key={instanceKey} open={open} onOpenChange={setOpen} suppliers={suppliers} />
    </>
  );
}
