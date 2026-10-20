import { PageSkeleton } from "@/components/patterns/skeletons";

export default function Loading() {
  return <PageSkeleton metrics={6} filters={false} rows={5} columns={11} label="Đang tải tình trạng hệ thống…" />;
}
