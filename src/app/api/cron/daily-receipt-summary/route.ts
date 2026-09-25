// PHASE ZL6 — GET /api/cron/daily-receipt-summary: Vercel Cron entry point
// for the DAILY_RECEIPT_SUMMARY business event. Calls the SAME service the
// manual "Gửi báo cáo hàng về hôm nay" admin button uses (ZL3) — no
// calculation logic is duplicated here, this route is just auth + logging +
// picking "today in Vietnam" as the date.
import { NextResponse } from "next/server";

import { isAuthorizedCronSecret } from "@/lib/cron/auth";
import { getTodayDateVN } from "@/lib/notifications/daily-receipt-summary";
import { sendDailyReceiptSummary } from "@/lib/notifications/send-daily-receipt-summary";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isAuthorizedCronSecret(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = getTodayDateVN();
  console.log(`[cron:daily-receipt-summary] started date=${date}`);

  try {
    const outcome = await sendDailyReceiptSummary(date);

    if (outcome.skipped) {
      console.log(`[cron:daily-receipt-summary] completed date=${date} skipped reason=${outcome.reason}`);
    } else {
      const { totalRecipients, sentCount, failedCount, skippedCount } = outcome.result;
      console.log(
        `[cron:daily-receipt-summary] completed date=${date} totalRecipients=${totalRecipients} sent=${sentCount} failed=${failedCount} skipped=${skippedCount}`
      );
    }

    return NextResponse.json({ success: true, ...outcome });
  } catch (err) {
    console.error(`[cron:daily-receipt-summary] FAILED date=${date}:`, err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, errorMessage: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
