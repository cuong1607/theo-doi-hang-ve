// PHASE ZL5 — POST /api/notifications/daily-payment-summary: admin-only
// manual trigger ("Gửi báo cáo thanh toán hôm nay"), always uses "today" in
// Asia/Ho_Chi_Minh, mirrors /api/notifications/daily-receipt-summary (ZL3).
import { NextResponse } from "next/server";

import { canManageNotificationRecipients, getCurrentRole } from "@/lib/auth/role";
import { getTodayDateVN } from "@/lib/notifications/daily-payment-summary";
import { sendDailyPaymentSummary } from "@/lib/notifications/send-daily-payment-summary";

export const runtime = "nodejs";

export async function POST() {
  if (!canManageNotificationRecipients(getCurrentRole())) {
    return NextResponse.json({ success: false, errorMessage: "Bạn không có quyền thực hiện thao tác này." }, { status: 403 });
  }

  const date = getTodayDateVN();

  try {
    const outcome = await sendDailyPaymentSummary(date);
    return NextResponse.json({ success: true, ...outcome });
  } catch (err) {
    return NextResponse.json(
      { success: false, errorMessage: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
