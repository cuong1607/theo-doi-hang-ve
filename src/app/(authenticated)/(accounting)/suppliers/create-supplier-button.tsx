"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { SupplierFormDialog } from "./supplier-form-dialog";

export function CreateSupplierButton() {
  const [open, setOpen] = useState(false);
  // Bumped on every open so SupplierFormDialog remounts with fresh action
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
        Thêm NCC
      </Button>
      <SupplierFormDialog key={instanceKey} open={open} onOpenChange={setOpen} />
    </>
  );
}
