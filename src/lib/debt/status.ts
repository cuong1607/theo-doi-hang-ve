import type { PaymentStatus } from "./invoice-debt";

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Chưa thanh toán",
  partial: "Thanh toán một phần",
  paid: "Đã thanh toán",
};

export const PAYMENT_STATUS_BADGE_VARIANT: Record<PaymentStatus, "destructive" | "secondary" | "outline"> = {
  unpaid: "destructive",
  partial: "secondary",
  paid: "outline",
};
