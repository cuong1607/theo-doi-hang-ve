"use client";

import { FlaskConical, Wand2 } from "lucide-react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";

import { autoMapShopeeProductsAction, createFixtureShopAction } from "./actions";

/** Database-only: exact-SKU auto-mapping of what product sync already stored (no Shopee call). */
export function AutoMapButton({ shopId }: { shopId: string }) {
  const { run, pending } = useAsyncAction({ errorMessage: "Không gửi được yêu cầu ghép SKU. Vui lòng thử lại." });
  return (
    <LoadingButton
      size="sm"
      variant="outline"
      loading={pending}
      loadingText="Đang ghép…"
      icon={<Wand2 />}
      title="Ghép SKU từ dữ liệu đã đồng bộ trong hệ thống — không gọi Shopee"
      onClick={() => run(() => autoMapShopeeProductsAction(shopId))}
    >
      Tự động ghép SKU
    </LoadingButton>
  );
}

export function CreateFixtureShopButton() {
  const { run, pending } = useAsyncAction({ errorMessage: "Không tạo được shop fixture." });
  return (
    <LoadingButton size="sm" variant="outline" loading={pending} loadingText="Đang tạo…" icon={<FlaskConical />} onClick={() => run(createFixtureShopAction)}>
      Tạo shop fixture (dev)
    </LoadingButton>
  );
}
