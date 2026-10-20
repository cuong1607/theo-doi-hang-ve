import { PageSkeleton } from "@/components/patterns/skeletons";

export default function Loading() {
  return <PageSkeleton metrics={6} rows={8} columns={10} label="Đang tải hàng hoàn đã giao…" />;
}
