import type { OutstandingStatus } from "./list";

export const STATUS_LABELS: Record<OutstandingStatus, string> = {
  need_makeup: "Cần xuất bù",
  complete: "Đã đủ",
  low: "Sắp hết",
  normal: "Bình thường",
};

export const STATUS_BADGE_VARIANT: Record<OutstandingStatus, "destructive" | "secondary" | "outline" | "default"> = {
  need_makeup: "destructive",
  complete: "default",
  low: "secondary",
  normal: "outline",
};
