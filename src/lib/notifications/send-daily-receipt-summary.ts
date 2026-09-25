// PHASE ZL3: the first real business event built on top of ZL2's
// sendNotification() — DAILY_RECEIPT_SUMMARY. Never bypasses the shared
// notification service (no direct sendZaloTextMessage call here), so dedupe
// and per-recipient logging stay centralized.
import "server-only";

import { buildDailyReceiptSummary, formatDailyReceiptSummaryMessage } from "./daily-receipt-summary";
import { sendNotification, type SendNotificationResult } from "./service";

export type SendDailyReceiptSummaryResult =
  | { skipped: true; reason: "NO_RECEIPTS"; date: string }
  | { skipped: false; date: string; result: SendNotificationResult };

// "Nếu trong ngày không có receipt: ưu tiên KHÔNG gửi notification" — no
// "hôm nay không có hàng về" spam, just a skipped result the caller can log
// or surface in the admin UI.
export async function sendDailyReceiptSummary(date: string): Promise<SendDailyReceiptSummaryResult> {
  const summary = await buildDailyReceiptSummary(date);

  if (summary.receiptCount === 0) {
    return { skipped: true, reason: "NO_RECEIPTS", date };
  }

  const message = formatDailyReceiptSummaryMessage(summary);

  const result = await sendNotification({
    eventType: "DAILY_RECEIPT_SUMMARY",
    message,
    entityType: "daily_receipt_summary",
    entityId: date,
    // One summary per recipient per day, max — see migration 00029's
    // partial unique index on (event_type, recipient_id, dedupe_key).
    dedupeKey: `DAILY_RECEIPT_SUMMARY:${date}`,
  });

  return { skipped: false, date, result };
}
