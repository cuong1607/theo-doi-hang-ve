"use client";

import { Unplug } from "lucide-react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";

import { disconnectShopAction } from "./actions";

export function DisconnectButton({ shopId, shopName }: { shopId: string; shopName: string }) {
  const { run, pending } = useAsyncAction({ refresh: true });
  return (
    <LoadingButton
      variant="destructive"
      loading={pending}
      icon={<Unplug aria-hidden="true" />}
      onClick={() => {
        if (!window.confirm(`Ngắt kết nối shop "${shopName}"? Token sẽ bị xoá; dữ liệu cũ vẫn giữ. Muốn dùng lại phải kết nối lại (ủy quyền Shopee).`)) return;
        void run(() => disconnectShopAction(shopId));
      }}
    >
      Ngắt kết nối
    </LoadingButton>
  );
}
