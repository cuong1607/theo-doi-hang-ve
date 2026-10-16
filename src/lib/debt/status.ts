import type { PaymentStatus } from "./invoice-debt";

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Chưa thanh toán",
  partial: "Thanh toán một phần",
  paid: "Đã thanh toán",
};

// Colours: src/lib/ui/status.ts (UIUX-1).
