import { PageSkeleton } from "@/components/patterns/skeletons";

export default function InventoryCostsLoading() {
  return <PageSkeleton rows={10} columns={7} label="Đang tải giá vốn…" />;
}
