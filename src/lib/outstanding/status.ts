import type { OutstandingStatus } from "./list";

export const STATUS_LABELS: Record<OutstandingStatus, string> = {
  need_makeup: "Cần xuất bù",
  low: "Sắp hết",
  normal: "Bình thường",
};

export const STATUS_BADGE_VARIANT: Record<OutstandingStatus, "destructive" | "secondary" | "outline"> = {
  need_makeup: "destructive",
  low: "secondary",
  normal: "outline",
};
