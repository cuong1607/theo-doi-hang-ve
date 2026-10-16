"use client";

import { Calculator } from "lucide-react";

import { LoadingButton } from "@/components/patterns/loading-button";
import { useAsyncAction } from "@/components/patterns/use-async-action";

import { backfillOrderCogsAction } from "./actions";

/** Database-only (no Shopee call): computes COGS for orders still missing it. */
export function BackfillCogsButton() {
  const { run, pending } = useAsyncAction({ errorMessage: "Không tính được COGS còn thiếu. Vui lòng thử lại.", refresh: true });
  return (
    <LoadingButton
      size="sm"
      variant="outline"
      loading={pending}
      loadingText="Đang tính COGS…"
      icon={<Calculator />}
      title="Tính giá vốn cho các đơn còn thiếu theo sổ giá vốn hiện tại — không gọi Shopee, không đổi COGS đã chốt"
      onClick={() => run(backfillOrderCogsAction)}
    >
      Tính COGS còn thiếu
    </LoadingButton>
  );
}
