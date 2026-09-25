// PHASE ZL5: sendDailyPaymentSummary() — the DAILY_PAYMENT_SUMMARY business
// event, built on ZL2's sendNotification(). Never bypasses it (no direct
// sendZaloTextMessage call here).
import "server-only";

import { buildDailyPaymentSummary, formatDailyPaymentSummaryMessage } from "./daily-payment-summary";
import { sendNotification, type SendNotificationResult } from "./service";

export type SendDailyPaymentSummaryResult =
  | { skipped: true; reason: "NO_PAYMENTS"; date: string }
  | { skipped: false; date: string; result: SendNotificationResult };

// "Nếu không có payment trong ngày: Không gửi." — no invented "hôm nay
// không có thanh toán" message, just a skipped result the caller can log or
// surface in the admin UI (same convention as ZL3's NO_RECEIPTS).
export async function sendDailyPaymentSummary(date: string): Promise<SendDailyPaymentSummaryResult> {
  const summary = await buildDailyPaymentSummary(date);

  if (summary.paymentCount === 0) {
    return { skipped: true, reason: "NO_PAYMENTS", date };
  }

  const message = formatDailyPaymentSummaryMessage(summary);

  const result = await sendNotification({
    eventType: "DAILY_PAYMENT_SUMMARY",
    message,
    entityType: "daily_payment_summary",
    entityId: date,
    dedupeKey: `DAILY_PAYMENT_SUMMARY:${date}`,
  });

  return { skipped: false, date, result };
}
