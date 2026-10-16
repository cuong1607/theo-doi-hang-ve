"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/patterns/error-state";

export default function ProductsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <ErrorState title="Không tải được trang sản phẩm." retry={retry} reference={error.digest} />;
}
