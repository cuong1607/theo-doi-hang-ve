"use client";

import { useRouter } from "next/navigation";

import { ErrorState } from "@/components/patterns/error-state";

export function SectionRetry() {
  const router = useRouter();
  return <ErrorState className="py-8" title="Không tải được phần này." description="Các phần khác của trang vẫn dùng được. Thử tải lại phần này." retry={() => router.refresh()} />;
}
