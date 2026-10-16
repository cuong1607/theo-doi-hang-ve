import type { OutstandingStatus } from "./list";

export const STATUS_LABELS: Record<OutstandingStatus, string> = {
  need_makeup: "Cần xuất bù",
  complete: "Đã đủ",
  low: "Sắp hết",
  normal: "Bình thường",
};

// Colours: src/lib/ui/status.ts (UIUX-1).
