// PHASE ZL3 — POST /api/notifications/daily-receipt-summary: admin-only
// manual trigger ("Gửi báo cáo hàng về hôm nay") to test the
// DAILY_RECEIPT_SUMMARY event before a cron exists (Phase này không tạo
// cron). Always uses "today" in Asia/Ho_Chi_Minh — not an arbitrary date —
// same as the button's label promises.
import { NextResponse } from "next/server";

import { authorizeRoute } from "@/lib/auth/session";
import { getTodayDateVN } from "@/lib/notifications/daily-receipt-summary";
import { sendDailyReceiptSummary } from "@/lib/notifications/send-daily-receipt-summary";

export const runtime = "nodejs";

export async function POST() {
  const authz = await authorizeRoute("notification:manage");
  if (!authz.ok) return authz.response;

  const date = getTodayDateVN();

  try {
    const outcome = await sendDailyReceiptSummary(date);
    return NextResponse.json({ success: true, ...outcome });
  } catch (err) {
    return NextResponse.json(
      { success: false, errorMessage: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
