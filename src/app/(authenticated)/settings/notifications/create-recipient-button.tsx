"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { RecipientFormDialog } from "./recipient-form-dialog";

export function CreateRecipientButton() {
  const [open, setOpen] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setInstanceKey((k) => k + 1);
          setOpen(true);
        }}
      >
        <Plus className="mr-2 size-4" />
        Thêm người nhận
      </Button>
      <RecipientFormDialog key={instanceKey} open={open} onOpenChange={setOpen} />
    </>
  );
}
